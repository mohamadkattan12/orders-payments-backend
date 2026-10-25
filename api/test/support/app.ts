import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { seed } from '../../src/seed/seed.js';
import { Clock, type FixedClock } from '../../src/common/clock.js';
import { STORE_PORT } from './fakes.js';

export const CONTROL = { 'X-Control-Key': 'dev-control-key' };
export const fakes = (
  path: string,
  init: { method?: string; body?: string } = {},
) =>
  fetch(`http://127.0.0.1:8299${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CONTROL },
  });

/** Waits until `check` stops throwing (webhooks and jobs are asynchronous). */
export async function eventually<T>(
  check: () => T | Promise<T>,
  ms = 10_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** listen: serve on STORE_PORT so the fakes' webhooks reach this app. */
export async function createTestApp(
  options: { listen?: boolean; clock?: FixedClock } = {},
): Promise<{
  app: INestApplication;
  prisma: PrismaService;
}> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.clock)
    builder = builder.overrideProvider(Clock).useValue(options.clock);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  if (options.listen) await app.listen(STORE_PORT, '127.0.0.1');
  else await app.init();
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
  await fakes('/control/reset', { method: 'POST' });
}
