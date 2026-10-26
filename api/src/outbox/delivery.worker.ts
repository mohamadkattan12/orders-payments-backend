import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';
import { DeliveryService } from './delivery.service.js';
import { connection, QUEUE } from './dispatcher.js';

/** The BullMQ consumer. Started by the worker process (and by tests), not by the HTTP API. */
@Injectable()
export class DeliveryWorker implements OnModuleDestroy {
  private readonly log = new Logger('DeliveryWorker');
  private worker?: Worker;

  constructor(private readonly deliveries: DeliveryService) {}

  start(concurrency = 10): void {
    if (this.worker) return;
    this.worker = new Worker(
      QUEUE,
      async (job) =>
        this.deliveries.attempt(
          (job.data as { deliveryId: string }).deliveryId,
        ),
      { connection: connection(), concurrency },
    );
    this.worker.on('failed', (job, error) =>
      this.log.error(`job ${job?.id}: ${error.message}`),
    );
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    this.worker = undefined;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }
}
