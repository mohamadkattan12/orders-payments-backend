import { Module } from '@nestjs/common';
import { InvoicingHandler } from './invoicing.handler.js';

@Module({
  providers: [InvoicingHandler],
  exports: [InvoicingHandler],
})
export class InvoicingModule {}
