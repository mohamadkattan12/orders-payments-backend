import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../common/redis.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Ready = Postgres and Redis reachable, migrations applied, products seeded. */
  @Get('ready')
  async ready(): Promise<{
    status: 'ready';
    db: 'ok';
    redis: 'ok';
    migrations: number;
    products: number;
  }> {
    try {
      const [{ count }] = await this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
      const products = await this.prisma.product.count();
      if ((await this.redis.ping()) !== 'PONG') throw new Error('redis');
      if (Number(count) === 0 || products === 0)
        throw new Error('not migrated or not seeded');
      return {
        status: 'ready',
        db: 'ok',
        redis: 'ok',
        migrations: Number(count),
        products,
      };
    } catch {
      throw new ServiceUnavailableException('not ready');
    }
  }
}
