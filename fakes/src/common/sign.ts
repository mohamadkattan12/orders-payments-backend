import { createHmac } from 'node:crypto';

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`, the header format the store verifies. */
export function signature(
  secret: string,
  body: string,
  t = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
