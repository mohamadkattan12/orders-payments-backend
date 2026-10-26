import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { DeliveryStatus, OrderStatus } from '../generated/prisma/client.js';

export const FAKE_SYSTEMS = ['fakepay', 'erp', 'courier', 'einvoice'] as const;
// Every mode the fakes know; which system accepts which is the fakes' rule (they answer 400).
const MODES = [
  'ok',
  'down',
  'flaky',
  'slow',
  'response_lost',
  'webhook_lost',
  'duplicate',
  'out_of_order',
];

export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

export class OrdersQuery extends PageQuery {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}

export class DeliveriesQuery extends PageQuery {
  @IsOptional()
  @IsEnum(DeliveryStatus)
  status?: DeliveryStatus;
}

export class ModeDto {
  @IsIn(MODES)
  mode!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  failCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60_000)
  delayMs?: number;
}
