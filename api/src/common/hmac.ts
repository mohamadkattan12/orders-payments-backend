import { createHmac, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_TOLERANCE_S } from './config.js';

/**
 * Verifies `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">` over the exact bytes received, with a
 * ±5-minute window against replays. Returns false for anything malformed.
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  rawBody: Buffer | undefined,
  nowMs = Date.now(),
): boolean {
  if (!header || !rawBody) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? ''))
    return false;
  if (Math.abs(nowMs / 1000 - t) > WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret)
    .update(`${t}.`)
    .update(rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}
