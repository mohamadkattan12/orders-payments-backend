import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import type { Delivery } from '../src/generated/prisma/client.js';
import { DeliveryWorker } from '../src/outbox/delivery.worker.js';
import {
  DESTINATION_HANDLERS,
  type DestinationHandler,
} from '../src/outbox/destinations.js';
import { Dispatcher } from '../src/outbox/dispatcher.js';
import { RelayService } from '../src/outbox/relay.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { eventually, fakes, resetData } from './support/app.js';
import { STORE_PORT } from './support/fakes.js';

const customer = { name: 'Sara', phone: '+966512345678', city: 'Riyadh' };
const ADMIN = { 'X-Admin-Key': 'dev-admin-key' };

/** Counts calls per destination so "delivered once" can be asserted. */
class CountingDestination implements DestinationHandler {
  calls: string[] = [];
  deliver(delivery: Delivery) {
    this.calls.push(delivery.id);
    return Promise.resolve({ externalRef: `ref-${delivery.destination}` });
  }
}

describe('admin API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: DeliveryWorker;
  const dest = {
    erp: new CountingDestination(),
    courier: new CountingDestination(),
    invoicing: new CountingDestination(),
  };

  const http = () => request(app.getHttpServer());
  const admin = (path: string) => http().get(path).set(ADMIN);
  const checkout = async (sku = 'SAFFRON-5G') =>
    (
      await http()
        .post('/orders')
        .set('Idempotency-Key', randomUUID())
        .send({ customer, items: [{ sku, qty: 1 }] })
        .expect(201)
    ).body as { id: string };
  const deadDelivery = async () => {
    const orderId = randomUUID();
    const event = await prisma.outboxEvent.create({
      data: {
        type: 'order.paid',
        orderId,
        payload: { orderId },
        publishedAt: new Date(),
      },
    });
    return prisma.delivery.create({
      data: {
        eventId: event.id,
        orderId,
        eventType: 'order.paid',
        destination: 'erp',
        status: 'dead',
        attempts: 8,
        lastError: 'HTTP 503',
      },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DESTINATION_HANDLERS)
      .useValue(dest)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(STORE_PORT, '127.0.0.1'); // FakePay webhooks reach this app
    prisma = app.get(PrismaService);
    worker = app.get(DeliveryWorker);
  });

  beforeEach(async () => {
    await worker.stop();
    await app.get(Dispatcher).queue.obliterate({ force: true });
    await resetData(prisma);
    for (const d of Object.values(dest)) d.calls = [];
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['get', '/admin/orders'],
    ['get', `/admin/orders/${randomUUID()}/timeline`],
    ['get', '/admin/deliveries?status=dead'],
    ['post', `/admin/deliveries/${randomUUID()}/replay`],
    ['get', '/admin/stock-adjustments'],
    ['get', '/admin/fakes/modes'],
    ['post', '/admin/fakes/erp/mode'],
  ] as const)('%s %s needs the admin key', async (method, path) => {
    const missing = await http()[method](path).expect(401);
    expect(missing.body.error).toBe('admin_key_required');
    await http()[method](path).set('X-Admin-Key', 'wrong').expect(401);
  });

  it('lists orders newest first, filters by status and pages', async () => {
    const first = await checkout();
    const second = await checkout();
    await prisma.order.update({
      where: { id: first.id },
      data: { status: 'cancelled' },
    });

    const all = (await admin('/admin/orders').expect(200)).body;
    expect(all.total).toBe(2);
    expect(all.items.map((o: { id: string }) => o.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(all.items[0]).toMatchObject({
      status: 'pending_payment',
      totalHalalas: 3999,
      customerName: 'Sara',
    });

    const cancelled = (
      await admin('/admin/orders?status=cancelled').expect(200)
    ).body;
    expect(cancelled.items.map((o: { id: string }) => o.id)).toEqual([
      first.id,
    ]);

    const page = (await admin('/admin/orders?limit=1&offset=1').expect(200))
      .body;
    expect(page).toMatchObject({ total: 2, items: [{ id: first.id }] });

    await admin('/admin/orders?status=lost').expect(400);
    await admin('/admin/orders?limit=0').expect(400);
    await admin('/admin/orders?limit=1000').expect(400);
    await admin('/admin/orders?offset=-1').expect(400);
  });

  it('shows the timeline of a paid order: items, payment, webhook, events, deliveries', async () => {
    const { id } = await checkout();
    await http()
      .post(`/orders/${id}/pay`)
      .set('Idempotency-Key', randomUUID())
      .send({ token: 'tok_success' })
      .expect(202);
    await eventually(async () =>
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('paid'),
    );
    worker.start();
    await app.get(RelayService).relayOnce();
    await eventually(async () =>
      expect(
        await prisma.delivery.count({
          where: { orderId: id, status: 'delivered' },
        }),
      ).toBe(3),
    );

    const t = (await admin(`/admin/orders/${id}/timeline`).expect(200)).body;
    expect(t.order).toMatchObject({ id, status: 'paid', totalHalalas: 3999 });
    expect(t.order.items).toMatchObject([{ sku: 'SAFFRON-5G', qty: 1 }]);
    expect(t.payments).toMatchObject([
      { status: 'succeeded', amountHalalas: 3999 },
    ]);
    expect(t.refunds).toEqual([]);
    expect(t.webhooks).toMatchObject([
      { source: 'fakepay', type: 'payment.succeeded', status: 'applied' },
    ]);
    expect(t.outboxEvents.map((e: { type: string }) => e.type)).toEqual([
      'order.created',
      'order.paid',
    ]);
    expect(t.outboxEvents[1].publishedAt).toEqual(expect.any(String));
    expect(
      t.deliveries
        .map((d: Delivery) => [d.destination, d.status, d.attempts])
        .sort(),
    ).toEqual([
      ['courier', 'delivered', 1],
      ['erp', 'delivered', 1],
      ['invoicing', 'delivered', 1],
    ]);
    expect(t.deliveries[0].externalRef).toMatch(/^ref-/);
    expect(t.shipment).toBeNull();
    expect(t.invoices).toEqual([]);

    await admin(`/admin/orders/${randomUUID()}/timeline`).expect(404);
    await admin('/admin/orders/not-a-uuid/timeline').expect(400);
  });

  it('lists dead letters; replay delivers a dead delivery once', async () => {
    const dead = await deadDelivery();
    await checkout(); // unrelated noise

    const list = (await admin('/admin/deliveries?status=dead').expect(200))
      .body;
    expect(list.items).toMatchObject([
      {
        id: dead.id,
        destination: 'erp',
        eventType: 'order.paid',
        attempts: 8,
        lastError: 'HTTP 503',
      },
    ]);
    await admin('/admin/deliveries?status=gone').expect(400);

    worker.start();
    await http()
      .post(`/admin/deliveries/${dead.id}/replay`)
      .set(ADMIN)
      .expect(202);
    await eventually(async () =>
      expect(
        (await prisma.delivery.findUniqueOrThrow({ where: { id: dead.id } }))
          .status,
      ).toBe('delivered'),
    );
    await new Promise((r) => setTimeout(r, 300)); // room for a wrong second call to show up
    expect(dest.erp.calls).toEqual([dead.id]);
    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: dead.id } }))
        .attempts,
    ).toBe(1);

    const again = await http()
      .post(`/admin/deliveries/${dead.id}/replay`)
      .set(ADMIN)
      .expect(409);
    expect(again.body.error).toBe('delivery_not_dead');
    await http()
      .post(`/admin/deliveries/${randomUUID()}/replay`)
      .set(ADMIN)
      .expect(404);
    await http().post('/admin/deliveries/nope/replay').set(ADMIN).expect(400);
    expect((await admin('/admin/deliveries?status=dead')).body.items).toEqual(
      [],
    );
  });

  it('lists stock adjustments newest first with their shortfall', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { sku: 'SAFFRON-5G' },
    });
    await prisma.stockAdjustment.create({
      data: {
        adjustmentId: 'adj_1',
        productId: product.id,
        delta: 5,
        applied: 5,
      },
    });
    await prisma.stockAdjustment.create({
      data: {
        adjustmentId: 'adj_2',
        productId: product.id,
        delta: -100,
        applied: -10,
        shortfall: 90,
        createdAt: new Date(Date.now() + 1000),
      },
    });
    const list = (await admin('/admin/stock-adjustments').expect(200)).body;
    expect(list.total).toBe(2);
    expect(list.items).toMatchObject([
      { adjustmentId: 'adj_2', sku: 'SAFFRON-5G', delta: -100, shortfall: 90 },
      { adjustmentId: 'adj_1', sku: 'SAFFRON-5G', delta: 5, shortfall: 0 },
    ]);
  });

  it('reads and changes the fake systems’ modes through the API', async () => {
    const modes = (await admin('/admin/fakes/modes').expect(200)).body;
    expect(modes.map((m: { system: string }) => m.system)).toEqual([
      'fakepay',
      'erp',
      'courier',
      'einvoice',
    ]);
    expect(modes.every((m: { mode: string }) => m.mode === 'ok')).toBe(true);

    const set = await http()
      .post('/admin/fakes/erp/mode')
      .set(ADMIN)
      .send({ mode: 'flaky', failCount: 3 })
      .expect(200);
    expect(set.body).toMatchObject({
      system: 'erp',
      mode: 'flaky',
      failCount: 3,
    });
    // Durable on the fakes side, not just echoed back.
    expect(await (await fakes('/control/erp')).json()).toMatchObject({
      mode: 'flaky',
      failCount: 3,
    });

    const unsupported = await http()
      .post('/admin/fakes/courier/mode')
      .set(ADMIN)
      .send({ mode: 'down' })
      .expect(400);
    expect(unsupported.body.error).toBe('mode_not_supported');
    await http()
      .post('/admin/fakes/bank/mode')
      .set(ADMIN)
      .send({ mode: 'ok' })
      .expect(400);
    await http()
      .post('/admin/fakes/erp/mode')
      .set(ADMIN)
      .send({ mode: 'melting' })
      .expect(400);
    await http()
      .post('/admin/fakes/erp/mode')
      .set(ADMIN)
      .send({ mode: 'flaky', failCount: 1000 })
      .expect(400);
  });
});
