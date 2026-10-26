// Dev-only defaults so `docker compose up` works without setup; override them anywhere real.
// `||`, not `??`: an empty variable must never mean "no key".
export const config = {
  fakesUrl: () => process.env.FAKES_URL || 'http://localhost:8200',
  adminKey: () => process.env.ADMIN_KEY || 'dev-admin-key',
  fakesControlKey: () => process.env.FAKES_CONTROL_KEY || 'dev-control-key',
  webhookSecret: (source: 'fakepay' | 'erp' | 'courier') =>
    process.env[`${source.toUpperCase()}_WEBHOOK_SECRET`] ||
    `dev-${source}-secret`,
};

export const CALL_TIMEOUT_MS = 5000;
export const RECONCILE_AFTER_MS = 2 * 60 * 1000; // a payment pending this long is looked up
export const WEBHOOK_TOLERANCE_S = 5 * 60; // signed timestamps must be within ±5 minutes
