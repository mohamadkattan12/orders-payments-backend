import { plain } from '../common/plain.js';
import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import { newId } from '../common/ids.js';
import { IdempotentService } from '../common/idempotent.service.js';
import { ModesService } from '../control/modes.service.js';
import { SenderService } from '../webhooks/sender.service.js';

export const STATUSES = [
  'created',
  'picked_up',
  'in_transit',
  'delivered',
] as const;

class RecipientDto {
  @IsString() name!: string;
  @IsString() phone!: string;
  @IsString() city!: string;
}

class ItemDto {
  @IsString() sku!: string;
  @IsInt() @Min(1) qty!: number;
}

class ShipmentDto {
  @IsString() orderId!: string;
  @ValidateNested() @Type(() => RecipientDto) recipient!: RecipientDto;
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items!: ItemDto[];
}

/** A courier in the SMSA/Aramex style: create a shipment, then tracking updates by webhook. */
@Controller('courier')
export class CourierController {
  constructor(
    private readonly idempotent: IdempotentService,
    private readonly modes: ModesService,
    private readonly sender: SenderService,
  ) {}

  @Post('shipments')
  async create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: ShipmentDto,
    @Res() res: Response,
  ) {
    await this.modes.refuseIfFailing('courier');
    const result = await this.idempotent.run(
      'courier',
      key,
      dto,
      async (tx) => {
        const shipment = await tx.courierShipment.create({
          data: {
            id: newId('shp'),
            orderId: dto.orderId,
            status: 'created',
            seq: 1,
            payload: plain(dto),
          },
        });
        await this.sender.emit(
          tx,
          'courier',
          '/webhooks/courier',
          'shipment.updated',
          {
            shipmentId: shipment.id,
            orderId: dto.orderId,
            status: 'created',
            seq: 1,
          },
        );
        return {
          status: 201,
          body: { shipmentId: shipment.id, status: 'created' },
        };
      },
    );
    await this.modes.respond('courier', res, result.status, result.body);
  }
}
