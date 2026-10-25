import {
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { PaymentsService } from '../payments/payments.service.js';
import { AdminKeyGuard } from './admin-key.guard.js';

@UseGuards(AdminKeyGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly payments: PaymentsService) {}

  /** Full refund of a paid order. 202: the result arrives by webhook. */
  @Post('orders/:id/refund')
  async refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.payments.refundOrder(id, key);
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
