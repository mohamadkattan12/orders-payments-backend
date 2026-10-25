import { createHmac } from 'node:crypto';
import { verifySignature } from './hmac.js';

const secret = 'dev-fakepay-secret';
const body = Buffer.from('{"id":"evt_1"}');
const sign = (t: number, b = body, s = secret) =>
  `t=${t},v1=${createHmac('sha256', s).update(`${t}.`).update(b).digest('hex')}`;
const now = 1_800_000_000_000;
const t = now / 1000;

describe('verifySignature', () => {
  it('accepts a correct signature inside the window', () => {
    expect(verifySignature(secret, sign(t), body, now)).toBe(true);
    expect(verifySignature(secret, sign(t - 299), body, now)).toBe(true);
    expect(verifySignature(secret, sign(t + 299), body, now)).toBe(true);
  });

  it.each([
    ['an old timestamp (replay)', () => sign(t - 301)],
    ['a future timestamp', () => sign(t + 301)],
    ['another secret', () => sign(t, body, 'other')],
    ['a changed body', () => sign(t, Buffer.from('{"id":"evt_2"}'))],
    ['garbage', () => 'nonsense'],
    ['a short v1', () => `t=${t},v1=abcd`],
  ])('rejects %s', (_, header) => {
    expect(verifySignature(secret, header(), body, now)).toBe(false);
  });

  it('rejects a missing header or body', () => {
    expect(verifySignature(secret, undefined, body, now)).toBe(false);
    expect(verifySignature(secret, sign(t), undefined, now)).toBe(false);
  });
});
