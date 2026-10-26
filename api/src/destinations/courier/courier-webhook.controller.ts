import {
  Controller,
  Headers,
  HttpCode,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { config } from '../../common/config.js';
import { apiError } from '../../common/errors.js';
import { verifySignature } from '../../common/hmac.js';
import type { Tx } from '../../idempotency/idempotency.service.js';
import { Rejection } from '../../payments/payments.service.js';
import {
  type InboundEvent,
  InboxService,
} from '../../webhooks/inbox.service.js';

// Position in this list is the status sequence: an update applies only if it moves forward.
const STATUSES = ['created', 'picked_up', 'in_transit', 'delivered'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;

interface Update {
  shipmentId: string;
  orderId: string;
  status: string;
}

/** Tracking updates from the courier: `shipment.updated`, signed like FakePay's webhooks. */
@SkipThrottle()
@Controller('webhooks')
export class CourierWebhookController {
  constructor(private readonly inbox: InboxService) {}

  @Post('courier')
  @HttpCode(200)
  async courier(
    @Req() req: RawBodyRequest<Request>,
    @Headers('courier-signature') signature: string | undefined,
  ) {
    if (
      !verifySignature(config.webhookSecret('courier'), signature, req.rawBody)
    )
      throw apiError(401, 'invalid_signature', 'Bad or expired signature.');
    const e = req.body as Partial<InboundEvent> | null;
    const d = (e?.data ?? {}) as Record<string, unknown>;
    if (
      !str(e?.id) ||
      e?.type !== 'shipment.updated' ||
      !str(d.shipmentId) ||
      !str(d.orderId) ||
      !STATUSES.includes(String(d.status))
    )
      throw apiError(400, 'invalid_event', 'Malformed event.');
    const update = d as unknown as Update;
    return this.inbox.handle('courier', e as InboundEvent, (tx) =>
      this.apply(tx, update),
    );
  }

  private async apply(tx: Tx, u: Update): Promise<void> {
    const seq = STATUSES.indexOf(u.status) + 1;
    const shipment = await tx.shipment.findUnique({
      where: { courierShipmentId: u.shipmentId },
    });
    if (!shipment) {
      const order = UUID.test(u.orderId)
        ? await tx.order.findUnique({ where: { id: u.orderId } })
        : null;
      // Only paid orders get shipments (a refunded one was paid first).
      if (!order || !['paid', 'refunded'].includes(order.status))
        throw new Rejection('unknown_shipment');
      // The courier can call before our create call has stored its answer: not stored, so it retries.
      throw apiError(
        409,
        'shipment_not_ready',
        'Shipment not recorded yet; retry.',
      );
    }
    if (shipment.orderId !== u.orderId)
      throw new Rejection('shipment_order_mismatch');
    // Conditional, so an older or repeated status is recorded in the inbox but changes nothing.
    await tx.shipment.updateMany({
      where: { orderId: shipment.orderId, statusSeq: { lt: seq } },
      data: { status: u.status, statusSeq: seq },
    });
  }
}
