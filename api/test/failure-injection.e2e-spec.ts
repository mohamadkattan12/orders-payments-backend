import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { FixedClock } from '../src/common/clock.js';
import { DeliveryService } from '../src/outbox/delivery.service.js';
import { DeliveryWorker } from '../src/outbox/delivery.worker.js';
import { Dispatcher } from '../src/outbox/dispatcher.js';
import { RelayService } from '../src/outbox/relay.service.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { createTestApp, eventually, fakes, resetData } from './support/app.js';

/**
 * Spec req 18 + amendment 14, end to end: the HTTP app, the worker (relay + delivery consumer) and
 * the real fakes, with failures injected through the fakes' modes. Every scenario asserts durable
 * state and what each external system actually did (its ledger). Scenarios covered elsewhere:
 * parallel checkouts and same-key races (checkout), settle vs expiry (payments), refund ordering
 * behind a dead sale (delivery), webhook signature and validation rules (each destination's file).
 */
const customer = { name: 'Sara', phone: '+966512345678', city: 'Riyadh' };
const ADMIN = { 'X-Admin-Key': 'dev-admin-key' };
const MIN = 60_000;

type Ledgers = {
  charges: { status: string }[];
  refunds: unknown[];
  erp: { kind: string }[];
  shipments: unknown[];
  invoices: { kind: string }[];
};

describe('failure injection (e2e, real fakes and worker)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let relay: RelayService;
  let relayTimer: NodeJS.Timeout | undefined;
  const clock = new FixedClock(new Date());

  const http = () => request(app.getHttpServer());
  const mode = (system: string, body: object) =>
    fakes(`/control/${system}`, { method: 'POST', body: JSON.stringify(body) });
  const ledger = async (system: string) =>
    (await fakes(`/control/${system}/ledger`)).json();
  const ledgers = async (): Promise<Ledgers> => {
    const [pay, erp, courier, portal] = await Promise.all(
      ['fakepay', 'erp', 'courier', 'einvoice'].map(ledger),
    );
    return {
      charges: pay.charges,
      refunds: pay.refunds,
      erp: erp.records,
      shipments: courier.shipments,
      invoices: portal.invoices,
    };
  };
  const startRelay = () => {
    relayTimer ??= setInterval(
      () => void relay.relayOnce().catch(() => {}),
      100,
    );
  };
  const stopRelay = () => {
    clearInterval(relayTimer);
    relayTimer = undefined;
  };
  const later = (ms: number) => clock.set(new Date(Date.now() + ms));

  const checkout = async (sku = 'SAFFRON-5G', qty = 1) =>
    (
      (
        await http()
          .post('/orders')
          .set('Idempotency-Key', randomUUID())
          .send({ customer, items: [{ sku, qty }] })
          .expect(201)
      ).body as { id: string }
    ).id;
  const pay = (id: string, token = 'tok_success') =>
    http()
      .post(`/orders/${id}/pay`)
      .set('Idempotency-Key', randomUUID())
      .send({ token });
  const status = async (id: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id } })).status;
  const paidOrder = async () => {
    const id = await checkout();
    await pay(id).expect(202);
    await eventually(async () => expect(await status(id)).toBe('paid'));
    return id;
  };
  const deliveries = (orderId: string) =>
    prisma.delivery.findMany({ where: { orderId } });
  /** Every delivery of the order delivered, then nothing more happens for a moment. */
  const allDelivered = async (orderId: string, count: number) => {
    await eventually(async () => {
      const rows = await deliveries(orderId);
      expect(rows.map((d) => d.status)).toEqual(Array(count).fill('delivered'));
    });
    await new Promise((r) => setTimeout(r, 300)); // late duplicates would land here
  };
  /** Each system did its job exactly once for one sale. */
  const expectOneSale = async () => {
    const l = await ledgers();
    expect(l.charges.filter((c) => c.status === 'succeeded')).toHaveLength(1);
    expect(l.erp.map((r) => r.kind)).toEqual(['sale']);
    expect(l.shipments).toHaveLength(1);
    expect(l.invoices.map((i) => i.kind)).toEqual(['invoice']);
    expect(await prisma.shipment.count()).toBe(1);
    expect(await prisma.invoice.count()).toBe(1);
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp({ listen: true, clock }));
    payments = app.get(PaymentsService);
    worker = await (
      await Test.createTestingModule({ imports: [WorkerModule] }).compile()
    ).init();
    relay = worker.get(RelayService);
    worker.get(DeliveryWorker).start();
  });

  beforeEach(async () => {
    stopRelay();
    await worker.get(Dispatcher).queue.obliterate({ force: true });
    clock.set(new Date());
    await resetData(prisma);
    startRelay();
  });

  afterEach(async () => {
    // The CHECK constraint makes negative stock impossible; assert it anyway after every scenario.
    expect(await prisma.product.count({ where: { stock: { lt: 0 } } })).toBe(0);
  });

  afterAll(async () => {
    stopRelay();
    await worker.close();
    await app.close();
  });

  it('baseline: a paid order reaches ERP, courier and invoicing exactly once', async () => {
    const id = await paidOrder();
    await allDelivered(id, 3);
    await expectOneSale();
  });

  it('FakePay sends every webhook twice: paid once, each system hears once', async () => {
    await mode('fakepay', { mode: 'duplicate' });
    const id = await paidOrder();
    await eventually(async () =>
      expect(
        (await ledger('fakepay')).webhooks.filter(
          (w: { sentAt: string | null }) => w.sentAt,
        ),
      ).toHaveLength(2),
    );
    await allDelivered(id, 3);
    expect(
      await prisma.outboxEvent.count({ where: { type: 'order.paid' } }),
    ).toBe(1);
    await expectOneSale();
  });

  it('FakePay loses the webhook: reconciliation pays it, each system hears once', async () => {
    await mode('fakepay', { mode: 'webhook_lost' });
    const id = await checkout();
    await pay(id).expect(202);
    await new Promise((r) => setTimeout(r, 400));
    expect(await status(id)).toBe('pending_payment');
    later(3 * MIN);
    expect(await payments.reconcilePayments()).toBe(1);
    expect(await status(id)).toBe('paid');
    await allDelivered(id, 3);
    await expectOneSale();
  });

  it('FakePay loses its response: the webhook settles it, charged once', async () => {
    await mode('fakepay', { mode: 'response_lost' });
    const id = await checkout();
    await pay(id).expect(202);
    await eventually(async () => expect(await status(id)).toBe('paid'));
    await allDelivered(id, 3);
    await expectOneSale();
  });

  it('a success after expiry is refunded automatically and no system hears of a sale', async () => {
    await mode('fakepay', { mode: 'webhook_lost' });
    const id = await checkout();
    await pay(id).expect(202);
    later(16 * MIN);
    expect(await payments.expireDue()).toBe(1);
    await mode('fakepay', { mode: 'ok' });
    await payments.reconcilePayments(); // the charge succeeded after all
    await payments.processRefunds();
    await eventually(async () =>
      expect((await ledger('fakepay')).refunds).toHaveLength(1),
    );
    await eventually(async () =>
      expect(
        (await prisma.payment.findFirstOrThrow({ where: { orderId: id } }))
          .status,
      ).toBe('refunded'),
    );
    expect(await status(id)).toBe('expired');
    await new Promise((r) => setTimeout(r, 300));
    const l = await ledgers();
    expect([l.erp, l.shipments, l.invoices]).toEqual([[], [], []]);
    expect(await deliveries(id)).toEqual([]);
  });

  it('FakePay webhooks out of order on a paid-then-refunded order: one sale, one refund, one credit note', async () => {
    await mode('fakepay', { mode: 'out_of_order' }); // hold every webhook until flushed
    const id = await checkout();
    await pay(id).expect(202);
    later(3 * MIN);
    await payments.reconcilePayments(); // paid by lookup while the webhook is held
    await http()
      .post(`/admin/orders/${id}/refund`)
      .set(ADMIN)
      .set('Idempotency-Key', randomUUID())
      .expect(202);
    await fakes('/control/fakepay/flush', { method: 'POST' }); // refund.succeeded first
    await eventually(async () => expect(await status(id)).toBe('refunded'));
    await allDelivered(id, 5); // order.paid ×3, order.refunded ×2 (ERP, invoicing)
    const l = await ledgers();
    expect(l.charges).toHaveLength(1);
    expect(l.refunds).toHaveLength(1);
    expect(l.erp.map((r) => r.kind)).toEqual(['sale', 'refund']);
    expect(l.invoices.map((i) => i.kind)).toEqual(['invoice', 'credit_note']);
    expect(l.shipments).toHaveLength(1);
  });

  it('ERP down, then back: the sale is retried and booked once', async () => {
    await mode('erp', { mode: 'down' });
    const id = await paidOrder();
    await eventually(async () => {
      const erp = (await deliveries(id)).find((d) => d.destination === 'erp')!;
      expect(erp.attempts).toBeGreaterThan(1);
    });
    await mode('erp', { mode: 'ok' });
    await allDelivered(id, 3);
    await expectOneSale();
  });

  it('ERP down past every attempt: dead, replayed after recovery, booked once', async () => {
    await mode('erp', { mode: 'down' });
    const id = await paidOrder();
    const dead = await eventually(async () => {
      const erp = (await deliveries(id)).find((d) => d.destination === 'erp')!;
      expect(erp.status).toBe('dead');
      return erp;
    });
    expect(dead.attempts).toBe(8);
    expect((await ledger('erp')).records).toHaveLength(0);
    await mode('erp', { mode: 'ok' });
    await http()
      .post(`/admin/deliveries/${dead.id}/replay`)
      .set(ADMIN)
      .expect(202);
    await allDelivered(id, 3);
    await expectOneSale();
  });

  it('the relay crashes right after committing: the sweeper delivers everything once', async () => {
    stopRelay();
    const id = await paidOrder();
    await relay.relayOnce({ enqueue: false }); // committed, then "crashed" before enqueueing
    await new Promise((r) => setTimeout(r, 300));
    expect(
      (await deliveries(id)).filter((d) => d.status === 'delivered'),
    ).toHaveLength(0);
    await prisma.delivery.updateMany({
      data: { nextAttemptAt: new Date(Date.now() - 2 * MIN) },
    });
    await worker.get(DeliveryService).sweep();
    await allDelivered(id, 3);
    await expectOneSale();
  });

  it('the relay publishes twice and every job is enqueued again: one effect per system', async () => {
    stopRelay();
    const id = await paidOrder();
    await Promise.all([relay.relayOnce(), relay.relayOnce()]);
    // As if the publish mark were lost: the same events are relayed again.
    await prisma.outboxEvent.updateMany({
      where: { orderId: id },
      data: { publishedAt: null },
    });
    await relay.relayOnce();
    expect(await deliveries(id)).toHaveLength(3);
    const dispatcher = worker.get(Dispatcher);
    for (const d of await deliveries(id))
      await Promise.all(
        [1, 2, 3].map((i) => dispatcher.enqueue(d.id, `again${i}`)),
      );
    await allDelivered(id, 3);
    await expectOneSale();
  });

  it('Redis loses every queued job: the sweeper re-enqueues from Postgres, delivered once', async () => {
    stopRelay();
    const id = await paidOrder();
    await worker.get(DeliveryWorker).stop();
    await relay.relayOnce();
    await worker.get(Dispatcher).queue.obliterate({ force: true });
    worker.get(DeliveryWorker).start();
    await prisma.delivery.updateMany({
      data: { nextAttemptAt: new Date(Date.now() - 2 * MIN) },
    });
    await worker.get(DeliveryService).sweep();
    await allDelivered(id, 3);
    await expectOneSale();
  });

  it('courier tracking duplicated, then out of order: ends delivered and never moves back', async () => {
    const shipment = async (id: string) =>
      prisma.shipment.findUniqueOrThrow({ where: { orderId: id } });
    const advance = (courierId: string, to: string) =>
      fakes(`/control/courier/shipments/${courierId}/advance`, {
        method: 'POST',
        body: JSON.stringify({ to }),
      });
    const allSent = () =>
      eventually(async () =>
        expect(
          (await ledger('courier')).webhooks.every(
            (w: { sentAt: string | null }) => w.sentAt,
          ),
        ).toBe(true),
      );

    await mode('courier', { mode: 'duplicate' });
    const a = await paidOrder();
    await allDelivered(a, 3);
    await advance((await shipment(a)).courierShipmentId, 'in_transit');
    await allSent();
    expect(await shipment(a)).toMatchObject({
      status: 'in_transit',
      statusSeq: 3,
    });

    await resetData(prisma);
    await mode('courier', { mode: 'out_of_order' });
    const b = await paidOrder();
    await allDelivered(b, 3);
    await advance((await shipment(b)).courierShipmentId, 'delivered');
    await fakes('/control/courier/flush', { method: 'POST' }); // delivered first, created last
    await allSent();
    expect(await shipment(b)).toMatchObject({
      status: 'delivered',
      statusSeq: 4,
    });
    await expectOneSale();
  });

  it('e-invoicing portal flaky: one invoice, one number, cleared once', async () => {
    await mode('einvoice', { mode: 'flaky', failCount: 3 });
    const id = await paidOrder();
    await allDelivered(id, 3);
    const invoice = await prisma.invoice.findFirstOrThrow({
      where: { orderId: id },
    });
    expect(invoice.clearanceId).toBeTruthy();
    await expectOneSale();
  });

  it('ERP stock webhooks duplicated: each adjustment applied once', async () => {
    await mode('erp', { mode: 'duplicate' });
    const before = (
      await prisma.product.findUniqueOrThrow({ where: { sku: 'SAFFRON-5G' } })
    ).stock;
    await fakes('/control/erp/adjust', {
      method: 'POST',
      body: JSON.stringify({ sku: 'SAFFRON-5G', delta: 5 }),
    });
    await eventually(async () =>
      expect(
        (await ledger('erp')).webhooks.filter(
          (w: { sentAt: string | null }) => w.sentAt,
        ),
      ).toHaveLength(2),
    );
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { sku: 'SAFFRON-5G' } }))
        .stock,
    ).toBe(before + 5);
    expect(await prisma.stockAdjustment.count()).toBe(1);
  });

  it('cancel vs pay racing: never a cancelled order holding a charge that is not refunded', async () => {
    for (let round = 0; round < 20; round++) {
      const id = await checkout();
      await Promise.all([
        pay(id),
        http()
          .post(`/orders/${id}/cancel`)
          .set('Idempotency-Key', randomUUID()),
      ]);
      await eventually(async () =>
        expect(
          await prisma.payment.count({
            where: { orderId: id, status: 'pending' },
          }),
        ).toBe(0),
      );
      const s = await status(id);
      if (s === 'cancelled')
        expect(
          await prisma.payment.count({
            where: { orderId: id, status: 'succeeded' },
          }),
        ).toBe(0);
      else expect(s).toBe('paid');
    }
  });
});
