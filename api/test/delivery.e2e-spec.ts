import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Delivery } from '../src/generated/prisma/client.js';
import { DeliveryService } from '../src/outbox/delivery.service.js';
import { DeliveryWorker } from '../src/outbox/delivery.worker.js';
import {
  DESTINATION_HANDLERS,
  type DestinationHandler,
} from '../src/outbox/destinations.js';
import { Dispatcher } from '../src/outbox/dispatcher.js';
import { RelayService } from '../src/outbox/relay.service.js';
import { MAX_ATTEMPTS } from '../src/outbox/routing.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { eventually } from './support/app.js';

type Dest = 'erp' | 'courier' | 'invoicing';

/** A destination that records calls and fails on command. */
class TestDestination implements DestinationHandler {
  calls: { eventType: string; deliveryId: string }[] = [];
  failNext = 0;
  failAlways = false;
  deliver(delivery: Delivery) {
    this.calls.push({ eventType: delivery.eventType, deliveryId: delivery.id });
    if (this.failAlways || this.failNext-- > 0)
      return Promise.reject(new Error('HTTP 503'));
    return Promise.resolve({ externalRef: `ref-${delivery.destination}` });
  }
}

describe('delivery engine (e2e)', () => {
  let ctx: INestApplicationContext;
  let prisma: PrismaService;
  let relay: RelayService;
  let deliveries: DeliveryService;
  let worker: DeliveryWorker;
  let dispatcher: Dispatcher;
  let dest: Record<Dest, TestDestination>;

  const emit = (type: string, orderId: string = randomUUID()) =>
    prisma.outboxEvent.create({
      data: { type, orderId, payload: { orderId } },
    });
  const rows = (where: object = {}) =>
    prisma.delivery.findMany({ where, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    dest = {
      erp: new TestDestination(),
      courier: new TestDestination(),
      invoicing: new TestDestination(),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    })
      .overrideProvider(DESTINATION_HANDLERS)
      .useValue(dest)
      .compile();
    ctx = await moduleRef.init();
    prisma = ctx.get(PrismaService);
    relay = ctx.get(RelayService);
    deliveries = ctx.get(DeliveryService);
    worker = ctx.get(DeliveryWorker);
    dispatcher = ctx.get(Dispatcher);
  });

  beforeEach(async () => {
    await worker.stop();
    await dispatcher.queue.obliterate({ force: true });
    await prisma.$executeRawUnsafe(
      'TRUNCATE deliveries, outbox_events CASCADE',
    );
    for (const d of Object.values(dest))
      Object.assign(d, { calls: [], failNext: 0, failAlways: false });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('routes order.paid to all three systems once; order.created goes nowhere', async () => {
    await emit('order.created');
    const paid = await emit('order.paid');
    worker.start();
    const ids = await relay.relayOnce();
    expect(ids).toHaveLength(3);
    await eventually(async () =>
      expect((await rows({ status: 'delivered' })).length).toBe(3),
    );
    expect(
      (await rows())
        .map((d) => [d.destination, d.attempts, d.externalRef])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['courier', 1, 'ref-courier'],
      ['erp', 1, 'ref-erp'],
      ['invoicing', 1, 'ref-invoicing'],
    ]);
    expect(
      await prisma.outboxEvent.count({ where: { publishedAt: null } }),
    ).toBe(0);
    expect(dest.erp.calls).toEqual([
      { eventType: 'order.paid', deliveryId: expect.any(String) },
    ]);
    expect((await rows())[0].eventId).toBe(paid.id);
    expect(await relay.relayOnce()).toEqual([]); // nothing left to publish
  });

  it('retries a failing system with backoff and delivers once it recovers', async () => {
    dest.erp.failNext = 3;
    await emit('order.paid');
    worker.start();
    await relay.relayOnce();
    await eventually(async () =>
      expect((await rows({ destination: 'erp' }))[0].status).toBe('delivered'),
    );
    const [erp] = await rows({ destination: 'erp' });
    expect(erp.attempts).toBe(4);
    expect(dest.erp.calls).toHaveLength(4);
    expect(dest.courier.calls).toHaveLength(1); // the others were not held back
  });

  it(`gives up after ${MAX_ATTEMPTS} attempts (dead), and replay delivers it once`, async () => {
    dest.erp.failAlways = true;
    await emit('order.paid');
    worker.start();
    await relay.relayOnce();
    await eventually(
      async () =>
        expect((await rows({ destination: 'erp' }))[0].status).toBe('dead'),
      20_000,
    );
    const [dead] = await rows({ destination: 'erp' });
    expect(dead).toMatchObject({
      attempts: MAX_ATTEMPTS,
      lastError: 'HTTP 503',
    });
    expect(dest.erp.calls).toHaveLength(MAX_ATTEMPTS);
    dest.erp.failAlways = false;
    expect(await deliveries.replay(dead.id)).toBe(true);
    await eventually(async () =>
      expect((await rows({ destination: 'erp' }))[0].status).toBe('delivered'),
    );
    expect(dest.erp.calls).toHaveLength(MAX_ATTEMPTS + 1);
    expect(await deliveries.replay(dead.id)).toBe(false); // only dead deliveries replay
  });

  it('a crash right after the relay commits loses nothing: the sweeper enqueues it', async () => {
    await emit('order.paid');
    await relay.relayOnce({ enqueue: false }); // committed, then "crashed" before enqueueing
    worker.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(await rows({ status: 'delivered' })).toHaveLength(0);
    await prisma.delivery.updateMany({
      data: { nextAttemptAt: new Date(Date.now() - 2 * 60_000) },
    });
    expect(await deliveries.sweep()).toBe(3);
    await eventually(async () =>
      expect(await rows({ status: 'delivered' })).toHaveLength(3),
    );
  });

  it('a wiped Redis loses nothing: the sweeper re-enqueues from Postgres', async () => {
    await emit('order.paid');
    await relay.relayOnce(); // jobs queued …
    await dispatcher.queue.obliterate({ force: true }); // … and Redis loses them
    worker.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(await rows({ status: 'delivered' })).toHaveLength(0);
    await prisma.delivery.updateMany({
      data: { nextAttemptAt: new Date(Date.now() - 2 * 60_000) },
    });
    await deliveries.sweep();
    await eventually(async () =>
      expect(await rows({ status: 'delivered' })).toHaveLength(3),
    );
  });

  it('the same delivery enqueued many times at once calls the system once', async () => {
    await emit('order.paid');
    const ids = await relay.relayOnce({ enqueue: false });
    const erp = (await rows({ destination: 'erp' }))[0].id;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => dispatcher.enqueue(erp, `dup${i}`)),
    );
    worker.start(10);
    await eventually(async () =>
      expect((await rows({ destination: 'erp' }))[0].status).toBe('delivered'),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(dest.erp.calls).toHaveLength(1);
    expect(ids).toHaveLength(3);
  });

  it('a refund waits for its sale to reach the same system first', async () => {
    const orderId = randomUUID();
    dest.erp.failNext = 2; // the sale needs three tries
    await emit('order.paid', orderId);
    await emit('order.refunded', orderId);
    worker.start();
    await relay.relayOnce();
    await eventually(
      async () =>
        expect(
          await rows({ destination: 'erp', status: 'delivered' }),
        ).toHaveLength(2),
      15_000,
    );
    expect(dest.erp.calls.map((c) => c.eventType)).toEqual([
      'order.paid',
      'order.paid',
      'order.paid',
      'order.refunded',
    ]);
    const [refunded] = await rows({
      destination: 'erp',
      eventType: 'order.refunded',
    });
    expect(refunded.attempts).toBe(1); // waiting did not use up attempts
  });

  it('a refund behind a dead sale is blocked; replaying the sale delivers both, in order', async () => {
    const orderId = randomUUID();
    dest.erp.failAlways = true;
    await emit('order.paid', orderId);
    await emit('order.refunded', orderId);
    worker.start();
    await relay.relayOnce();
    await eventually(async () => {
      const erp = await rows({ destination: 'erp' });
      expect(erp.map((d) => [d.eventType, d.status])).toEqual([
        ['order.paid', 'dead'],
        ['order.refunded', 'blocked'],
      ]);
    }, 20_000);
    dest.erp.failAlways = false;
    dest.erp.calls = [];
    const [sale] = await rows({ destination: 'erp', eventType: 'order.paid' });
    await deliveries.replay(sale.id);
    await eventually(async () =>
      expect(
        await rows({ destination: 'erp', status: 'delivered' }),
      ).toHaveLength(2),
    );
    expect(dest.erp.calls.map((c) => c.eventType)).toEqual([
      'order.paid',
      'order.refunded',
    ]);
  });
  it('after a replay, a system that is still down is retried on the backoff, not left for the sweeper', async () => {
    dest.erp.failAlways = true;
    await emit('order.paid');
    worker.start();
    await relay.relayOnce();
    await eventually(
      async () =>
        expect((await rows({ destination: 'erp' }))[0].status).toBe('dead'),
      20_000,
    );
    const [dead] = await rows({ destination: 'erp' });
    await deliveries.replay(dead.id);
    // replay, then retries a1, a2 … on a 20 ms base: well within 5 s, far below the sweeper's minute
    await eventually(
      () =>
        expect(dest.erp.calls.length).toBeGreaterThanOrEqual(MAX_ATTEMPTS + 3),
      5000,
    );
  });

  it('a blocked delivery whose predecessor is already delivered is freed by the sweeper', async () => {
    const orderId = randomUUID();
    await emit('order.paid', orderId);
    await emit('order.refunded', orderId);
    await relay.relayOnce({ enqueue: false });
    // The race: the sale was replayed and delivered between the refund's check and its "blocked" write.
    await prisma.delivery.updateMany({
      where: { orderId, destination: 'erp', eventType: 'order.paid' },
      data: { status: 'delivered', attempts: 1 },
    });
    await prisma.delivery.updateMany({
      where: { orderId, destination: 'erp', eventType: 'order.refunded' },
      data: { status: 'blocked' },
    });
    worker.start();
    await deliveries.sweep();
    await eventually(async () =>
      expect(
        (
          await rows({
            orderId,
            destination: 'erp',
            eventType: 'order.refunded',
          })
        )[0].status,
      ).toBe('delivered'),
    );
  });
});
