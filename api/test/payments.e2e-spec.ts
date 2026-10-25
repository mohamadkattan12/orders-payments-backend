import type { INestApplication } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { FixedClock } from '../src/common/clock.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp, eventually, fakes, resetData } from './support/app.js';

const customer = { name: 'Sara', phone: '+966512345678', city: 'Riyadh' };
const ADMIN = { 'X-Admin-Key': 'dev-admin-key' };
const MIN = 60_000;

describe('payments (e2e, real fakes)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  const clock = new FixedClock(new Date());

  const http = () => request(app.getHttpServer());
  const mode = (system: string, body: object) =>
    fakes(`/control/${system}`, { method: 'POST', body: JSON.stringify(body) });
  const checkout = async (sku = 'SAFFRON-5G', qty = 1) =>
    (
      await http()
        .post('/orders')
        .set('Idempotency-Key', randomUUID())
        .send({ customer, items: [{ sku, qty }] })
        .expect(201)
    ).body as { id: string; totalHalalas: number };
  const pay = (
    orderId: string,
    token = 'tok_success',
    key: string = randomUUID(),
  ) =>
    http()
      .post(`/orders/${orderId}/pay`)
      .set('Idempotency-Key', key)
      .send({ token });
  const order = async (id: string) =>
    (await http().get(`/orders/${id}`).expect(200)).body;
  const ledger = async () => (await fakes('/control/fakepay/ledger')).json();
  const stock = async (sku: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { sku } })).stock;
  const events = async (orderId: string) =>
    (
      await prisma.outboxEvent.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => e.type);
  const later = (ms: number) => clock.set(new Date(Date.now() + ms));

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp({ listen: true, clock }));
    payments = app.get(PaymentsService);
  });

  beforeEach(async () => {
    clock.set(new Date());
    await resetData(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it('pay → 202 pending → webhook → paid, with order.paid recorded once', async () => {
    const { id } = await checkout();
    const res = await pay(id).expect(202);
    expect(res.body).toMatchObject({ status: 'pending', amountHalalas: 3999 });
    await eventually(async () => expect((await order(id)).status).toBe('paid'));
    expect((await order(id)).payments).toMatchObject([{ status: 'succeeded' }]);
    expect(await events(id)).toEqual(['order.created', 'order.paid']);
    expect((await ledger()).charges).toHaveLength(1);
  });

  it('a decline leaves the order payable; a retry with a new key pays it', async () => {
    const { id } = await checkout();
    await pay(id, 'tok_decline').expect(202);
    await eventually(async () =>
      expect((await order(id)).payments[0].status).toBe('failed'),
    );
    expect((await order(id)).status).toBe('pending_payment');
    await pay(id).expect(202);
    await eventually(async () => expect((await order(id)).status).toBe('paid'));
  });

  it('a repeated pay key replays; a second payment while one is active is refused', async () => {
    const { id } = await checkout();
    const key = randomUUID();
    const first = await pay(id, 'tok_success', key).expect(202);
    const again = await pay(id, 'tok_success', key).expect(202);
    expect(again.body).toEqual(first.body);
    expect((await pay(id).expect(409)).body.error).toBe('payment_in_progress');
    await eventually(async () => expect((await order(id)).status).toBe('paid'));
    expect((await pay(id).expect(409)).body.error).toBe('order_not_payable');
    expect((await ledger()).charges).toHaveLength(1);
  });

  it('duplicate webhooks pay once', async () => {
    await mode('fakepay', { mode: 'duplicate' });
    const { id } = await checkout();
    await pay(id).expect(202);
    await eventually(async () =>
      expect(
        (await ledger()).webhooks.every((w: { sentAt: string }) => w.sentAt),
      ).toBe(true),
    );
    await eventually(async () => expect((await order(id)).status).toBe('paid'));
    expect(await events(id)).toEqual(['order.created', 'order.paid']);
    expect(await prisma.inboundWebhook.count()).toBe(1);
  });

  it('a lost webhook is settled by reconciliation after 2 minutes', async () => {
    await mode('fakepay', { mode: 'webhook_lost' });
    const { id } = await checkout();
    await pay(id).expect(202);
    await new Promise((r) => setTimeout(r, 400));
    expect((await order(id)).status).toBe('pending_payment');
    expect(await payments.reconcilePayments()).toBe(0); // too early
    later(3 * MIN);
    expect(await payments.reconcilePayments()).toBe(1);
    expect((await order(id)).status).toBe('paid');
    expect(await payments.reconcilePayments()).toBe(0); // nothing left
  });

  it('a lost response leaves the payment pending; the webhook or reconciliation settles it', async () => {
    await mode('fakepay', { mode: 'response_lost' });
    const { id } = await checkout();
    await pay(id).expect(202); // FakePay charged, but its answer never arrived
    await eventually(async () => expect((await order(id)).status).toBe('paid'));
    expect((await ledger()).charges).toHaveLength(1);
  });

  it('FakePay down at pay time: reconciliation resubmits with the same key, charging once', async () => {
    await mode('fakepay', { mode: 'down' });
    const { id } = await checkout();
    await pay(id).expect(202);
    expect((await order(id)).payments[0].status).toBe('pending');
    await mode('fakepay', { mode: 'ok' });
    later(3 * MIN);
    await payments.reconcilePayments(); // 404 at FakePay → resubmit
    await eventually(async () => expect((await order(id)).status).toBe('paid'));
    await payments.reconcilePayments();
    expect((await ledger()).charges).toHaveLength(1);
  });

  it('a success after expiry is refunded automatically; the order stays expired', async () => {
    await mode('fakepay', { mode: 'webhook_lost' });
    const { id } = await checkout('HONEY-SIDR-500G', 2);
    await pay(id).expect(202);
    expect(await stock('HONEY-SIDR-500G')).toBe(0);
    later(16 * MIN); // past the 15-minute hold and the in-flight window
    expect(await payments.expireDue()).toBe(1);
    expect(await stock('HONEY-SIDR-500G')).toBe(2); // released
    await mode('fakepay', { mode: 'ok' });
    await payments.reconcilePayments(); // the charge succeeded after all
    const o = await order(id);
    expect(o.status).toBe('expired');
    expect(o.payments[0]).toMatchObject({
      status: 'succeeded',
      refund: { status: 'pending', reason: 'order_not_payable' },
    });
    await payments.processRefunds(); // FakePay never saw it → submit
    await eventually(async () =>
      expect((await order(id)).payments[0]).toMatchObject({
        status: 'refunded',
        refund: { status: 'succeeded' },
      }),
    );
    expect((await order(id)).status).toBe('expired');
    expect(await events(id)).toEqual(['order.created', 'order.expired']);
    expect((await ledger()).refunds).toHaveLength(1);
  });

  it('settle vs expiry racing: exactly one wins, every round, and both orders happen', async () => {
    await mode('fakepay', { mode: 'webhook_lost' });
    const winners = new Set<string>();
    for (let round = 0; round < 20; round++) {
      clock.set(new Date());
      const { id } = await checkout('DATES-SUKKARI-1KG', 1);
      const p = (await pay(id).expect(202)).body as { id: string };
      const charge = (await ledger()).charges.find(
        (c: { merchantReference: string }) => c.merchantReference === p.id,
      );
      later(16 * MIN);
      // Race the two transactions themselves (reconciliation's HTTP lookup would always lose).
      const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 4));
      await Promise.all([
        jitter().then(() => payments.expireDue()),
        jitter().then(() =>
          prisma.$transaction((tx) =>
            payments.settlePayment(tx, {
              paymentId: p.id,
              providerPaymentId: charge.id,
              status: 'succeeded',
              amountHalalas: charge.amountHalalas,
            }),
          ),
        ),
      ]);
      const o = await order(id);
      winners.add(o.status);
      if (o.status === 'paid') {
        expect(o.payments[0].refund).toBeNull();
        expect(await events(id)).toEqual(['order.created', 'order.paid']);
      } else {
        expect(o.status).toBe('expired');
        expect(o.payments[0].refund).toMatchObject({
          reason: 'order_not_payable',
        });
        expect(await events(id)).toEqual(['order.created', 'order.expired']);
      }
    }
    expect(winners).toEqual(new Set(['paid', 'expired'])); // the race really went both ways
    // stock: every expired order gave its unit back, every paid one kept it
    const paid = await prisma.order.count({ where: { status: 'paid' } });
    expect(await stock('DATES-SUKKARI-1KG')).toBe(200 - paid);
  });

  it('cancel: refused while a payment is in flight, allowed after a decline; releases stock', async () => {
    await mode('fakepay', { mode: 'webhook_lost' });
    const { id } = await checkout('OUD-OIL-12ML', 2);
    await pay(id).expect(202);
    const cancel = (key: string = randomUUID()) =>
      http().post(`/orders/${id}/cancel`).set('Idempotency-Key', key);
    expect((await cancel().expect(409)).body.error).toBe('payment_in_progress');
    await mode('fakepay', { mode: 'ok' });
    const second = await checkout('OUD-OIL-12ML', 1);
    await pay(second.id, 'tok_decline').expect(202);
    await eventually(async () =>
      expect((await order(second.id)).payments[0].status).toBe('failed'),
    );
    const res = await http()
      .post(`/orders/${second.id}/cancel`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    expect(res.body.status).toBe('cancelled');
    expect(await stock('OUD-OIL-12ML')).toBe(5 - 2); // only the first order still holds stock
    expect(await events(second.id)).toEqual([
      'order.created',
      'order.cancelled',
    ]);
  });

  it('webhooks: bad or old signatures are 401 and not stored; unknown or wrong amounts are 422 and recorded', async () => {
    const send = (
      body: object,
      t = Math.floor(Date.now() / 1000),
      secret = 'dev-fakepay-secret',
    ) => {
      const raw = JSON.stringify(body);
      const v1 = createHmac('sha256', secret)
        .update(`${t}.${raw}`)
        .digest('hex');
      return http()
        .post('/webhooks/fakepay')
        .set('FakePay-Signature', `t=${t},v1=${v1}`)
        .set('Content-Type', 'application/json')
        .send(raw);
    };
    const event = (data: object) => ({
      id: `evt_${randomUUID()}`,
      type: 'payment.succeeded',
      data,
    });
    await send(event({}), undefined, 'wrong-secret').expect(401);
    await send(event({}), Math.floor(Date.now() / 1000) - 600).expect(401);
    expect(await prisma.inboundWebhook.count()).toBe(0);

    await send(event({ id: 'pay_x' })).expect(400); // malformed
    const unknown = event({
      id: 'pay_x',
      merchantReference: randomUUID(),
      amountHalalas: 100,
      currency: 'SAR',
    });
    expect((await send(unknown).expect(422)).body.error).toBe(
      'unknown_payment',
    );
    await send(unknown).expect(422); // the duplicate gets the same answer
    expect(
      (
        await send(
          event({
            id: 'pay_x',
            merchantReference: 'not-a-uuid',
            amountHalalas: 100,
          }),
        ).expect(422)
      ).body.error,
    ).toBe('unknown_payment');

    await mode('fakepay', { mode: 'webhook_lost' });
    const { id } = await checkout();
    const p = (await pay(id).expect(202)).body;
    const wrong = event({
      id: 'pay_y',
      merchantReference: p.id,
      amountHalalas: 1,
      currency: 'SAR',
    });
    expect((await send(wrong).expect(422)).body.error).toBe('amount_mismatch');
    expect((await order(id)).status).toBe('pending_payment');
    expect(
      await prisma.inboundWebhook.count({ where: { status: 'rejected' } }),
    ).toBe(3);
  });

  it('admin refund: needs the key, refunds once, records order.refunded', async () => {
    const { id } = await checkout();
    await pay(id).expect(202);
    await eventually(async () => expect((await order(id)).status).toBe('paid'));
    const refund = (key: string = randomUUID()) =>
      http().post(`/admin/orders/${id}/refund`).set('Idempotency-Key', key);
    await refund().expect(401);
    const key = randomUUID();
    const first = await refund(key).set(ADMIN).expect(202);
    expect((await refund(key).set(ADMIN).expect(202)).body).toEqual(first.body);
    expect((await refund().set(ADMIN).expect(409)).body.error).toBe(
      'order_not_refundable',
    );
    await eventually(async () =>
      expect((await order(id)).status).toBe('refunded'),
    );
    expect(await events(id)).toEqual([
      'order.created',
      'order.paid',
      'order.refunded',
    ]);
    expect((await ledger()).refunds).toHaveLength(1);
  });

  it('out-of-order webhooks: a refund arriving before the payment still ends refunded, once', async () => {
    await mode('fakepay', { mode: 'out_of_order' }); // hold every webhook until flushed
    const { id } = await checkout();
    await pay(id).expect(202);
    later(3 * MIN);
    await payments.reconcilePayments(); // paid via lookup while the webhook is held
    expect((await order(id)).status).toBe('paid');
    await http()
      .post(`/admin/orders/${id}/refund`)
      .set(ADMIN)
      .set('Idempotency-Key', randomUUID())
      .expect(202);
    await fakes('/control/fakepay/flush', { method: 'POST' }); // refund.succeeded first, then payment.succeeded
    await eventually(async () =>
      expect(
        (await ledger()).webhooks.every((w: { sentAt: string }) => w.sentAt),
      ).toBe(true),
    );
    await eventually(async () =>
      expect((await order(id)).status).toBe('refunded'),
    );
    expect((await order(id)).payments).toMatchObject([
      { status: 'refunded', refund: { status: 'succeeded' } },
    ]);
    expect(await events(id)).toEqual([
      'order.created',
      'order.paid',
      'order.refunded',
    ]);
  });
});
