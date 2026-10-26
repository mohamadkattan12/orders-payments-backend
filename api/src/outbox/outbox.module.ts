import { Module } from '@nestjs/common';
import { DestinationsModule } from '../destinations/destinations.module.js';
import { DeliveryService } from './delivery.service.js';
import { DeliveryWorker } from './delivery.worker.js';
import { Dispatcher } from './dispatcher.js';
import { RelayService } from './relay.service.js';

@Module({
  imports: [DestinationsModule],
  providers: [Dispatcher, RelayService, DeliveryService, DeliveryWorker],
  exports: [Dispatcher, RelayService, DeliveryService, DeliveryWorker],
})
export class OutboxModule {}
