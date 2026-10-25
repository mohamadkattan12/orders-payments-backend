import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { apiError } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type Tx = Prisma.TransactionClient;
export interface Stored {
  status: number;
  body: unknown;
  replayed: boolean;
}

const KEY = /^[\x21-\x7e]{1,255}$/; // visible ASCII, like Stripe's keys
export const KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** Canonical JSON (sorted keys) so the same body always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `handler` at most once per (scope, key). The key, the handler's database changes and the
   * stored response commit in one transaction, so a crash leaves no key behind and the retry runs
   * again. A concurrent request with the same key waits on the uncommitted key row, then replays
   * the stored response. A failed request changed nothing and stores nothing.
   */
  async runInTransaction(
    scope: string,
    key: string | undefined,
    request: unknown,
    handler: (tx: Tx) => Promise<{ status: number; body: unknown }>,
  ): Promise<Stored> {
    if (!key || !KEY.test(key))
      throw apiError(
        400,
        'idempotency_key_required',
        'Send an Idempotency-Key header (1–255 visible ASCII characters).',
      );
    const requestHash = createHash('sha256')
      .update(canonical(request))
      .digest('hex');
    return this.prisma.$transaction(
      async (tx) => {
        await tx.idempotencyKey.deleteMany({
          where: {
            scope,
            key,
            createdAt: { lt: new Date(Date.now() - KEY_TTL_MS) },
          },
        });
        const inserted = await tx.$executeRaw`
          INSERT INTO idempotency_keys (scope, key, "requestHash", status)
          VALUES (${scope}, ${key}, ${requestHash}, 'in_progress')
          ON CONFLICT DO NOTHING`;
        if (inserted === 0) {
          const existing = await tx.idempotencyKey.findUniqueOrThrow({
            where: { scope_key: { scope, key } },
          });
          if (existing.requestHash !== requestHash)
            throw apiError(
              422,
              'idempotency_mismatch',
              'This Idempotency-Key was used with a different request.',
            );
          return {
            status: existing.responseStatus!,
            body: existing.responseBody,
            replayed: true,
          };
        }
        const result = await handler(tx);
        await tx.idempotencyKey.update({
          where: { scope_key: { scope, key } },
          data: {
            status: 'done',
            responseStatus: result.status,
            responseBody: result.body as Prisma.InputJsonValue,
          },
        });
        return { ...result, replayed: false };
      },
      { maxWait: 10_000, timeout: 15_000 },
    );
  }
}
