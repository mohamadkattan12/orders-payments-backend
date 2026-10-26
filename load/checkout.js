// k6: 200 customers race for one product with 50 units, then the winners pay (spec req 19).
// Run with load/run.sh, which resets the product first and checks the invariants afterwards.
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const API = __ENV.API_URL || 'http://api:8100';
const SKU = __ENV.SKU || 'LOAD-50';
const VUS = Number(__ENV.VUS || 200);
const UNITS = Number(__ENV.UNITS || 50);
const RUN = __ENV.RUN_ID || String(Date.now()); // keeps keys unique across runs

const checkoutMs = new Trend('checkout_ms', true);
const payMs = new Trend('pay_ms', true);
const created = new Counter('checkout_201');
const outOfStock = new Counter('checkout_409_out_of_stock');
const paid = new Counter('pay_202');
const unexpected = new Counter('unexpected');

export const options = {
  scenarios: {
    race: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    unexpected: ['count==0'],
    checkout_201: [`count==${UNITS}`],
    checkout_409_out_of_stock: [`count==${VUS - UNITS}`],
    pay_202: [`count==${UNITS}`],
  },
  summaryTrendStats: ['min', 'med', 'p(95)', 'max'],
};

const post = (path, body, key) =>
  http.post(`${API}${path}`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
  });

const fail = (what, res) => {
  unexpected.add(1);
  console.error(`${what}: ${res.status} ${res.body}`);
};

export default function () {
  const vu = String(__VU).padStart(8, '0');
  const res = post(
    '/orders',
    {
      customer: { name: `Load ${__VU}`, phone: `+9665${vu}`, city: 'Riyadh' },
      items: [{ sku: SKU, qty: 1 }],
    },
    `load-${RUN}-checkout-${__VU}`,
  );
  checkoutMs.add(res.timings.duration);
  if (res.status === 409 && res.json('error') === 'out_of_stock') {
    outOfStock.add(1);
    return;
  }
  if (res.status !== 201) return fail('checkout', res);
  created.add(1);

  const pay = post(
    `/orders/${res.json('id')}/pay`,
    { token: 'tok_success' },
    `load-${RUN}-pay-${__VU}`,
  );
  payMs.add(pay.timings.duration);
  if (pay.status === 202) paid.add(1);
  else fail('pay', pay);
}

export function handleSummary(data) {
  const m = data.metrics;
  const n = (name) => (m[name] ? m[name].values.count : 0);
  const t = (name) => ({
    p50: m[name] ? m[name].values.med : null,
    p95: m[name] ? m[name].values['p(95)'] : null,
  });
  const report = {
    vus: VUS,
    units: UNITS,
    checkout201: n('checkout_201'),
    checkout409OutOfStock: n('checkout_409_out_of_stock'),
    pay202: n('pay_202'),
    unexpected: n('unexpected'),
    checkoutMs: t('checkout_ms'),
    payMs: t('pay_ms'),
  };
  return {
    stdout: `\n${JSON.stringify(report, null, 2)}\n`,
    '/load/results/summary.json': JSON.stringify(report, null, 2),
  };
}
