import { backoffMs } from './routing.js';

describe('backoffMs', () => {
  it('doubles from the base with ±20% jitter, capped at 5 minutes', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const expected = Math.min(1000 * 2 ** (attempt - 1), 300_000);
      for (let i = 0; i < 50; i++) {
        const ms = backoffMs(attempt, 1000);
        expect(ms).toBeGreaterThanOrEqual(expected * 0.8);
        expect(ms).toBeLessThanOrEqual(expected * 1.2);
      }
    }
  });
});
