import { config } from './config.js';

describe('config', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('treats an empty key or secret as unset, never as "no key"', () => {
    process.env.ADMIN_KEY = '';
    process.env.FAKES_CONTROL_KEY = '';
    process.env.ERP_WEBHOOK_SECRET = '';
    expect(config.adminKey()).toBe('dev-admin-key');
    expect(config.fakesControlKey()).toBe('dev-control-key');
    expect(config.webhookSecret('erp')).toBe('dev-erp-secret');
  });
});
