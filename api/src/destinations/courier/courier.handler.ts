import { Injectable } from '@nestjs/common';
import type { DestinationHandler } from '../../outbox/destinations.js';

/** Placeholder: the real Courier integration is built in plan step 7. */
@Injectable()
export class CourierHandler implements DestinationHandler {
  deliver(): Promise<{ externalRef?: string }> {
    return Promise.resolve({});
  }
}
