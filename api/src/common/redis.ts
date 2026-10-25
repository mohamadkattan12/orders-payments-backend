import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

export const redisUrl = () => process.env.REDIS_URL ?? 'redis://localhost:6380';

/** Shared connection for health checks and small Redis reads; BullMQ opens its own. */
@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor() {
    super(redisUrl(), { maxRetriesPerRequest: 1, lazyConnect: true });
  }

  async onModuleDestroy(): Promise<void> {
    this.disconnect();
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
