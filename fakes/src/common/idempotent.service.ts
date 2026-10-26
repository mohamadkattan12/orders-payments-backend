import { HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type Tx = Prisma.TransactionClient;

/**
 * The receiver's half of "exactly once in effect": the business effect and the stored response
 * commit together, and a repeated key replays the response. Concurrent identical requests block on
 * the uncommitted key row, then replay.
 */
@Injectable()
export class IdempotentService {
  constructor(private readonly prisma: PrismaService) {}

  run(
    system: string,
    key: string | undefined,
    request: unknown,
    effect: (tx: Tx) => Promise<{ status: number; body: unknown }>,
  ): Promise<{ status: number; body: unknown }> {
    if (!key)
      throw new HttpException({ error: 'idempotency_key_required' }, 400);
    const requestHash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    return this.prisma.$transaction(
      async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO idempotent_requests (system, key, "requestHash", "responseStatus", "responseBody")
          VALUES (${system}, ${key}, ${requestHash}, 0, 'null'::jsonb)
          ON CONFLICT DO NOTHING`;
        if (inserted === 0) {
          const prior = await tx.idempotentRequest.findUniqueOrThrow({
            where: { system_key: { system, key } },
          });
          if (prior.requestHash !== requestHash)
            throw new HttpException({ error: 'idempotency_mismatch' }, 422);
          return { status: prior.responseStatus, body: prior.responseBody };
        }
        const result = await effect(tx);
        await tx.idempotentRequest.update({
          where: { system_key: { system, key } },
          data: {
            responseStatus: result.status,
            responseBody: result.body as Prisma.InputJsonValue,
          },
        });
        return result;
      },
      { maxWait: 10_000, timeout: 15_000 },
    );
  }
}
