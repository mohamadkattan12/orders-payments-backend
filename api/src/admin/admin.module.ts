import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [PaymentsModule, OutboxModule], // OutboxModule: DeliveryService.replay
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
