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

  /** Ready = Postgres and Redis reachable. */
  @Get('ready')
  async ready(): Promise<{ status: 'ready'; db: 'ok'; redis: 'ok' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      if ((await this.redis.ping()) !== 'PONG') throw new Error('redis');
      return { status: 'ready', db: 'ok', redis: 'ok' };
    } catch {
      throw new ServiceUnavailableException('dependencies not ready');
    }
  }
}
