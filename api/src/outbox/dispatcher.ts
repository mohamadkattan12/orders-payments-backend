import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { redisUrl } from '../common/redis.js';

export const QUEUE = 'deliveries';
export const connection = () => {
  const url = new URL(redisUrl());
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db: Number(url.pathname.slice(1) || 0),
    maxRetriesPerRequest: null,
  };
};

/**
 * Wake-ups for the delivery consumer. Redis only carries "look at delivery X"; Postgres owns the
 * delivery's state, so a lost or duplicated job costs time, never correctness.
 */
@Injectable()
export class Dispatcher implements OnModuleDestroy {
  readonly queue = new Queue(QUEUE, {
    connection: connection(),
    defaultJobOptions: {
      removeOnComplete: 1000,
      removeOnFail: 1000,
      attempts: 1,
    },
  });

  /** `tag` makes the job id unique per attempt, so a retry is never deduplicated away. */
  async enqueue(deliveryId: string, tag: string, delayMs = 0): Promise<void> {
    await this.queue.add(
      'deliver',
      { deliveryId },
      { jobId: `${deliveryId}_${tag}`, delay: delayMs },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
