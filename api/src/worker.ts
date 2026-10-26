import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { KEY_TTL_MS } from './idempotency/idempotency.service.js';
import { DeliveryService } from './outbox/delivery.service.js';
import { DeliveryWorker } from './outbox/delivery.worker.js';
import { RelayService } from './outbox/relay.service.js';
import { PaymentsService } from './payments/payments.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { WorkerModule } from './worker.module.js';

const log = new Logger('Worker');

/** Run `job` every `ms`, never overlapping itself; a failure is logged and retried next tick. */
function every(
  name: string,
  ms: number,
  job: () => Promise<unknown>,
): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    job()
      .catch((error: unknown) => log.error(`${name}: ${String(error)}`))
      .finally(() => (running = false));
  }, ms);
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new ConsoleLogger({ json: true }),
  });
  app.enableShutdownHooks();
  const relay = app.get(RelayService);
  const deliveries = app.get(DeliveryService);
  const payments = app.get(PaymentsService);
  const prisma = app.get(PrismaService);
  app.get(DeliveryWorker).start();
  const timers = [
    every('relay', 200, () => relay.relayOnce()),
    every('sweep', 30_000, () => deliveries.sweep()),
    every('reconcile', 30_000, () => payments.reconcilePayments()),
    every('refunds', 30_000, () => payments.processRefunds()),
    every('expire', 30_000, () => payments.expireDue()),
    every('idempotency-cleanup', 60 * 60_000, () =>
      prisma.idempotencyKey.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - KEY_TTL_MS) } },
      }),
    ),
  ];
  process.on('SIGTERM', () => timers.forEach(clearInterval));
  log.log('worker started');
}
await bootstrap();
