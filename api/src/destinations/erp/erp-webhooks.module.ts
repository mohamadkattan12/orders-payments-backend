import { Module } from '@nestjs/common';
import { WebhooksModule } from '../../webhooks/webhooks.module.js';
import { ErpWebhooksController } from './erp-webhooks.controller.js';

/** HTTP only: the worker loads ErpModule (outbound) without this controller. */
@Module({
  imports: [WebhooksModule],
  controllers: [ErpWebhooksController],
})
export class ErpWebhooksModule {}
