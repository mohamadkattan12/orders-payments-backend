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

const str = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;

interface Adjustment {
  adjustmentId: string;
  sku: string;
  delta: number;
}

/**
 * Applies one ERP stock correction. `stock` is sellable stock, so a removal larger than it clamps
 * at 0 and the rest is recorded as shortfall; orders already holding units keep them (amendment 11).
 */
async function applyAdjustment(tx: Tx, a: Adjustment): Promise<void> {
  // Locked first, so two events carrying the same adjustment id serialize here.
  const [product] = await tx.$queryRaw<{ id: string; stock: number }[]>`
    SELECT id, stock FROM products WHERE sku = ${a.sku} FOR UPDATE`;
  if (!product) throw new Rejection('unknown_sku');
  const stock = Math.max(product.stock + a.delta, 0);
  const applied = stock - product.stock;
  const created = await tx.stockAdjustment.createMany({
    data: {
      adjustmentId: a.adjustmentId,
      productId: product.id,
      delta: a.delta,
      applied,
      shortfall: applied - a.delta,
    },
    skipDuplicates: true,
  });
  if (created.count === 0) return; // already applied under another event id
  await tx.product.update({ where: { id: product.id }, data: { stock } });
}

@SkipThrottle()
@Controller('webhooks')
export class ErpWebhooksController {
  constructor(private readonly inbox: InboxService) {}

  /**
   * Malformed events are 400 and not stored (a retry can't fix them and they carry nothing to
   * apply); an unknown SKU is a business rejection: 422, recorded once (as for FakePay).
   */
  @Post('erp')
  @HttpCode(200)
  async erp(
    @Req() req: RawBodyRequest<Request>,
    @Headers('erp-signature') signature: string | undefined,
  ) {
    if (!verifySignature(config.webhookSecret('erp'), signature, req.rawBody))
      throw apiError(401, 'invalid_signature', 'Bad or expired signature.');
    const e = req.body as Partial<InboundEvent> | null;
    const d = (e?.data ?? {}) as Record<string, unknown>;
    const adjustmentId = str(d.adjustmentId);
    const sku = str(d.sku);
    const delta = d.delta as number;
    if (
      !e ||
      !str(e.id) ||
      e.type !== 'stock.adjusted' ||
      !adjustmentId ||
      !sku ||
      !Number.isSafeInteger(delta) ||
      delta === 0
    )
      throw apiError(400, 'invalid_event', 'Malformed stock.adjusted event.');
    return this.inbox.handle('erp', e as InboundEvent, (tx) =>
      applyAdjustment(tx, { adjustmentId, sku, delta }),
    );
  }
}
