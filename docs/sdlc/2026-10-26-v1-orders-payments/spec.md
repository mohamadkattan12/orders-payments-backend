# Spec: Orders and payments backend for an online store (v1)

From: intent.md (ce05b8f) · Status: draft
Skills applied: sdlc, nestjs-patterns, prisma-patterns, database-migrations, redis-patterns,
security-review @ ~/.claude 2bc6be4
Produced by: `/sdlc` stage 2 for portfolio project #3, after the intent was accepted

## Flagged concerns
Each needs Mohamad's decision before planning; the proposed answer is in bold.
1. **Carts.** The intent says "carts". A server-side cart adds state that proves nothing about
   reliability. **Proposed: no cart table; checkout takes the line items (the cart lives in the
   client), and stock is reserved at checkout.**
2. **"Exactly once".** Networks only give at-least-once delivery. **Proposed: the guarantee is
   "exactly once in effect": every message may be delivered more than once, and every receiver
   (our webhooks and the three fake systems) deduplicates by an idempotency key or event id. The
   README says this in these words.** Real partners that don't accept idempotency keys need a
   business-key check on our side too; v1 also records each external reference (shipment id,
   invoice clearance id) and skips the call when it already exists.
3. **The fakes are ours.** Their deduplication is code we wrote, so a test passing against them
   doesn't prove a real courier dedupes. **Proposed: fakes enforce idempotency keys like Stripe
   does, our side never relies on it alone (concern 2), and the README says so.**
4. **Prisma 7 vs 8.** npm `latest` for `prisma` is an 8.0 release candidate. **Proposed: pin
   `prisma`/`@prisma/client` 7.10.1, as in project #2.**
5. **Load test in CI.** 200 concurrent checkouts with k6 takes Docker and time. **Proposed: k6 runs
   locally (`docker compose run k6`) and its report goes in the README; CI runs a smaller
   concurrency e2e test (50 parallel checkouts on 10 units).**
6. **Redis loses jobs.** If Redis restarts without persistence, queued jobs vanish after the
   outbox marked them published. **Proposed: Redis runs with AOF on (`appendonly yes`,
   `maxmemory-policy noeviction`), and a sweeper re-enqueues deliveries still `pending` after
   5 minutes, so a wiped Redis delays delivery but never loses it.**
7. **Timeouts.** **Proposed: a checkout holds stock for 15 minutes; a payment still pending after
   2 minutes is reconciled by asking the gateway (covers a lost webhook).**
8. **Admin access.** **Proposed: admin endpoints and the admin page require an `X-Admin-Key`
   (env var, dev default in `.env.example`); store endpoints are public and rate-limited; an order
   is read by its unguessable UUID.**

## Requirements
**Catalog and checkout**
1. `GET /products` lists products (SKU, Arabic and English names, VAT-inclusive price in halalas,
   available stock). Seeded with ~12 fictional products, some with low stock.
2. `POST /orders` (header `Idempotency-Key` required) takes customer details (name, phone, city)
   and line items, validates them, and in one transaction reserves stock with a conditional
   decrement (`stock >= qty`) for every line, creates the order (`pending_payment`, expires in
   15 min) and writes an `order.created` outbox event. Any line short of stock → 409
   `out_of_stock` naming the SKU, nothing reserved.
3. Totals: price includes 15% VAT. Per line, VAT = round-half-up(line total × 15 / 115) in halalas;
   order subtotal, VAT and total are sums of the lines. Unit tests cover rounding.
4. Idempotency: the same key and the same body returns the stored response (same status, same
   body) without side effects; the same key with a different body → 422; two concurrent requests
   with one key create one order (the other waits or gets 409 `in_progress`). Keys are kept 24 h.

**Payments (fake gateway "FakePay")**
5. `POST /orders/:id/pay` (idempotency key required) with a test token (`tok_success`,
   `tok_decline`, `tok_timeout`, `tok_slow`) creates one payment at FakePay for the order total;
   only one non-failed payment per order. The order must be `pending_payment` and not expired.
6. FakePay answers asynchronously: `POST /webhooks/fakepay` receives `payment.succeeded`,
   `payment.failed`, `refund.succeeded`, signed with HMAC-SHA256 over `timestamp.body` (header
   `FakePay-Signature: t=…,v1=…`). Bad signature or timestamp older than 5 minutes → 401, nothing
   stored. Every webhook is stored once by event id; duplicates → 200, no effect.
7. Payment state only moves forward (`pending → succeeded | failed`, `succeeded → refunded`); a
   late `payment.failed` after `succeeded` is recorded and ignored.
8. On success: order → `paid`, outbox event `order.paid`, in the same transaction. On failure:
   order stays `pending_payment` (the customer may retry with a new payment) until it expires.
9. Reconciliation: a payment `pending` for more than 2 minutes is checked with
   `GET /payments/:id` at FakePay and settled like a webhook (same code path, same dedupe).
10. Expiry: an unpaid order past `expires_at` → `expired`, stock released, outbox `order.expired`.
    A payment that succeeds for an expired or cancelled order is refunded automatically and the
    order stays as it was.
11. `POST /orders/:id/cancel` (customer, idempotency key): a `pending_payment` order → `cancelled`,
    stock released. `POST /admin/orders/:id/refund` (admin, idempotency key): a `paid` order →
    full refund at FakePay; on `refund.succeeded` → `refunded`, outbox `order.refunded`. Stock is
    not restocked automatically (returns are out of scope).

**Event pipeline**
12. Every state change that others must hear about writes an outbox row in the same transaction.
    A relay (in the worker process) claims unpublished rows with `FOR UPDATE SKIP LOCKED`, adds one
    BullMQ job per destination with `jobId = <event id>:<destination>` (so a re-relay doesn't
    duplicate), records a `delivery` row per destination, and marks the event published.
13. Destinations and what they receive:
    - **ERP**: `order.paid` (sale), `order.refunded`; sends back `stock.adjusted` webhooks
      (`+/- qty` per SKU with an adjustment id, deduped, applied as deltas, signed like FakePay).
    - **Courier**: `order.paid` → create a shipment (stores the courier's shipment id); sends back
      `shipment.updated` webhooks (`created → picked_up → in_transit → delivered`), applied only
      if newer than the current status (out-of-order safe).
    - **Invoicing**: `order.paid` → create the order's invoice (sequential number, line VAT,
      totals, UUID) and submit it to the fake e-invoicing portal (stores its clearance id);
      `order.refunded` → a credit note referencing the invoice. One invoice and at most one credit
      note per order (unique constraints).
14. Every outgoing call sends `Idempotency-Key: <event id>:<destination>` and a 5 s timeout.
    Retries: 8 attempts, exponential backoff with jitter (1 s base, capped at 5 min). After the
    last attempt the delivery is `dead`; `POST /admin/deliveries/:id/replay` re-enqueues it.
15. A sweeper re-enqueues deliveries `pending` for more than 5 minutes (concern 6).

**Fake external systems** (one separate service, `fakes`, in Docker Compose)
16. FakePay, ERP, Courier and the e-invoicing portal each have a control endpoint
    `POST /control/:system` with mode `ok | down | slow | flaky (fail N then ok) | duplicate |
    out_of_order`. `duplicate` sends each webhook twice; `out_of_order` delays earlier webhooks
    behind later ones. Each fake dedupes requests by `Idempotency-Key` and exposes
    `GET /control/:system/ledger` (what it actually did: charges, refunds, shipments, invoices)
    so tests can count effects.

**Admin page** (Next.js, `/admin`, admin key entered once per session)
17. Lists orders (filter by status), an order's timeline (payments, webhooks, outbox events,
    deliveries with attempts and last error), dead letters with a Replay button, and the fake
    systems' current modes with buttons to change them.

**Proof**
18. Failure-injection e2e tests (CI, real Postgres + Redis + the fakes) for: duplicate and
    out-of-order payment webhooks; a lost webhook settled by reconciliation; a success after
    expiry auto-refunded; ERP down then recovering (delivered once); ERP down past all attempts →
    dead → replay → delivered once; the relay crashing after commit (outbox row present, relay
    restarted → delivered once); the relay publishing twice (one effect); duplicate courier
    tracking webhooks and out-of-order statuses; same idempotency key in parallel; 50 parallel
    checkouts on 10 units → exactly 10 orders. Each asserts the fakes' ledgers: one charge per
    paid order, one shipment, one invoice.
19. Load test: k6, 200 virtual users checking out and paying for a product with 50 units →
    exactly 50 paid orders, 150 `out_of_stock`, 0 duplicate charges in the FakePay ledger, stock
    never below 0; p50/p95 latency of checkout and pay in the README.
20. `docker compose up` from a fresh clone starts api, worker, fakes, admin web, Postgres and Redis
    with no keys; `/health/ready` reports database, Redis, migrations and seed.

## Design
**Repo layout:** `api/` (NestJS via `nest new`; one codebase, two entry points: `main.ts` = HTTP
API, `worker.ts` = relay, BullMQ consumers, sweeper, expiry and reconciliation schedulers),
`fakes/` (small NestJS app), `web/` (Next.js admin page via `create-next-app` + shadcn), `load/`
(k6 script), root `docker-compose.yml`, `docs/sdlc/`.

**Data model (Prisma 7.10.1, Postgres 17):**
- `products` (id, sku unique, name_ar, name_en, price_halalas, stock int CHECK stock >= 0)
- `orders` (id uuid, status enum `pending_payment | paid | cancelled | expired | refunded`,
  customer_name, customer_phone, city, subtotal/vat/total halalas, expires_at, version,
  timestamps) and `order_items` (order_id, product_id, qty, unit_price, line_total, line_vat)
- `payments` (id, order_id, provider_payment_id unique, status enum `pending | succeeded | failed |
  refunded`, amount, token, timestamps); partial unique index: one non-failed payment per order
- `refunds` (id, payment_id unique, provider_refund_id, status, amount)
- `idempotency_keys` (key, scope, request_hash, status `in_progress | done`, response_status,
  response_body, created_at; primary key (scope, key))
- `inbound_webhooks` (source, event_id, type, payload, received_at, processed_at; unique
  (source, event_id))
- `outbox_events` (id uuid, type, aggregate_id, payload, created_at, published_at; index on
  unpublished)
- `deliveries` (id, event_id, destination, status `pending | delivered | dead`, attempts,
  last_error, external_ref, updated_at; unique (event_id, destination))
- `shipments` (order_id unique, courier_shipment_id, status, status_seq) and `invoices` (id uuid,
  number unique from a sequence, order_id, kind `invoice | credit_note`, totals, clearance_id;
  unique (order_id, kind))

**API contracts:** JSON, `class-validator` DTOs with a global whitelist pipe; errors as
`{ statusCode, error, message }` with stable machine codes (`out_of_stock`, `order_expired`,
`idempotency_mismatch`, …). OpenAPI via `@nestjs/swagger` at `/docs`.

**Concurrency:** stock reservation and release are single conditional `UPDATE`s; order state
changes use `UPDATE … WHERE id = ? AND status = ?` (and `version`) so two workers can't both move
an order; webhook handling, reconciliation and expiry share one `settlePayment()` that runs in a
transaction and is safe to call twice.

**Ports (all on 127.0.0.1):** api 8100, fakes 8200, web 3100, Postgres 5436, Redis 6380 (chosen
not to clash with projects #1 and #2).

## Non-functional
- **Security:** webhook HMAC verified with a timing-safe compare and a 5-minute timestamp window;
  idempotency keys required on every money- or stock-changing call; admin key on admin routes;
  `@nestjs/throttler` on public routes; no secrets committed (dev-only defaults in
  `.env.example`, named as such); logs never contain tokens or full phone numbers.
- **Observability:** JSON logs with `orderId`, `eventId` and `deliveryId`; the admin page is the
  operator view; `/health/ready` checks Postgres, Redis, migrations and seed.
- **Performance:** measured, not promised: the README reports k6 p50/p95 for checkout and pay on a
  laptop.
- **Rollback:** local only; `docker compose down -v` resets everything.
- **CI** (GitHub Actions, from step 1): lint, format, typecheck, unit and e2e tests with Postgres
  and Redis services and the fakes app, web build.

## Carried-forward open questions
- None beyond the flagged concerns above.
