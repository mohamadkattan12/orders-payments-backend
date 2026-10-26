import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { IdempotentService } from './common/idempotent.service.js';
import { ControlController } from './control/control.controller.js';
import { ModesService } from './control/modes.service.js';
import { CourierController } from './courier/courier.controller.js';
import { EinvoiceController } from './einvoice/einvoice.controller.js';
import { ErpController } from './erp/erp.controller.js';
import { FakepayController } from './fakepay/fakepay.controller.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SenderService } from './webhooks/sender.service.js';

/** The fake external systems: FakePay, ERP, Courier and the e-invoicing portal. */
@Module({
  imports: [PrismaModule, HealthModule],
  controllers: [
    FakepayController,
    ErpController,
    CourierController,
    EinvoiceController,
    ControlController,
  ],
  providers: [
    IdempotentService,
    ModesService,
    SenderService,
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
