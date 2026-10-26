import { HttpException, Injectable } from '@nestjs/common';
import type { Tx } from '../idempotency/idempotency.service.js';
import { Rejection } from '../payments/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface InboundEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

/**
 * Applies each inbound event once. The event id, its effects and the outbox events they write
 * commit together, so a crash leaves nothing and the provider's retry is applied (amendment 5).
 */
@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  async handle(
    source: 'fakepay' | 'erp' | 'courier',
    event: InboundEvent,
    apply: (tx: Tx) => Promise<unknown>,
  ): Promise<{ received: true; duplicate: boolean }> {
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO inbound_webhooks (id, source, "eventId", type, payload, status)
          VALUES (gen_random_uuid(), ${source}, ${event.id}, ${event.type},
                  ${JSON.stringify(event)}::jsonb, 'applied')
          ON CONFLICT DO NOTHING`;
        if (inserted === 0) {
          const prior = await tx.inboundWebhook.findUniqueOrThrow({
            where: { source_eventId: { source, eventId: event.id } },
          });
          return prior.status === 'rejected'
            ? { rejected: prior.error ?? 'rejected' }
            : { duplicate: true };
        }
        try {
          await apply(tx);
          return { duplicate: false };
        } catch (error) {
          if (!(error instanceof Rejection)) throw error; // roll back; the provider retries
          await tx.inboundWebhook.update({
            where: { source_eventId: { source, eventId: event.id } },
            data: { status: 'rejected', error: error.code },
          });
          return { rejected: error.code };
        }
      },
      { maxWait: 10_000, timeout: 15_000 },
    );
    if ('rejected' in outcome)
      throw new HttpException(
        {
          statusCode: 422,
          error: outcome.rejected,
          message: 'Event rejected.',
        },
        422,
      );
    return { received: true, duplicate: outcome.duplicate };
  }
}
