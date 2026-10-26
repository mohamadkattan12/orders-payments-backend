import { Module } from '@nestjs/common';
import { CourierHandler } from './courier.handler.js';

@Module({
  providers: [CourierHandler],
  exports: [CourierHandler],
})
export class CourierModule {}
