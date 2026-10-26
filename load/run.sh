#!/usr/bin/env bash
# Load test against the running compose stack: reset LOAD-50 to 50 units, run k6 (200 VUs),
# then check the invariants in Postgres (shop and FakePay's database).
# The api must run with a raised rate limit, e.g. THROTTLE_LIMIT=100000 docker compose up -d api
# (200 checkouts + 50 payments from one IP exceed the default 200 per 10 s).
# Usage: load/run.sh            (or: load/run.sh check-only, to re-check the last run)
set -euo pipefail
cd "$(dirname "$0")/.."

SKU=LOAD-50
UNITS=50
VUS=200
# Covers reconciliation (a payment pending 2 min is looked up/resubmitted; worker runs every 30 s).
DEADLINE_S=${DEADLINE_S:-240}
compose() { docker compose -f docker-compose.yml "$@"; }
sql() { compose exec -T db psql -U postgres -d "$1" -v ON_ERROR_STOP=1 -Atc "$2"; }
mkdir -p load/results

# Orders for LOAD-50 created by the last reset (paid or not).
RUN_ORDERS="SELECT o.id FROM orders o JOIN order_items i ON i.\"orderId\" = o.id
  WHERE i.sku = '$SKU' AND o.\"createdAt\" >= (SELECT \"createdAt\" FROM products WHERE sku = '$SKU')"

if [ "${1:-}" != check-only ]; then
  # A pending order from an aborted run would release its unit on expiry, mid-run.
  pending=$(sql shop "SELECT count(*) FROM orders o JOIN order_items i ON i.\"orderId\" = o.id
    WHERE i.sku = '$SKU' AND o.status = 'pending_payment'")
  if [ "$pending" != 0 ]; then
    echo "FAIL: $pending pending $SKU orders from an earlier run; wait 15 min for expiry" >&2
    exit 1
  fi
  # The product belongs to the load test, not the demo seed. createdAt marks the run start.
  sql shop "INSERT INTO products (id, sku, \"nameAr\", \"nameEn\", \"priceHalalas\", stock)
    VALUES (gen_random_uuid(), '$SKU', 'منتج اختبار الحمل', 'Load test item', 1000, $UNITS)
    ON CONFLICT (sku) DO UPDATE SET stock = $UNITS, \"createdAt\" = now()" >/dev/null
  echo "reset: $SKU stock = $(sql shop "SELECT stock FROM products WHERE sku = '$SKU'")"

  compose --profile load run --rm \
    -e SKU=$SKU -e UNITS=$UNITS -e VUS=$VUS -e RUN_ID="$(date +%s)" k6
fi

# Payments settle by webhook: wait for them with a deadline.
deadline=$((SECONDS + DEADLINE_S))
while :; do
  paid=$(sql shop "SELECT count(*) FROM orders WHERE status = 'paid' AND id IN ($RUN_ORDERS)")
  [ "$paid" -ge "$UNITS" ] || [ "$SECONDS" -ge "$deadline" ] && break
  sleep 1
done

orders=$(sql shop "SELECT count(*) FROM ($RUN_ORDERS) r")
payments=$(sql shop "SELECT count(*) FROM payments WHERE \"orderId\" IN ($RUN_ORDERS)")
refunds=$(sql shop "SELECT count(*) FROM refunds r JOIN payments p ON p.id = r.\"paymentId\"
  WHERE p.\"orderId\" IN ($RUN_ORDERS)")
stock=$(sql shop "SELECT stock FROM products WHERE sku = '$SKU'")
check=$(sql shop "SELECT count(*) FROM pg_constraint WHERE conrelid = 'products'::regclass
  AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%stock >= 0%'")
refs=$(sql shop "SELECT string_agg(quote_literal(id::text), ',') FROM payments
  WHERE \"orderId\" IN ($RUN_ORDERS)")
charges=$(sql fakes "SELECT count(*) || ' ' || count(DISTINCT \"merchantReference\") || ' '
  || count(*) FILTER (WHERE status = 'succeeded') FROM charges
  WHERE \"merchantReference\" IN (${refs:-''})")
read -r charge_count charge_refs charge_ok <<<"$charges"
out_of_stock=$(grep -o '"checkout409OutOfStock": [0-9]*' load/results/summary.json | grep -o '[0-9]*$')

status=0
expect() { # name actual expected
  if [ "$2" = "$3" ]; then echo "ok   $1 = $2"; else echo "FAIL $1 = $2 (expected $3)"; status=1; fi
}
expect "orders created" "$orders" "$UNITS"
expect "orders paid" "$paid" "$UNITS"
expect "out_of_stock responses (k6)" "$out_of_stock" "$((VUS - UNITS))"
expect "payments" "$payments" "$UNITS"
expect "FakePay charges" "$charge_count" "$UNITS"
expect "FakePay distinct merchant references" "$charge_refs" "$UNITS"
expect "FakePay succeeded charges" "$charge_ok" "$UNITS"
expect "refunds" "$refunds" 0
expect "stock left" "$stock" 0
expect "CHECK (stock >= 0) present" "$check" 1
exit $status
