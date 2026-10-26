import { Injectable } from '@nestjs/common';
import type { DestinationHandler } from '../../outbox/destinations.js';

/** Placeholder: the real Erp integration is built in plan step 7. */
@Injectable()
export class ErpHandler implements DestinationHandler {
  deliver(): Promise<{ externalRef?: string }> {
    return Promise.resolve({});
  }
}
