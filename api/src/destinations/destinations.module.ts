import { Module } from '@nestjs/common';
import {
  DESTINATION_HANDLERS,
  type DestinationHandlers,
} from '../outbox/destinations.js';
import { CourierHandler } from './courier/courier.handler.js';
import { CourierModule } from './courier/courier.module.js';
import { ErpHandler } from './erp/erp.handler.js';
import { ErpModule } from './erp/erp.module.js';
import { InvoicingHandler } from './invoicing/invoicing.handler.js';
import { InvoicingModule } from './invoicing/invoicing.module.js';

/** The three external systems; each lives in its own folder and module. */
@Module({
  imports: [ErpModule, CourierModule, InvoicingModule],
  providers: [
    {
      provide: DESTINATION_HANDLERS,
      inject: [ErpHandler, CourierHandler, InvoicingHandler],
      useFactory: (
        erp: ErpHandler,
        courier: CourierHandler,
        invoicing: InvoicingHandler,
      ): DestinationHandlers => ({
        erp,
        courier,
        invoicing,
      }),
    },
  ],
  exports: [DESTINATION_HANDLERS],
})
export class DestinationsModule {}
