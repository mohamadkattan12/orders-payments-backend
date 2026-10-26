import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import type { Response } from 'express';
import { newId } from '../common/ids.js';
import { IdempotentService } from '../common/idempotent.service.js';
import { ModesService } from '../control/modes.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SenderService } from '../webhooks/sender.service.js';

/** Test tokens decide the outcome, like a gateway's sandbox cards. */
export const TOKENS = {
  tok_success: null,
  tok_decline: 'card_declined',
} as const;
const SETTLE_DELAY_MS = 200; // the result arrives by webhook shortly after the API call

class ChargeDto {
  @Type(() => Number) @IsInt() @Min(1) amountHalalas!: number;
  @IsIn(['SAR']) currency!: string;
  @IsIn(Object.keys(TOKENS)) token!: keyof typeof TOKENS;
  @IsString() @Length(1, 100) merchantReference!: string;
}

class RefundDto {
  @IsString() chargeId!: string;
  @Type(() => Number) @IsInt() @Min(1) amountHalalas!: number;
  @IsString() @Length(1, 100) merchantReference!: string;
}

type ChargeRow = {
  id: string;
  merchantReference: string;
  amountHalalas: number;
  currency: string;
  status: string;
  failureReason: string | null;
};
const view = (c: ChargeRow) => ({
  id: c.id,
  merchantReference: c.merchantReference,
  amountHalalas: c.amountHalalas,
  currency: c.currency,
  status: c.status,
  failureReason: c.failureReason,
});

@Controller('fakepay')
export class FakepayController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotent: IdempotentService,
    private readonly modes: ModesService,
    private readonly sender: SenderService,
  ) {}

  /** Creates the charge. Final at the provider: a failed charge never later succeeds. */
  @Post('charges')
  async charge(
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: ChargeDto,
    @Res() res: Response,
  ) {
    await this.modes.refuseIfFailing('fakepay');
    const result = await this.idempotent.run(
      'fakepay',
      key,
      dto,
      async (tx) => {
        const existing = await tx.charge.findUnique({
          where: { merchantReference: dto.merchantReference },
        });
        if (existing)
          throw new HttpException(
            { error: 'duplicate_merchant_reference' },
            409,
          );
        const failureReason = TOKENS[dto.token];
        const charge = await tx.charge.create({
          data: {
            id: newId('pay'),
            merchantReference: dto.merchantReference,
            amountHalalas: dto.amountHalalas,
            currency: dto.currency,
            token: dto.token,
            status: failureReason ? 'failed' : 'succeeded',
            failureReason,
          },
        });
        await this.sender.emit(
          tx,
          'fakepay',
          '/webhooks/fakepay',
          failureReason ? 'payment.failed' : 'payment.succeeded',
          view(charge),
          SETTLE_DELAY_MS,
        );
        // The API answers "pending"; the outcome comes by webhook (or by lookup).
        return { status: 201, body: { ...view(charge), status: 'pending' } };
      },
    );
    await this.modes.respond('fakepay', res, result.status, result.body);
  }

  /** Lookup by our reference: how the store reconciles a lost webhook or a lost response. */
  @Get('charges')
  async find(@Query('merchant_reference') merchantReference: string) {
    const charge = await this.prisma.charge.findUnique({
      where: { merchantReference },
    });
    if (!charge) throw new HttpException({ error: 'not_found' }, 404);
    return view(charge);
  }

  @Post('refunds')
  async refund(
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: RefundDto,
    @Res() res: Response,
  ) {
    await this.modes.refuseIfFailing('fakepay');
    const result = await this.idempotent.run(
      'fakepay',
      key,
      dto,
      async (tx) => {
        const charge = await tx.charge.findUnique({
          where: { id: dto.chargeId },
        });
        if (!charge || charge.status !== 'succeeded')
          throw new HttpException({ error: 'not_refundable' }, 409);
        if (dto.amountHalalas !== charge.amountHalalas)
          throw new HttpException({ error: 'full_refunds_only' }, 422);
        if (
          await tx.gatewayRefund.findFirst({ where: { chargeId: charge.id } })
        )
          throw new HttpException({ error: 'already_refunded' }, 409);
        const refund = await tx.gatewayRefund.create({
          data: {
            id: newId('ref'),
            chargeId: charge.id,
            merchantReference: dto.merchantReference,
            amountHalalas: dto.amountHalalas,
            status: 'succeeded',
          },
        });
        const data = {
          id: refund.id,
          chargeId: charge.id,
          merchantReference: refund.merchantReference,
          amountHalalas: refund.amountHalalas,
        };
        await this.sender.emit(
          tx,
          'fakepay',
          '/webhooks/fakepay',
          'refund.succeeded',
          { ...data, status: 'succeeded' },
          SETTLE_DELAY_MS,
        );
        return { status: 201, body: { ...data, status: 'pending' } };
      },
    );
    await this.modes.respond('fakepay', res, result.status, result.body);
  }

  @Get('refunds')
  async findRefund(@Query('merchant_reference') merchantReference: string) {
    const refund = await this.prisma.gatewayRefund.findUnique({
      where: { merchantReference },
    });
    if (!refund) throw new HttpException({ error: 'not_found' }, 404);
    return {
      id: refund.id,
      chargeId: refund.chargeId,
      merchantReference,
      amountHalalas: refund.amountHalalas,
      status: refund.status,
    };
  }
}
