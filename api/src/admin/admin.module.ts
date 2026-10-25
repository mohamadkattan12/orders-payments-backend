import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { AdminController } from './admin.controller.js';

@Module({
  imports: [PaymentsModule],
  controllers: [AdminController],
})
export class AdminModule {}
