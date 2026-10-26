import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Dispatcher } from './dispatcher.js';
import { ROUTES } from './routing.js';

/**
 * Moves outbox events into deliveries: in one transaction it claims unpublished events, creates a
 * delivery per destination and marks the events published; it enqueues only after commit. A crash
 * after commit leaves pending deliveries that the sweeper enqueues (amendment 6).
 */
@Injectable()
export class RelayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: Dispatcher,
  ) {}

  /** Returns the ids of deliveries created. `enqueue: false` simulates a crash right after commit. */
  async relayOnce(options: { enqueue?: boolean } = {}): Promise<string[]> {
    const created = await this.prisma.$transaction(async (tx) => {
      const events = await tx.$queryRaw<
        { id: string; type: string; orderId: string }[]
      >`
        SELECT id, type, "orderId" FROM outbox_events
        WHERE "publishedAt" IS NULL
        ORDER BY "createdAt"
        LIMIT 100
        FOR UPDATE SKIP LOCKED`;
      const ids: string[] = [];
      for (const event of events) {
        for (const destination of ROUTES[event.type] ?? []) {
          const delivery = await tx.delivery.upsert({
            where: { eventId_destination: { eventId: event.id, destination } },
            create: {
              eventId: event.id,
              orderId: event.orderId,
              eventType: event.type,
              destination,
            },
            update: {},
          });
          ids.push(delivery.id);
        }
      }
      if (events.length)
        await tx.outboxEvent.updateMany({
          where: { id: { in: events.map((e) => e.id) } },
          data: { publishedAt: new Date() },
        });
      return ids;
    });
    if (options.enqueue !== false)
      for (const id of created) await this.dispatcher.enqueue(id, 'first');
    return created;
  }
}
