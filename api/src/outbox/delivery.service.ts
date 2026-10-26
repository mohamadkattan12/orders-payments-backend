import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Delivery } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DESTINATION_HANDLERS,
  type DestinationHandlers,
} from './destinations.js';
import { Dispatcher } from './dispatcher.js';
import { backoffMs, LEASE_MS, MAX_ATTEMPTS, PREDECESSOR } from './routing.js';

const WAIT_FOR_PREDECESSOR_MS = 2000;
const SWEEP_GRACE_MS = 60_000;

/**
 * Runs one delivery attempt at a time per delivery. Postgres owns attempts, timing and the lease
 * (amendment 7): a consumer claims with a conditional update, and every terminal update is
 * conditional too, so `delivered` never becomes `dead` and two workers never both call out.
 */
@Injectable()
export class DeliveryService {
  private readonly log = new Logger('Deliveries');

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: Dispatcher,
    @Inject(DESTINATION_HANDLERS)
    private readonly handlers: DestinationHandlers,
  ) {}

  /** Claim for LEASE_MS if pending, due (2 s tolerance: a delayed job may fire early) and unleased. */
  private async claim(id: string): Promise<Delivery | null> {
    const rows = await this.prisma.$queryRaw<Delivery[]>`
      UPDATE deliveries SET "leaseUntil" = now() + make_interval(secs => ${LEASE_MS / 1000})
      WHERE id = ${id}::uuid AND status = 'pending' AND "nextAttemptAt" <= now() + interval '2 seconds'
        AND ("leaseUntil" IS NULL OR "leaseUntil" < now())
      RETURNING *`;
    return rows[0] ?? null;
  }

  async attempt(
    id: string,
  ): Promise<
    'delivered' | 'retry' | 'dead' | 'waiting' | 'blocked' | 'skipped'
  > {
    const delivery = await this.claim(id);
    if (!delivery) return 'skipped'; // done, not due, or another worker holds it

    const predecessorType = PREDECESSOR[delivery.eventType];
    if (predecessorType) {
      const predecessor = await this.prisma.delivery.findFirst({
        where: {
          orderId: delivery.orderId,
          destination: delivery.destination,
          eventType: predecessorType,
        },
      });
      if (predecessor && predecessor.status !== 'delivered') {
        const blocked =
          predecessor.status === 'dead' || predecessor.status === 'blocked';
        await this.prisma.delivery.updateMany({
          where: { id, status: 'pending' },
          data: blocked
            ? {
                status: 'blocked',
                leaseUntil: null,
                lastError: `waiting for dead ${predecessorType}`,
              }
            : {
                leaseUntil: null,
                nextAttemptAt: new Date(Date.now() + WAIT_FOR_PREDECESSOR_MS),
              },
        });
        if (blocked) return 'blocked';
        await this.dispatcher.enqueue(
          id,
          `wait${Date.now()}`,
          WAIT_FOR_PREDECESSOR_MS,
        );
        return 'waiting'; // not an attempt: the predecessor is still being delivered
      }
    }

    const event = await this.prisma.outboxEvent.findUniqueOrThrow({
      where: { id: delivery.eventId },
    });
    const attempts = delivery.attempts + 1;
    try {
      const { externalRef } = await this.handlers[delivery.destination].deliver(
        delivery,
        event.payload,
      );
      await this.prisma.delivery.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: 'delivered',
          attempts,
          externalRef: externalRef ?? null,
          leaseUntil: null,
          lastError: null,
        },
      });
      await this.unblockDependents(delivery);
      return 'delivered';
    } catch (error) {
      const lastError = String((error as Error)?.message ?? error).slice(
        0,
        500,
      );
      const dead = attempts >= MAX_ATTEMPTS;
      const delay = backoffMs(attempts);
      await this.prisma.delivery.updateMany({
        where: { id, status: 'pending' },
        data: dead
          ? { status: 'dead', attempts, lastError, leaseUntil: null }
          : {
              attempts,
              lastError,
              leaseUntil: null,
              nextAttemptAt: new Date(Date.now() + delay),
            },
      });
      this.log.warn(
        `${delivery.destination} ${delivery.eventType} attempt ${attempts}: ${lastError}`,
      );
      if (dead) return 'dead';
      // Unique per round: after a replay, attempt numbers repeat and BullMQ keeps completed job ids.
      await this.dispatcher.enqueue(id, `a${attempts}_${Date.now()}`, delay);
      return 'retry';
    }
  }

  /** A delivered predecessor frees the deliveries waiting on it (same order and destination). */
  private async unblockDependents(delivery: Delivery): Promise<void> {
    const dependentTypes = Object.entries(PREDECESSOR)
      .filter(([, before]) => before === delivery.eventType)
      .map(([type]) => type);
    if (!dependentTypes.length) return;
    const waiting = await this.prisma.delivery.findMany({
      where: {
        orderId: delivery.orderId,
        destination: delivery.destination,
        eventType: { in: dependentTypes },
        status: 'blocked',
      },
    });
    for (const d of waiting) {
      await this.prisma.delivery.updateMany({
        where: { id: d.id, status: 'blocked' },
        data: { status: 'pending', nextAttemptAt: new Date(), lastError: null },
      });
      await this.dispatcher.enqueue(d.id, `unblock${Date.now()}`);
    }
  }

  /** Replay a dead delivery from scratch (admin). */
  async replay(id: string): Promise<boolean> {
    const { count } = await this.prisma.delivery.updateMany({
      where: { id, status: 'dead' },
      data: {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
        leaseUntil: null,
      },
    });
    if (count) await this.dispatcher.enqueue(id, `replay${Date.now()}`);
    return count > 0;
  }

  /**
   * Re-enqueue pending deliveries overdue by a minute (a crash after commit, a wiped Redis) and free
   * blocked ones whose predecessor has been delivered.
   */
  async sweep(): Promise<number> {
    const overdue = await this.prisma.delivery.findMany({
      where: {
        status: 'pending',
        nextAttemptAt: { lt: new Date(Date.now() - SWEEP_GRACE_MS) },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      select: { id: true },
      take: 500,
    });
    for (const { id } of overdue)
      await this.dispatcher.enqueue(id, `sweep${Date.now()}`);
    // A predecessor delivered just after its dependent checked it leaves the dependent blocked.
    const blocked = await this.prisma.delivery.findMany({
      where: { status: 'blocked' },
      take: 500,
    });
    for (const d of blocked) {
      const predecessor = await this.prisma.delivery.findFirst({
        where: {
          orderId: d.orderId,
          destination: d.destination,
          eventType: PREDECESSOR[d.eventType],
          status: 'delivered',
        },
      });
      if (predecessor) await this.unblockDependents(predecessor);
    }
    return overdue.length;
  }
}
