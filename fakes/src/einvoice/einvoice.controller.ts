import { plain } from '../common/plain.js';
import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import { IsIn, IsInt, IsString, IsUUID, Min } from 'class-validator';
import type { Response } from 'express';
import { newId } from '../common/ids.js';
import { IdempotentService } from '../common/idempotent.service.js';
import { ModesService } from '../control/modes.service.js';

class InvoiceDto {
  @IsUUID() invoiceUuid!: string;
  @IsInt() @Min(1) number!: number;
  @IsIn(['invoice', 'credit_note']) kind!: 'invoice' | 'credit_note';
  @IsString() orderId!: string;
  @IsInt() @Min(0) subtotalHalalas!: number;
  @IsInt() @Min(0) vatHalalas!: number;
  @IsInt() @Min(0) totalHalalas!: number;
}

/** A simplified e-invoicing portal (ZATCA-style clearance, not certified): returns a clearance id. */
@Controller('einvoice')
export class EinvoiceController {
  constructor(
    private readonly idempotent: IdempotentService,
    private readonly modes: ModesService,
  ) {}

  @Post('invoices')
  async submit(
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: InvoiceDto,
    @Res() res: Response,
  ) {
    await this.modes.refuseIfFailing('einvoice');
    const result = await this.idempotent.run(
      'einvoice',
      key,
      dto,
      async (tx) => {
        // The invoice UUID is the portal's business key: a resubmission returns the same clearance.
        const existing = await tx.portalInvoice.findUnique({
          where: { invoiceUuid: dto.invoiceUuid },
        });
        const invoice =
          existing ??
          (await tx.portalInvoice.create({
            data: {
              clearanceId: newId('clr'),
              invoiceUuid: dto.invoiceUuid,
              kind: dto.kind,
              orderId: dto.orderId,
              payload: plain(dto),
            },
          }));
        return { status: 201, body: { clearanceId: invoice.clearanceId } };
      },
    );
    await this.modes.respond('einvoice', res, result.status, result.body);
  }
}
