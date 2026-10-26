import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { CourierHandler } from '../src/destinations/courier/courier.handler.js';
import { DeliveryWorker } from '../src/outbox/delivery.worker.js';
import { RelayService } from '../src/outbox/relay.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { createTestApp, eventually, fakes, resetData } from './support/app.js';

const customer = { name: 'Sara', phone: '+966512345678', city: 'Riyadh' };

interface Ledger {
  shipments: { id: string; orderId: string; status: string }[];
  webhooks: { eventId: string; sentAt: string | null }[];
}

describe('courier (e2e, real fakes)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let relayTimer: NodeJS.Timeout;

  const http = () => request(app.getHttpServer());
  const control = (path: string, body: object = {}) =>
    fakes(`/control/${path}`, { method: 'POST', body: JSON.stringify(body) });
  const ledger = async () =>
    (await (await fakes('/control/courier/ledger')).json()) as Ledger;
  const shipment = (orderId: string) =>
    prisma.shipment.findUniqueOrThrow({ where: { orderId } });
  const courierDelivery = (orderId: string) =>
    prisma.delivery.findFirstOrThrow({
      where: { orderId, destination: 'courier' },
    });

  /** checkout → pay → FakePay webhook → paid → relay → courier delivery → shipments row. */
  const paidOrder = async () => {
    const { id } = (
      await http()
        .post('/orders')
        .set('Idempotency-Key', randomUUID())
        .send({ customer, items: [{ sku: 'SAFFRON-5G', qty: 2 }] })
        .expect(201)
    ).body as { id: string };
    await http()
      .post(`/orders/${id}/pay`)
      .set('Idempotency-Key', randomUUID())
      .send({ token: 'tok_success' })
      .expect(202);
    await eventually(async () =>
      expect((await courierDelivery(id)).status).toBe('delivered'),
    );
    return id;
  };

  const sign = (raw: string, secret = 'dev-courier-secret') => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
  };
  const sendUpdate = (data: object, secret?: string) => {
    const raw = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: 'shipment.updated',
      data,
    });
    return http()
      .post('/webhooks/courier')
      .set('Courier-Signature', sign(raw, secret))
      .set('Content-Type', 'application/json')
      .send(raw);
  };
  /** All tracking webhooks the courier queued have been answered 2xx by the store. */
  const allSent = async (count: number) =>
    eventually(async () => {
      const { webhooks } = await ledger();
      expect(webhooks).toHaveLength(count);
      expect(webhooks.every((w) => w.sentAt)).toBe(true);
    });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp({ listen: true }));
    worker = await (
      await Test.createTestingModule({ imports: [WorkerModule] }).compile()
    ).init();
    worker.get(DeliveryWorker).start();
    const relay = worker.get(RelayService);
    relayTimer = setInterval(() => void relay.relayOnce().catch(() => {}), 100);
  });

  beforeEach(async () => {
    await resetData(prisma);
  });

  afterAll(async () => {
    clearInterval(relayTimer);
    await worker.close();
    await app.close();
  });

  it('a paid order gets one shipment at the courier and one shipments row; a repeat delivery changes nothing', async () => {
    const orderId = await paidOrder();
    const delivery = await courierDelivery(orderId);
    const row = await shipment(orderId);
    expect(row).toMatchObject({ status: 'created', statusSeq: 1 });
    expect(delivery).toMatchObject({
      attempts: 1,
      externalRef: row.courierShipmentId,
    });
    const { shipments } = await ledger();
    expect(shipments).toEqual([
      expect.objectContaining({ id: row.courierShipmentId, orderId }),
    ]);

    // The worker crashed after the call and the delivery runs again: same key, same shipment.
    const event = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: delivery.eventId },
    });
    await expect(
      worker.get(CourierHandler).deliver(delivery, event.payload),
    ).resolves.toEqual({ externalRef: row.courierShipmentId });
    expect((await ledger()).shipments).toHaveLength(1);
    expect(await prisma.shipment.count()).toBe(1);
    await allSent(1); // the courier's own "created" update was accepted too
    expect((await shipment(orderId)).status).toBe('created');
  });

  it('a flaky courier fails twice, then the shipment is created once', async () => {
    await control('courier', { mode: 'flaky', failCount: 2 });
    const orderId = await paidOrder();
    expect(await courierDelivery(orderId)).toMatchObject({
      attempts: 3,
      lastError: null,
    });
    expect((await ledger()).shipments).toHaveLength(1);
    expect(await prisma.shipment.count({ where: { orderId } })).toBe(1);
  });

  it('duplicate tracking webhooks are applied once', async () => {
    await control('courier', { mode: 'duplicate' });
    const orderId = await paidOrder();
    const { courierShipmentId } = await shipment(orderId);
    await control(`courier/shipments/${courierShipmentId}/advance`, {
      to: 'delivered',
    });
    await allSent(8); // created, picked_up, in_transit, delivered: each sent twice
    expect(await shipment(orderId)).toMatchObject({
      status: 'delivered',
      statusSeq: 4,
    });
    expect(
      await prisma.inboundWebhook.count({
        where: { source: 'courier', status: 'applied' },
      }),
    ).toBe(4);
  });

  it('out-of-order tracking ends delivered and never moves backwards', async () => {
    await control('courier', { mode: 'out_of_order' });
    const orderId = await paidOrder();
    const { courierShipmentId } = await shipment(orderId);
    await control(`courier/shipments/${courierShipmentId}/advance`, {
      to: 'delivered',
    });
    expect((await (await control('courier/flush')).json()).released).toBe(4);
    // Released newest first: delivered, in_transit, picked_up, created.
    const seen = new Set<string>();
    await eventually(async () => {
      seen.add((await shipment(orderId)).status);
      const { webhooks } = await ledger();
      expect(webhooks.every((w) => w.sentAt)).toBe(true);
    });
    expect(await shipment(orderId)).toMatchObject({
      status: 'delivered',
      statusSeq: 4,
    });
    expect([...seen].filter((s) => s !== 'created')).toEqual(['delivered']);
    expect(
      await prisma.inboundWebhook.count({ where: { source: 'courier' } }),
    ).toBe(4);
  });

  it('webhooks: bad signature 401, malformed 400, unknown shipment 422 recorded, not-yet-stored shipment 409', async () => {
    await sendUpdate(
      { shipmentId: 'shp_x', orderId: randomUUID(), status: 'delivered' },
      'wrong-secret',
    ).expect(401);
    expect(await prisma.inboundWebhook.count()).toBe(0);

    await sendUpdate({ shipmentId: 'shp_x', status: 'lost' }).expect(400);
    expect(
      (
        await sendUpdate({
          shipmentId: 'shp_x',
          orderId: 'not-a-uuid',
          status: 'delivered',
        }).expect(422)
      ).body.error,
    ).toBe('unknown_shipment');
    expect(
      (
        await sendUpdate({
          shipmentId: 'shp_x',
          orderId: randomUUID(),
          status: 'delivered',
        }).expect(422)
      ).body.error,
    ).toBe('unknown_shipment');

    const orderId = await paidOrder();
    const { courierShipmentId } = await shipment(orderId);
    expect(
      (
        await sendUpdate({
          shipmentId: courierShipmentId,
          orderId: randomUUID(),
          status: 'delivered',
        }).expect(422)
      ).body.error,
    ).toBe('shipment_order_mismatch');
    // Known order, shipment not stored yet: our create may still be committing, so the courier retries.
    expect(
      (
        await sendUpdate({
          shipmentId: 'shp_new',
          orderId,
          status: 'picked_up',
        }).expect(409)
      ).body.error,
    ).toBe('shipment_not_ready');
    expect(
      await prisma.inboundWebhook.count({ where: { status: 'rejected' } }),
    ).toBe(3);
    expect((await shipment(orderId)).status).toBe('created');
  });
});
