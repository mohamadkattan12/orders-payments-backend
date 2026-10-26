import { Injectable } from '@nestjs/common';
import { CALL_TIMEOUT_MS, config } from '../../common/config.js';
import type { Delivery, Prisma } from '../../generated/prisma/client.js';
import type { DestinationHandler } from '../../outbox/destinations.js';
import { PrismaService } from '../../prisma/prisma.service.js';

interface PaidPayload {
  orderId: string;
  customer: { name: string; phone: string; city: string };
  items: { sku: string; qty: number }[];
}

/** order.paid → a shipment at the courier; tracking comes back by webhook (CourierWebhookController). */
@Injectable()
export class CourierHandler implements DestinationHandler {
  constructor(private readonly prisma: PrismaService) {}

  async deliver(
    delivery: Delivery,
    payload: Prisma.JsonValue,
  ): Promise<{ externalRef?: string }> {
    const order = payload as unknown as PaidPayload;
    const res = await fetch(`${config.fakesUrl()}/courier/shipments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The same key on every retry, so the courier returns the shipment it already made.
        'Idempotency-Key': `${delivery.eventId}:courier`,
      },
      body: JSON.stringify({
        orderId: order.orderId,
        recipient: order.customer,
        items: order.items.map(({ sku, qty }) => ({ sku, qty })),
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { shipmentId } = (await res.json()) as { shipmentId: string };
    // A repeated delivery finds the row already there and leaves its (maybe newer) status alone.
    await this.prisma.shipment.upsert({
      where: { orderId: order.orderId },
      create: {
        orderId: order.orderId,
        courierShipmentId: shipmentId,
        status: 'created',
        statusSeq: 1,
      },
      update: {},
    });
    return { externalRef: shipmentId };
  }
}
