import { HttpException, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { System } from '../common/config.js';
import type { Tx } from '../common/idempotent.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type Mode =
  | 'ok'
  | 'down'
  | 'flaky'
  | 'slow'
  | 'response_lost'
  | 'webhook_lost'
  | 'duplicate'
  | 'out_of_order';

@Injectable()
export class ModesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Inside a transaction pass its client: a second pooled query there can exhaust the pool. */
  async get(system: System, db: Tx = this.prisma) {
    return (
      (await db.systemMode.findUnique({ where: { system } })) ?? {
        system,
        mode: 'ok' as Mode,
        failCount: 0,
        delayMs: 0,
      }
    );
  }

  set(system: System, mode: Mode, failCount = 0, delayMs = 0) {
    const data = { mode, failCount, delayMs };
    return this.prisma.systemMode.upsert({
      where: { system },
      create: { system, ...data },
      update: data,
    });
  }

  /** Before any effect: `down` and `flaky` (while failures remain) answer 503 and do nothing. */
  async refuseIfFailing(system: System): Promise<void> {
    const { mode } = await this.get(system);
    if (mode === 'down') throw new HttpException({ error: 'unavailable' }, 503);
    if (mode === 'flaky') {
      // Atomic decrement: exactly failCount requests fail, even when they arrive together.
      const failed = await this.prisma.systemMode.updateMany({
        where: { system, mode: 'flaky', failCount: { gt: 0 } },
        data: { failCount: { decrement: 1 } },
      });
      if (failed.count) throw new HttpException({ error: 'unavailable' }, 503);
    }
  }

  /** After the effect committed: `slow` delays the answer; `response_lost` drops the connection. */
  async respond(
    system: System,
    res: Response,
    status: number,
    body: unknown,
  ): Promise<void> {
    const { mode, delayMs } = await this.get(system);
    if (mode === 'slow') await new Promise((r) => setTimeout(r, delayMs));
    if (mode === 'response_lost') {
      res.socket?.destroy();
      return;
    }
    res.status(status).json(body);
  }
}
