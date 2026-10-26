import { Module } from '@nestjs/common';
import { FakepayClient } from './fakepay.client.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

@Module({
  controllers: [PaymentsController],
  providers: [FakepayClient, PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
