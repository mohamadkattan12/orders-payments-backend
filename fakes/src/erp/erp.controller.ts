import { plain } from '../common/plain.js';
import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsIn,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import { IdempotentService } from '../common/idempotent.service.js';
import { ModesService } from '../control/modes.service.js';

class LineDto {
  @IsString() sku!: string;
  @IsInt() @Min(1) qty!: number;
}

class RecordDto {
  @IsIn(['sale', 'refund']) kind!: 'sale' | 'refund';
  @IsString() orderId!: string;
  @IsInt() @Min(0) totalHalalas!: number;
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => LineDto)
  lines!: LineDto[];
}

/** The ERP books sales and refunds; it can also push stock corrections (control API). */
@Controller('erp')
export class ErpController {
  constructor(
    private readonly idempotent: IdempotentService,
    private readonly modes: ModesService,
  ) {}

  @Post('records')
  async record(
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: RecordDto,
    @Res() res: Response,
  ) {
    await this.modes.refuseIfFailing('erp');
    const result = await this.idempotent.run('erp', key, dto, async (tx) => {
      const row = await tx.erpRecord.create({
        data: { kind: dto.kind, orderId: dto.orderId, payload: plain(dto) },
      });
      return { status: 201, body: { id: row.id, kind: row.kind } };
    });
    await this.modes.respond('erp', res, result.status, result.body);
  }
}
