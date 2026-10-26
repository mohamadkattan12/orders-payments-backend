import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { ErpHandler } from '../src/destinations/erp/erp.handler.js';
import { DeliveryWorker } from '../src/outbox/delivery.worker.js';
import { Dispatcher } from '../src/outbox/dispatcher.js';
import { RelayService } from '../src/outbox/relay.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { createTestApp, eventually, fakes, resetData } from './support/app.js';

const customer = { name: 'Sara', phone: '+966512345678', city: 'Riyadh' };
const ADMIN = { 'X-Admin-Key': 'dev-admin-key' };

interface ErpLedger {
  records: { id: string; kind: string; orderId: string; payload: unknown }[];
  webhooks: { eventId: string; sentAt: string | null }[];
}

describe('ERP destination (e2e, real fakes)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: INestApplicationContext;
  let relayTimer: NodeJS.Timeout | undefined;

  const http = () => request(app.getHttpServer());
  const mode = (body: object) =>
    fakes('/control/erp', { method: 'POST', body: JSON.stringify(body) });
  const ledger = async () =>
    (await (await fakes('/control/erp/ledger')).json()) as ErpLedger;
  const stock = async (sku: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { sku } })).stock;
  const erpDeliveries = (orderId: string) =>
    prisma.delivery.findMany({
      where: { orderId, destination: 'erp' },
      orderBy: { createdAt: 'asc' },
    });
  const orderStatus = async (id: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id } })).status;

  const checkout = async (sku = 'SAFFRON-5G', qty = 1) =>
    (
      await http()
        .post('/orders')
        .set('Idempotency-Key', randomUUID())
        .send({ customer, items: [{ sku, qty }] })
        .expect(201)
    ).body as { id: string; totalHalalas: number };
  const paidOrder = async (sku?: string, qty?: number) => {
    const order = await checkout(sku, qty);
    await http()
      .post(`/orders/${order.id}/pay`)
      .set('Idempotency-Key', randomUUID())
      .send({ token: 'tok_success' })
      .expect(202);
    await eventually(async () =>
      expect(await orderStatus(order.id)).toBe('paid'),
    );
    return order;
  };

  /** A stock.adjusted webhook signed like the ERP signs it (or with another secret). */
  const sendStock = (
    data: object,
    { id = `evt_${randomUUID()}`, secret = 'dev-erp-secret' } = {},
  ) => {
    const raw = JSON.stringify({ id, type: 'stock.adjusted', data });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    return http()
      .post('/webhooks/erp')
      .set('ERP-Signature', `t=${t},v1=${v1}`)
      .set('Content-Type', 'application/json')
      .send(raw);
  };
  const adjust = async (sku: string, delta: number) =>
    (
      (await (
        await fakes('/control/erp/adjust', {
          method: 'POST',
          body: JSON.stringify({ sku, delta }),
        })
      ).json()) as { eventId: string }
    ).eventId;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp({ listen: true }));
    worker = await (
      await Test.createTestingModule({ imports: [WorkerModule] }).compile()
    ).init();
  });

  beforeEach(async () => {
    await worker.get(DeliveryWorker).stop();
    await worker.get(Dispatcher).queue.obliterate({ force: true });
    await resetData(prisma);
    // The worker process's relay loop, so order.paid/refunded reach the delivery engine.
    const relay = worker.get(RelayService);
    relayTimer = setInterval(() => void relay.relayOnce().catch(() => {}), 50);
    worker.get(DeliveryWorker).start();
  });

  afterEach(() => clearInterval(relayTimer));

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  it('a paid order books one sale receipt, a refund one refund receipt; repeats book nothing', async () => {
    const order = await paidOrder('SAFFRON-5G', 2);
    await eventually(async () =>
      expect((await erpDeliveries(order.id))[0]?.status).toBe('delivered'),
    );
    let { records } = await ledger();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'sale',
      orderId: order.id,
      payload: {
        kind: 'sale',
        orderId: order.id,
        totalHalalas: order.totalHalalas,
        lines: [{ sku: 'SAFFRON-5G', qty: 2 }],
      },
    });
    const [sale] = await erpDeliveries(order.id);
    expect(sale).toMatchObject({ attempts: 1, externalRef: records[0].id });

    // A repeated call (e.g. a lease that expired mid-call) sends the same key: no second receipt.
    const event = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: sale.eventId },
    });
    expect(await worker.get(ErpHandler).deliver(sale, event.payload)).toEqual({
      externalRef: records[0].id,
    });
    expect((await ledger()).records).toHaveLength(1);

    await http()
      .post(`/admin/orders/${order.id}/refund`)
      .set('Idempotency-Key', randomUUID())
      .set(ADMIN)
      .expect(202);
    await eventually(async () =>
      expect((await erpDeliveries(order.id)).map((d) => d.status)).toEqual([
        'delivered',
        'delivered',
      ]),
    );
    ({ records } = await ledger());
    expect(records.map((r) => [r.kind, r.orderId])).toEqual([
      ['sale', order.id],
      ['refund', order.id],
    ]);
    expect(records[1].payload).toMatchObject({
      totalHalalas: order.totalHalalas,
      lines: [{ sku: 'SAFFRON-5G', qty: 2 }],
    });
    expect((await erpDeliveries(order.id))[1].externalRef).toBe(records[1].id);
  });

  it('a flaky ERP (fails 3 times) gets the sale on attempt 4, booked once', async () => {
    await mode({ mode: 'flaky', failCount: 3 });
    const order = await paidOrder();
    await eventually(async () =>
      expect((await erpDeliveries(order.id))[0]?.status).toBe('delivered'),
    );
    const [sale] = await erpDeliveries(order.id);
    expect(sale.attempts).toBe(4);
    const { records } = await ledger();
    expect(records).toHaveLength(1);
    expect(sale.externalRef).toBe(records[0].id);
  });

  it('a stock.adjusted webhook sent twice is applied once', async () => {
    await mode({ mode: 'duplicate' });
    const before = await stock('PRAYER-MAT');
    const eventId = await adjust('PRAYER-MAT', 7);
    await eventually(async () => {
      const { webhooks } = await ledger();
      expect(webhooks.filter((w) => w.eventId === eventId)).toHaveLength(2);
      expect(webhooks.every((w) => w.sentAt)).toBe(true); // both copies got a 2xx
    });
    expect(await stock('PRAYER-MAT')).toBe(before + 7);
    expect(
      await prisma.inboundWebhook.findMany({ where: { source: 'erp' } }),
    ).toMatchObject([{ eventId, type: 'stock.adjusted', status: 'applied' }]);
    const [adjustment] = await prisma.stockAdjustment.findMany();
    expect(adjustment).toMatchObject({ delta: 7, applied: 7, shortfall: 0 });

    // The same adjustment re-sent under a new event id is still applied once.
    const res = await sendStock({
      adjustmentId: adjustment.adjustmentId,
      sku: 'PRAYER-MAT',
      delta: 7,
    }).expect(200);
    expect(res.body).toEqual({ received: true, duplicate: false });
    expect(await stock('PRAYER-MAT')).toBe(before + 7);
    expect(await prisma.stockAdjustment.count()).toBe(1);
  });

  it('an adjustment below zero clamps stock at 0, records the shortfall and keeps reservations', async () => {
    const order = await checkout('HONEY-SIDR-500G', 1); // seeded with 2, one now reserved
    expect(await stock('HONEY-SIDR-500G')).toBe(1);
    await adjust('HONEY-SIDR-500G', -4);
    await eventually(async () =>
      expect(await prisma.stockAdjustment.findMany()).toMatchObject([
        { delta: -4, applied: -1, shortfall: 3 },
      ]),
    );
    expect(await stock('HONEY-SIDR-500G')).toBe(0);
    expect(await orderStatus(order.id)).toBe('pending_payment');
    expect(
      await prisma.orderItem.findMany({ where: { orderId: order.id } }),
    ).toMatchObject([{ sku: 'HONEY-SIDR-500G', qty: 1 }]);
  });

  it('rejects bad signatures (401) and malformed events (400) without storing; an unknown SKU is 422 and recorded', async () => {
    const data = { adjustmentId: 'adj_x', sku: 'PRAYER-MAT', delta: 1 };
    const before = await stock('PRAYER-MAT');
    await sendStock(data, { secret: 'wrong-secret' }).expect(401);
    await sendStock(data, { secret: 'dev-fakepay-secret' }).expect(401); // another system's key
    await http()
      .post('/webhooks/erp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_x', type: 'stock.adjusted', data }))
      .expect(401);
    await sendStock({ ...data, delta: 1.5 }).expect(400);
    await sendStock({ ...data, delta: '1' }).expect(400);
    await sendStock({ ...data, delta: 0 }).expect(400);
    await sendStock({ sku: 'PRAYER-MAT', delta: 1 }).expect(400);
    expect(await prisma.inboundWebhook.count()).toBe(0);

    const unknown = `evt_${randomUUID()}`;
    const res = await sendStock(
      { adjustmentId: 'adj_y', sku: 'NO-SUCH-SKU', delta: 1 },
      { id: unknown },
    ).expect(422);
    expect(res.body.error).toBe('unknown_sku');
    expect(
      await prisma.inboundWebhook.findMany({ where: { source: 'erp' } }),
    ).toMatchObject([
      { eventId: unknown, status: 'rejected', error: 'unknown_sku' },
    ]);
    expect(await prisma.stockAdjustment.count()).toBe(0);
    expect(await stock('PRAYER-MAT')).toBe(before);
  });
});
