import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  HttpException,
  Injectable,
  Param,
  ParseEnumPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  config,
  SYSTEMS,
  type System,
  type WebhookSystem,
} from '../common/config.js';
import { newId } from '../common/ids.js';
import { STATUSES } from '../courier/courier.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SenderService } from '../webhooks/sender.service.js';
import { type Mode, ModesService } from './modes.service.js';

const MODES: Mode[] = [
  'ok',
  'down',
  'flaky',
  'slow',
  'response_lost',
  'webhook_lost',
  'duplicate',
  'out_of_order',
];
// Only the failures each system can really have (spec amendment 14).
const ALLOWED: Record<System, Mode[]> = {
  fakepay: [
    'ok',
    'down',
    'response_lost',
    'webhook_lost',
    'duplicate',
    'out_of_order',
    'slow',
  ],
  erp: ['ok', 'down', 'flaky', 'duplicate'],
  courier: ['ok', 'flaky', 'duplicate', 'out_of_order'],
  einvoice: ['ok', 'down', 'flaky'],
};

@Injectable()
class ControlKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const given = Buffer.from(
      String(
        context.switchToHttp().getRequest<Request>().header('x-control-key') ??
          '',
      ),
    );
    const expected = Buffer.from(config.controlKey());
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new HttpException({ error: 'forbidden' }, 403);
    return true;
  }
}

class ModeDto {
  @IsIn(MODES) mode!: Mode;
  @IsOptional() @IsInt() @Min(0) @Max(100) failCount?: number;
  @IsOptional() @IsInt() @Min(0) @Max(60_000) delayMs?: number;
}

class AdjustDto {
  @IsString() sku!: string;
  @IsInt() @Min(-10_000) @Max(10_000) delta!: number;
}

class AdvanceDto {
  @IsIn(STATUSES) to!: (typeof STATUSES)[number];
}

/** Test and demo controls. Protected by FAKES_CONTROL_KEY. */
@UseGuards(ControlKeyGuard)
@Controller('control')
export class ControlController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly modes: ModesService,
    private readonly sender: SenderService,
  ) {}

  @Get()
  async all() {
    return Promise.all(SYSTEMS.map((s) => this.modes.get(s)));
  }

  /** Wipe every fake's state (tests, demo reset). */
  @Post('reset')
  @HttpCode(200)
  async reset() {
    await this.prisma.$executeRawUnsafe(
      'TRUNCATE idempotent_requests, system_modes, gateway_refunds, charges, erp_records, courier_shipments, portal_invoices, outgoing_webhooks',
    );
    return { reset: true };
  }

  /** The ERP corrects a stock level (e.g. after a count) and tells the store by webhook. */
  @Post('erp/adjust')
  @HttpCode(200)
  async adjust(@Body() dto: AdjustDto) {
    const eventId = await this.prisma.$transaction((tx) =>
      this.sender.emit(tx, 'erp', '/webhooks/erp', 'stock.adjusted', {
        adjustmentId: newId('adj'),
        sku: dto.sku,
        delta: dto.delta,
      }),
    );
    return { eventId };
  }

  /** Move a shipment forward; each step is one tracking webhook, sent in order unless out_of_order. */
  @Post('courier/shipments/:id/advance')
  @HttpCode(200)
  async advance(@Param('id') id: string, @Body() dto: AdvanceDto) {
    return this.prisma.$transaction(async (tx) => {
      const shipment = await tx.courierShipment.findUnique({ where: { id } });
      if (!shipment) throw new HttpException({ error: 'not_found' }, 404);
      const target = STATUSES.indexOf(dto.to) + 1;
      for (let seq = shipment.seq + 1; seq <= target; seq++)
        await this.sender.emit(
          tx,
          'courier',
          '/webhooks/courier',
          'shipment.updated',
          {
            shipmentId: id,
            orderId: shipment.orderId,
            status: STATUSES[seq - 1],
            seq,
          },
        );
      await tx.courierShipment.update({
        where: { id },
        data: {
          seq: Math.max(shipment.seq, target),
          status: STATUSES[Math.max(shipment.seq, target) - 1],
        },
      });
      return {
        shipmentId: id,
        status: STATUSES[Math.max(shipment.seq, target) - 1],
      };
    });
  }

  @Post(':system/flush')
  @HttpCode(200)
  async flush(
    @Param('system', new ParseEnumPipe(['fakepay', 'erp', 'courier']))
    system: WebhookSystem,
  ) {
    return { released: await this.sender.flush(system) };
  }

  @Get(':system/ledger')
  async ledger(@Param('system', new ParseEnumPipe(SYSTEMS)) system: System) {
    const webhooks = await this.prisma.outgoingWebhook.findMany({
      where: { system },
      orderBy: { createdAt: 'asc' },
      select: {
        eventId: true,
        body: true,
        sentAt: true,
        attempts: true,
        lastError: true,
      },
    });
    switch (system) {
      case 'fakepay':
        return {
          charges: await this.prisma.charge.findMany({
            orderBy: { createdAt: 'asc' },
          }),
          refunds: await this.prisma.gatewayRefund.findMany({
            orderBy: { createdAt: 'asc' },
          }),
          webhooks,
        };
      case 'erp':
        return {
          records: await this.prisma.erpRecord.findMany({
            orderBy: { createdAt: 'asc' },
          }),
          webhooks,
        };
      case 'courier':
        return {
          shipments: await this.prisma.courierShipment.findMany({
            orderBy: { createdAt: 'asc' },
          }),
          webhooks,
        };
      case 'einvoice':
        return {
          invoices: await this.prisma.portalInvoice.findMany({
            orderBy: { createdAt: 'asc' },
          }),
        };
    }
  }

  @Get(':system')
  mode(@Param('system', new ParseEnumPipe(SYSTEMS)) system: System) {
    return this.modes.get(system);
  }

  @Post(':system')
  @HttpCode(200)
  setMode(
    @Param('system', new ParseEnumPipe(SYSTEMS)) system: System,
    @Body() dto: ModeDto,
  ) {
    if (!ALLOWED[system].includes(dto.mode))
      throw new HttpException(
        {
          error: 'mode_not_supported',
          message: `${system} supports: ${ALLOWED[system].join(', ')}`,
        },
        400,
      );
    return this.modes.set(
      system,
      dto.mode,
      dto.failCount ?? 0,
      dto.delayMs ?? 0,
    );
  }
}
