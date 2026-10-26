import { Module } from '@nestjs/common';
import { WebhooksModule } from '../../webhooks/webhooks.module.js';
import { CourierWebhookController } from './courier-webhook.controller.js';

/** HTTP side of the courier (tracking webhooks); the worker side is CourierModule. */
@Module({
  imports: [WebhooksModule],
  controllers: [CourierWebhookController],
})
export class CourierWebhookModule {}
