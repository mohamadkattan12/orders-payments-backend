import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { seed } from '../../src/seed/seed.js';

export async function createTestApp(): Promise<{
  app: INestApplication;
  prisma: PrismaService;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  const prisma = app.get(PrismaService);
  await resetData(prisma);
  return { app, prisma };
}

/** Empty every table and re-seed the catalog with its original stock. */
export async function resetData(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE deliveries, outbox_events, inbound_webhooks, idempotency_keys, refunds, payments, invoices, shipments, stock_adjustments, order_items, orders, products CASCADE',
  );
  await seed(prisma);
}
