import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { InboxService } from './inbox.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [PaymentsModule],
  controllers: [WebhooksController],
  providers: [InboxService],
  exports: [InboxService],
})
export class WebhooksModule {}
