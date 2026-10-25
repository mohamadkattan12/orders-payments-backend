import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { config, type WebhookSystem } from '../common/config.js';
import { newId } from '../common/ids.js';
import { signature } from '../common/sign.js';
import { ModesService } from '../control/modes.service.js';
import type { Tx } from '../common/idempotent.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const HELD = new Date('9999-01-01T00:00:00Z'); // out_of_order: held until /control/:system/flush
const MAX_ATTEMPTS = 15;

/** Sends webhooks to the store and retries until it answers 2xx, like a real provider. */
@Injectable()
export class SenderService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Webhooks');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly modes: ModesService,
  ) {}

  onModuleInit(): void {
    if (process.env.FAKES_SENDER !== 'off')
      this.timer = setInterval(() => void this.sendDue(), 100);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * Queue one event, shaped by the system's mode: lost, duplicated or held for reordering. Pass the
   * effect's transaction so the event exists exactly when the effect does.
   */
  async emit(
    db: Tx,
    system: WebhookSystem,
    path: string,
    type: string,
    data: Record<string, unknown>,
    delayMs = 0,
  ): Promise<string | null> {
    const { mode } = await this.modes.get(system);
    const eventId = newId('evt');
    if (mode === 'webhook_lost') {
      this.log.warn(`${system} ${type} ${eventId} dropped (webhook_lost)`);
      return null;
    }
    const body = {
      id: eventId,
      type,
      createdAt: new Date().toISOString(),
      data,
    } as Prisma.InputJsonValue;
    const copies = mode === 'duplicate' ? 2 : 1;
    for (let i = 0; i < copies; i++)
      await db.outgoingWebhook.create({
        data: {
          system,
          eventId,
          path,
          body,
          sendAfter:
            mode === 'out_of_order'
              ? HELD
              : new Date(Date.now() + delayMs + i * 100),
        },
      });
    return eventId;
  }

  /** Release held webhooks newest first, 50 ms apart: a deterministic out-of-order delivery. */
  async flush(system: WebhookSystem): Promise<number> {
    const held = await this.prisma.outgoingWebhook.findMany({
      where: { system, sendAfter: HELD, sentAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const now = Date.now();
    for (const [i, w] of held.entries())
      await this.prisma.outgoingWebhook.update({
        where: { id: w.id },
        data: { sendAfter: new Date(now + i * 50) },
      });
    return held.length;
  }

  async sendDue(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = await this.prisma.outgoingWebhook.findMany({
        where: {
          sentAt: null,
          sendAfter: { lte: new Date() },
          attempts: { lt: MAX_ATTEMPTS },
        },
        orderBy: { sendAfter: 'asc' },
        take: 20,
      });
      for (const w of due) await this.send(w);
    } catch (error) {
      this.log.error(`send loop: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async send(w: {
    id: string;
    system: string;
    path: string;
    body: Prisma.JsonValue;
    attempts: number;
  }) {
    const body = JSON.stringify(w.body);
    let error: string | null = null;
    try {
      const res = await fetch(`${config.storeBaseUrl()}${w.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [`${w.system === 'fakepay' ? 'FakePay' : w.system === 'erp' ? 'ERP' : 'Courier'}-Signature`]:
            signature(config.secret(w.system as WebhookSystem), body),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
    const attempts = w.attempts + 1;
    await this.prisma.outgoingWebhook.update({
      where: { id: w.id },
      data: error
        ? {
            attempts,
            lastError: error,
            sendAfter: new Date(
              Date.now() + Math.min(200 * 2 ** attempts, 10_000),
            ),
          }
        : { attempts, sentAt: new Date(), lastError: null },
    });
  }
}
