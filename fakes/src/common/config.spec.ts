import { config } from './config.js';

describe('config', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('treats an empty key or secret as unset, never as "no key"', () => {
    process.env.FAKES_CONTROL_KEY = '';
    process.env.COURIER_WEBHOOK_SECRET = '';
    expect(config.controlKey()).toBe('dev-control-key');
    expect(config.secret('courier')).toBe('dev-courier-secret');
  });
});
