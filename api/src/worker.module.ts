import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { RedisModule } from './common/redis.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

/** Everything the background worker runs; no HTTP. */
@Module({
  imports: [
    CommonModule,
    PrismaModule,
    RedisModule,
    IdempotencyModule,
    PaymentsModule,
    OutboxModule,
  ],
})
export class WorkerModule {}
