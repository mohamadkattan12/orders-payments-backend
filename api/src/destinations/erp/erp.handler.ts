import { Injectable } from '@nestjs/common';
import { CALL_TIMEOUT_MS, config } from '../../common/config.js';
import type { Delivery, Prisma } from '../../generated/prisma/client.js';
import type { DestinationHandler } from '../../outbox/destinations.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Books `order.paid` as a sale receipt and `order.refunded` as a refund receipt (a full refund, so
 * the same lines). The ERP dedupes by Idempotency-Key; any failure throws and the engine retries.
 */
@Injectable()
export class ErpHandler implements DestinationHandler {
  constructor(private readonly prisma: PrismaService) {}

  async deliver(
    delivery: Delivery,
    payload: Prisma.JsonValue,
  ): Promise<{ externalRef?: string }> {
    const p = payload as { totalHalalas?: number; amountHalalas?: number };
    const sale = delivery.eventType === 'order.paid';
    // The refund event carries no lines; the order's snapshot lines are the source for both.
    const items = await this.prisma.orderItem.findMany({
      where: { orderId: delivery.orderId },
      orderBy: { sku: 'asc' },
    });
    const res = await fetch(`${config.fakesUrl()}/erp/records`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${delivery.eventId}:${delivery.destination}`,
      },
      body: JSON.stringify({
        kind: sale ? 'sale' : 'refund',
        orderId: delivery.orderId,
        totalHalalas: sale ? p.totalHalalas : p.amountHalalas,
        lines: items.map((i) => ({ sku: i.sku, qty: i.qty })),
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const record = (await res.json()) as { id: string };
    return { externalRef: record.id };
  }
}
