import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { CheckoutDto } from './orders.dto.js';
import { OrdersService } from './orders.service.js';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** Checkout. The order id is the customer's capability for reading, paying and cancelling it. */
  @Post()
  async checkout(
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CheckoutDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.idempotency.runInTransaction(
      'checkout',
      key,
      dto,
      async (tx) => ({
        status: 201,
        body: await this.orders.checkout(tx, dto),
      }),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Post(':id/cancel')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.idempotency.runInTransaction(
      `cancel:${id}`,
      key,
      {},
      async (tx) => ({
        status: 200,
        body: await this.orders.cancel(tx, id),
      }),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(id);
  }
}
