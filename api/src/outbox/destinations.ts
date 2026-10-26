import type { Delivery, Prisma } from '../generated/prisma/client.js';

/**
 * One external system. `deliver` must be safe to repeat (it sends Idempotency-Key
 * `<event id>:<destination>`); throwing means "try again later".
 */
export interface DestinationHandler {
  deliver(
    delivery: Delivery,
    payload: Prisma.JsonValue,
  ): Promise<{ externalRef?: string }>;
}

export const DESTINATION_HANDLERS = Symbol('DESTINATION_HANDLERS');
export type DestinationHandlers = Record<
  'erp' | 'courier' | 'invoicing',
  DestinationHandler
>;
