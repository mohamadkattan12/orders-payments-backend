import { Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CommonModule } from './common/common.module.js';
import { RedisModule } from './common/redis.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { AdminModule } from './admin/admin.module.js';
import { ErpWebhooksModule } from './destinations/erp/erp-webhooks.module.js';

@Module({
  imports: [
    // Per-IP limit on every route except health; raised for tests and the load test.
    ThrottlerModule.forRoot([
      { ttl: 10_000, limit: Number(process.env.THROTTLE_LIMIT ?? 200) },
    ]),
    CommonModule,
    PrismaModule,
    RedisModule,
    HealthModule,
    CatalogModule,
    IdempotencyModule,
    OrdersModule,
    PaymentsModule,
    WebhooksModule,
    AdminModule,
    ErpWebhooksModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
