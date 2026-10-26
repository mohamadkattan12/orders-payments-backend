import type { Destination } from '../generated/prisma/client.js';

/** Which systems hear about which event. Events with no destination are just marked published. */
export const ROUTES: Record<string, Destination[]> = {
  'order.paid': ['erp', 'courier', 'invoicing'],
  'order.refunded': ['erp', 'invoicing'],
  'order.created': [],
  'order.expired': [],
  'order.cancelled': [],
};

/** An event that must not reach a destination before its predecessor did (amendment 8). */
export const PREDECESSOR: Record<string, string> = {
  'order.refunded': 'order.paid',
};

export const MAX_ATTEMPTS = 8;
export const LEASE_MS = 60_000;

/** Exponential backoff with ±20% jitter: base, 2×base, 4×base … capped at 5 minutes. */
export function backoffMs(
  attempt: number,
  baseMs = Number(process.env.DELIVERY_BASE_MS ?? 1000),
): number {
  const raw = Math.min(baseMs * 2 ** (attempt - 1), 5 * 60_000);
  return Math.round(raw * (0.8 + Math.random() * 0.4));
}
