import {
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { IsIn } from 'class-validator';
import type { Response } from 'express';
import { PaymentsService } from './payments.service.js';

class PayDto {
  @IsIn(['tok_success', 'tok_decline'])
  token!: string;
}

@Controller('orders')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** 202: the payment is accepted; its outcome arrives by webhook (read it on GET /orders/:id). */
  @Post(':id/pay')
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: PayDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.payments.pay(id, key, dto.token);
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
