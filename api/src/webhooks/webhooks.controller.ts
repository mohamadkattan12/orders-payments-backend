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
import { config } from '../common/config.js';
import { apiError } from '../common/errors.js';
import { verifySignature } from '../common/hmac.js';
import { PaymentsService } from '../payments/payments.service.js';
import { type InboundEvent, InboxService } from './inbox.service.js';

const str = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;
const int = (v: unknown) =>
  Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null;

/** Parse a signed event; anything malformed is 400 (after the signature check, so not stored). */
function parseEvent(body: unknown, types: string[]): InboundEvent {
  const e = body as Partial<InboundEvent> | null;
  if (
    !e ||
    !str(e.id) ||
    !types.includes(String(e.type)) ||
    typeof e.data !== 'object' ||
    !e.data
  )
    throw apiError(400, 'invalid_event', 'Malformed event.');
  return e as InboundEvent;
}

@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly inbox: InboxService,
    private readonly payments: PaymentsService,
  ) {}

  @Post('fakepay')
  @HttpCode(200)
  async fakepay(
    @Req() req: RawBodyRequest<Request>,
    @Headers('fakepay-signature') signature: string | undefined,
  ) {
    if (
      !verifySignature(config.webhookSecret('fakepay'), signature, req.rawBody)
    )
      throw apiError(401, 'invalid_signature', 'Bad or expired signature.');
    const event = parseEvent(req.body, [
      'payment.succeeded',
      'payment.failed',
      'refund.succeeded',
    ]);
    const d = event.data;
    const ref = str(d.merchantReference);
    const providerId = str(d.id);
    const amount = int(d.amountHalalas);
    if (!ref || !providerId || !amount)
      throw apiError(400, 'invalid_event', 'Missing reference, id or amount.');
    if (d.currency !== undefined && d.currency !== 'SAR')
      throw apiError(400, 'invalid_event', 'Only SAR is accepted.');
    return this.inbox.handle('fakepay', event, (tx) =>
      event.type === 'refund.succeeded'
        ? this.payments.settleRefund(tx, {
            refundId: ref,
            providerRefundId: providerId,
            amountHalalas: amount,
          })
        : this.payments.settlePayment(tx, {
            paymentId: ref,
            providerPaymentId: providerId,
            status: event.type === 'payment.succeeded' ? 'succeeded' : 'failed',
            amountHalalas: amount,
            failureReason: str(d.failureReason),
          }),
    );
  }
}
