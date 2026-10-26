// Dev-only defaults so `docker compose up` works without setup; override them anywhere real.
// `||`, not `??`: an empty variable must never mean "no key".
export const config = {
  storeBaseUrl: () => process.env.STORE_WEBHOOK_BASE || 'http://localhost:8100',
  controlKey: () => process.env.FAKES_CONTROL_KEY || 'dev-control-key',
  secret: (system: 'fakepay' | 'erp' | 'courier') =>
    process.env[`${system.toUpperCase()}_WEBHOOK_SECRET`] ||
    `dev-${system}-secret`,
};

export const SYSTEMS = ['fakepay', 'erp', 'courier', 'einvoice'] as const;
export type System = (typeof SYSTEMS)[number];
export type WebhookSystem = 'fakepay' | 'erp' | 'courier';
