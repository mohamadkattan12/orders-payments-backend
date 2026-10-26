import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { PaymentsService } from '../payments/payments.service.js';
import { AdminKeyGuard } from './admin-key.guard.js';
import {
  DeliveriesQuery,
  FAKE_SYSTEMS,
  ModeDto,
  OrdersQuery,
  PageQuery,
} from './admin.dto.js';
import { AdminService } from './admin.service.js';

@UseGuards(AdminKeyGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly admin: AdminService,
  ) {}

  /** Newest first, optionally one status. */
  @Get('orders')
  orders(@Query() query: OrdersQuery) {
    return this.admin.orders(query);
  }

  @Get('orders/:id/timeline')
  timeline(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.timeline(id);
  }

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

  /** `?status=dead` lists the dead letters. */
  @Get('deliveries')
  deliveries(@Query() query: DeliveriesQuery) {
    return this.admin.deliveryList(query);
  }

  /** Re-runs a dead delivery from attempt 1. 202: the worker delivers it. */
  @Post('deliveries/:id/replay')
  @HttpCode(202)
  replay(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.replay(id);
  }

  @Get('stock-adjustments')
  stockAdjustments(@Query() query: PageQuery) {
    return this.admin.stockAdjustments(query);
  }

  @Get('fakes/modes')
  fakeModes() {
    return this.admin.fakeModes();
  }

  @Post('fakes/:system/mode')
  @HttpCode(200)
  setFakeMode(
    @Param('system', new ParseEnumPipe(FAKE_SYSTEMS)) system: string,
    @Body() dto: ModeDto,
  ) {
    return this.admin.setFakeMode(system, dto);
  }
}
