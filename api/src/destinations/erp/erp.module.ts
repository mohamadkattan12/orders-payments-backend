import { Module } from '@nestjs/common';
import { ErpHandler } from './erp.handler.js';

@Module({
  providers: [ErpHandler],
  exports: [ErpHandler],
})
export class ErpModule {}
