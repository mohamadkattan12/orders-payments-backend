# Plan: Orders and payments backend for an online store (v1)

From: spec.md (accepted 2026-10-26, with review amendments) · Status: draft
Worktree: main checkout · Branch: v1-orders-payments · PR: (none yet)

## Files that change
All new (empty repo):
- `api/` (`nest new api`): `src/catalog/` (products), `src/orders/` (checkout, cancel, expiry),
  `src/payments/` (pay, webhook, settle, reconcile, refunds), `src/idempotency/`,
  `src/outbox/` (relay, deliveries, sweeper, replay), `src/destinations/{erp,courier,invoicing}/`,
  `src/admin/`, `src/health/`, `src/common/` (money/VAT, clock, HMAC, config), `src/main.ts` (HTTP),
  `src/worker.ts` (relay + consumers + schedulers), `prisma/` (schema, migrations incl. hand-written
  CHECK, partial unique index and invoice sequence), `src/seed/`, `test/` (e2e + failure injection)
- `fakes/` (`nest new fakes`): FakePay, ERP, Courier, e-invoicing portal; `fakes` database;
  control/ledger endpoints; webhook sender with HMAC
- `web/` (`create-next-app` + shadcn): `/admin` pages (orders, order timeline, dead letters, fake
  modes)
- `load/checkout.js` (k6), `docker-compose.yml` (db, redis, api, worker, fakes, web; `k6` profile),
  `.github/workflows/ci.yml`, `.env.example`, `README.md`, `CLAUDE.md`, `REVIEW.md`

## Order of work
Steps 1–6 are the core and run sequentially in this session. Steps 7, 9 and 10 are independent
once step 6 is merged: the proposed **build workflow** runs them as 5 parallel agents (below).
1. **Scaffold + CI:** `nest new api`, `nest new fakes`, `create-next-app web`, shadcn init,
   `prisma init` (7.10.1), compose with Postgres 17 + Redis 8 (AOF, noeviction) on 127.0.0.1,
   `/health` + `/health/ready` (db, Redis, migrations, seed), CI (lint, format, typecheck, unit,
   e2e with Postgres + Redis services, web build).
2. **Schema + seed:** all tables from the spec + amendments (deliveries with attempts/lease/
   next_attempt_at/blocked, refunds unique per payment, stock adjustments with shortfall),
   CHECK `stock >= 0`, partial unique "one non-failed payment per order", invoice number
   sequence; 12 fictional products (3 with stock ≤ 5).
3. **Money, catalog, checkout, idempotency:** VAT per line (round half up) with unit tests;
   `GET /products`; `POST /orders` (bounds, duplicate SKU 400, conditional stock decrement, price
   snapshot, outbox `order.created`, 15-min expiry); idempotency service (scope + key, request hash,
   `in_progress` → 409, mismatch → 422, stored response, 24 h). e2e: 50 parallel checkouts on 10
   units → exactly 10; same key in parallel → one order.
4. **Fakes service:** persistence in its own `fakes` database; idempotency per request (effect +
   result in one transaction); deterministic modes per system (amendment 14); ledgers; control key;
   FakePay (create charge with merchant reference, get by reference, refund, signed webhooks incl.
   duplicate/out-of-order/lost), ERP (sale/refund receipt, `stock.adjusted` webhooks), Courier
   (create shipment, tracking webhooks), e-invoicing portal (submit → clearance id). Unit + e2e in
   `fakes/`.
5. **Payments:** pay = payment row first then FakePay call (amendment 1); webhook receiver (raw
   body HMAC, ±5 min, schema, business validation, inbox + effect + outbox atomic); one
   `settlePayment` with a locked order transition (amendment 3); cancel; expiry job; reconciliation
   job (pending > 2 min, lookup by our reference); `requestRefund` with refund intent + retry and
   reconciliation worker (amendment 4); auto-refund of extra/late charges (amendment 2). e2e incl.
   settle vs expiry, cancel vs settle, duplicate/out-of-order/lost webhooks, response lost.
6. **Outbox + delivery engine:** relay (claim, insert deliveries, mark published in one tx; enqueue
   after commit); BullMQ dispatch; consumer claim with lease; attempts/backoff in Postgres (8,
   jittered, 1 s → 5 min); conditional terminal updates; dead + replay; sweeper; per-order
   ordering with `blocked`; worker entry point. Destinations are stubs here. e2e incl. relay crash
   after commit, double publish, Redis flushed.
7. **Destination consumers** (workflow agents A–C, one each): ERP (sale/refund; inbound
   `stock.adjusted` with clamp + shortfall), Courier (shipment with stored reference; tracking
   applied only if newer), Invoicing (invoice/credit note numbering, line VAT, portal submit,
   clearance id). Each with its failure-mode e2e tests.
8. **Failure-injection suite:** every scenario in spec req 18 + amendment 14 in one e2e file set,
   asserting durable state and the fakes' ledgers, with 10 s settlement deadlines.
9. **Admin** (workflow agent D): admin API (orders list/filter, order timeline, deliveries, dead
   letters + replay, fake modes via proxy) and the Next.js `/admin` page; checked in Chrome.
10. **Load test** (workflow agent E): k6 script + compose profile; 200 VUs, product with 50 units;
    post-run invariant check script (paid = 50, out_of_stock = 150, FakePay charges = 50, stock 0).
11. **README** (results, architecture diagram, guarantees and their limits), CLAUDE.md, REVIEW.md.
12. **Verify + review + publish:** all checks, fresh clone with new volumes, verifier + reviewer
    subagents, fixes, then (with Mohamad's OK) public repo + PR, CI green.

### Proposed build workflow (needs Mohamad's go-ahead at step 7)
- **Build wave (5 agents, parallel, each in its own git worktree off the step-6 commit):**
  A ERP, B Courier, C Invoicing (step 7), D Admin API + page (step 9), E k6 load test (step 10).
  Each writes its tests first, runs `pnpm lint/typecheck/test/test:e2e`, and returns a branch.
  I merge them in order (A, B, C, then D, E), resolve conflicts (expected only in the module
  registry and seed), and re-run everything.
- **Review wave (after step 11, 3 agents + verification):** reviewers by focus (money/stock/state
  correctness; event delivery and failure handling; security), each finding re-checked by a second
  agent before I act on it. This replaces nothing: the verifier and reviewer subagents still run.
- Rough size: 8–11 agents total; no Claude API spending (session usage only).

## Risks
- **Riskiest: step 5–6** (money and delivery correctness under races). Mitigated by locked
  transitions, Postgres-owned delivery state, and e2e race tests against real Postgres + Redis
  before any destination code exists.
- **Flaky concurrency tests:** races asserted by invariants (counts, ledgers, CHECK), not timing;
  deterministic fake schedules; loops of 20 rounds for the race tests, as in project #2.
- **BullMQ + Postgres split-brain:** Postgres is authoritative (amendments 6–7); Redis only carries
  wake-ups, so a lost or duplicate job costs time, never correctness.
- **Raw-body HMAC in NestJS:** needs `rawBody: true` on the app; checked with a signature test
  before handlers are written.
- **Workflow merge conflicts:** agents share the step-6 baseline; each touches its own module plus
  one line in the module registry. Merge order fixed; full test run after each merge.
- **Port clashes:** 8100/8200/3200/5436/6380 avoid projects #1 and #2 (3100 was taken by a local Vite server).
- **Rejected:** Kafka (too heavy to prove the same pattern), a real gateway sandbox (decided: fake
  only), Temporal/workflow engines (hides the patterns this repo exists to show), server-side carts
  (concern 1).

## Proof
- `docker compose up -d` → `curl -s localhost:8100/health/ready` → `{"status":"ready", …}` with
  db, redis, migrations and seed ok; web :3200 → 200; all ports on 127.0.0.1.
- `cd api && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:e2e` → all
  pass, including every scenario in spec req 18 + amendment 14 (named tests, listed in the README).
- `cd fakes && pnpm test && pnpm test:e2e` → pass; `cd web && pnpm lint && pnpm typecheck && pnpm
  test && pnpm build` → pass.
- Load test: `docker compose --profile load run --rm k6` → 50 paid, 150 `out_of_stock`, 0 duplicate
  charges in the FakePay ledger, stock = 0; p50/p95 recorded in the README.
- Admin page in Chrome: an order's timeline shows payment, webhooks, outbox events and deliveries;
  switching ERP to `down` produces retries then a dead letter; Replay delivers it once.
- Fresh clone with new volumes starts ready without keys; no secrets or Claude attribution in
  history.

## Done checklist
1. [x] Code per order of work (steps 1–10)
2. [ ] Tests: money/VAT, idempotency, checkout races, payments races, delivery engine, destinations,
       failure-injection suite, fakes
3. [ ] Load test run + README with results (step 11)
4. [ ] Verification output pasted; verifier subagent PASS
5. [ ] Reviewer subagent: Important findings fixed and re-verified
6. [ ] Public repo created (approved), PR open, CI green, review comments addressed
7. [ ] Deployed per deploy tier: n/a (local Docker only)
8. [ ] Fresh-clone `docker compose up` check with new volumes

## Review
Spec-stage review (2026-10-26): independent Codex review, 14 points, all accepted (spec "Review
amendments").

## Departures from plan
- Step 1: web runs on **3200**, not 3100 (a local Vite dev server already holds 3100); spec ports
  otherwise unchanged. NestJS 12 generates Vitest + oxlint; added `typecheck`, `format:check`,
  `postinstall` scripts and `--passWithNoTests` until unit tests exist. pnpm 11 build decisions:
  Prisma allowed; esbuild, `@scarf/scarf` (swagger-ui telemetry) and `msgpackr-extract` (optional
  BullMQ native speed-up) declined. `prisma init` again downloaded Prisma agent-skill files into
  `.claude/`, `.agents/`, `.windsurf/` + `skills-lock.json` in both apps: removed. Generator pins
  `moduleFormat`/`importFileExtension` and `src/generated` is in `.dockerignore` (project #2's
  clean-clone lesson). Container healthcheck uses 127.0.0.1 (`localhost` resolves to IPv6 in
  Alpine while the API listens on IPv4). `/health/ready` checks Postgres and Redis now;
  migrations and seed join it in step 2. Redis runs with AOF and `noeviction`; a `fakes`
  database is created by an init script. e2e tests use `shop_test` / `fakes_test` and Redis db 1.
- Step 2: the init migration was generated with `--create-only`, then hand-edited (stock CHECK,
  positive qty/amount CHECKs, partial unique "one non-failed payment per order", unpublished-outbox
  partial index, invoice number sequence created before `invoices`). `prisma migrate dev` hung
  after applying it (interactive step); `migrate status` confirmed it applied. Use `migrate
  deploy` after hand edits. The seed upserts names/prices but never resets stock; the image runs
  migrate → seed → start. Deliveries carry `orderId` and `eventType` for per-order ordering.
- Step 3: idempotency for checkout runs **inside the business transaction** (key insert with
  `ON CONFLICT DO NOTHING`, effect, stored response, one commit). A concurrent request with the
  same key blocks on the uncommitted key row and then replays the stored response, so there is no
  visible `in_progress` state and no stuck key after a crash. Only successful responses are stored:
  a failed request changed nothing and may be retried with the same key (Stripe stores errors too;
  not needed here). Replays carry `Idempotent-Replayed: true`. Expired keys (24 h) are deleted
  lazily on reuse; a periodic cleanup joins the worker in step 6. Stock rows are locked in SKU
  order so opposite-order multi-line checkouts can't deadlock (tested). Rate limit: per IP,
  200 / 10 s by default (`THROTTLE_LIMIT`), health exempt. VAT rounding: an exact half-halala is
  impossible at 15/115, so "half up" never decides a result (comment in `money.ts`).
- Step 4 (fakes): test tokens are `tok_success` and `tok_decline` only. `tok_timeout`/`tok_slow`
  from spec req 5 are replaced by the deterministic FakePay modes `response_lost`, `slow` and
  `webhook_lost` (amendment 14). The charge outcome is final at creation (a failed charge never
  succeeds later); the API answers `pending` and the result arrives by webhook 200 ms later.
  Webhooks are queued in the same transaction as the effect (so a replay never re-sends) and a
  sender loop retries until the store answers 2xx (max 15 attempts, backoff to 10 s).
  `out_of_order` holds a system's webhooks until `POST /control/:system/flush`, which releases
  them newest first; courier tracking advances on command (`/control/courier/shipments/:id/
  advance`). Modes per system are restricted to amendment 14's list (400 otherwise). Webhook
  headers: `FakePay-Signature`, `ERP-Signature`, `Courier-Signature`, all `t=…,v1=…`. The portal
  also dedupes by invoice UUID (a business key), not only by idempotency key.
- Step 5 (payments): **index changed** (migration `one_pending_payment_per_order`): the init
  migration allowed one *non-failed* payment per order, which contradicts amendment 2 (a late
  extra success must exist until refunded). The database rule is now "one *pending* payment per
  order"; "retry only after every earlier attempt failed" is enforced in `pay()` under the order
  lock. Pay returns **202** with the pending payment (outcome by webhook; poll `GET /orders/:id`,
  which now lists payments and refunds). Reconciliation resubmits a payment FakePay never saw
  (same idempotency key) while the order is payable, else marks it `failed: not_submitted`; a
  later success is still applied and refunded. Expiry skips an order whose payment has been
  pending for less than 4 minutes, so reconciliation settles it first (fewer refunds). Cancel is
  refused (409 `payment_in_progress`) while a payment is pending. Webhook references that aren't
  UUIDs are rejected as unknown before any query (project #2's malformed-id lesson). The
  settle-vs-expiry race test first used reconciliation, whose HTTP lookup made expiry win all 30
  rounds; it now races the two transactions with jitter and asserts both outcomes occur. The
  api e2e suite starts the real fakes app (built from `../fakes`) on port 8299; CI installs it.
  Jobs (reconcile, refunds, expiry) are service methods here; the worker schedules them in step 6.
- Step 6 (delivery engine): BullMQ `Queue`/`Worker` used directly (`@nestjs/bullmq` removed:
  unused); BullMQ job ids can't contain `:`, so they are `<delivery id>_<tag>` with a tag per
  attempt/replay/sweep. The claim accepts deliveries due within 2 s (a delayed job can fire
  slightly early; without the tolerance it would wait for the sweeper). A refund delivery waiting
  for its sale is rescheduled every 2 s without using an attempt; behind a dead or blocked sale it
  becomes `blocked`, and the sale's delivery unblocks it. The worker (`dist/worker.js`, compose
  service `worker`) runs the consumer plus timers: relay 200 ms; sweep, reconcile, refunds and
  expiry every 30 s; idempotency-key cleanup hourly. Destinations each have a folder and module
  (`src/destinations/{erp,courier,invoicing}`) with a stub handler, so the parallel step-7 agents
  edit only their own folder. Live check in Docker: checkout → pay → webhook → paid → three
  deliveries delivered on attempt 1.
- Build wave (steps 7, 9, 10): run as the approved 5-agent workflow, one git worktree per agent
  off `180dbf9`. That commit adds `E2E_SLOT=n` (own test databases, ports 8199/8299 + n×1000 and
  Redis db 1 + n) so suites run side by side. Merged in order A–E; the only conflict was
  `app.module.ts`. Inbound ERP and courier webhooks each have their own module
  (`ErpWebhooksModule`, `CourierWebhookModule`) registered in the HTTP app only, because the worker
  loads the destination modules. ERP: a malformed event is 400 and not stored; an unknown SKU is
  422 and recorded; delta 0 is rejected; the refund receipt reads the order's lines. Courier: a
  status webhook that arrives before our shipments row exists gets a retryable 409
  `shipment_not_ready`; an unknown order is 422 and recorded; the sequence comes from the status
  name. Invoicing: the invoice row is committed before the portal call (retries reuse its number);
  sequence gaps are possible only on a lease-expiry race or a failed insert (documented). Admin:
  the timeline is grouped by kind rather than one merged list; the selected order is not put in
  the URL (amendment 13: the UUID is a capability); no web component tests (that would need
  3 dev dependencies); `/` redirects to `/admin`. Load: the LOAD-50 product is upserted by
  `load/run.sh` (not the seed); compose gets `name:`, `THROTTLE_LIMIT` passthrough and a `k6`
  service (profile `load`).
- Bugs found in the wave, fixed with the bugfix procedure (failing test committed first):
  (1) fakes released held webhooks ordered by `createdAt`, which ties within a millisecond, so
  the courier out-of-order test failed about 1 run in 12. Fix: a `seq` serial column. (2) The
  fakes read the system mode through the global pool while holding a transaction, so 10 or more
  concurrent charges exhausted the pool and FakePay stalled (load test pay p50 5.2 s, 41 of 50
  settled by reconciliation). Fix: read the mode through the open transaction. Now pay p50 is
  322 ms and a full load run takes 4 s. (3) The web font variable referenced itself (shadcn init),
  so the page fell back to a serif font.
- Checked in Chrome: key entry, orders list, timeline (payment, webhooks, outbox, deliveries,
  shipment, invoice); ERP `down` → 8 attempts → dead letter → ERP `ok` from the page → Replay →
  delivered, with exactly one sale in the ERP ledger. No console errors. The 375px check is not
  done yet (the window would not resize).
- Step 8: `api/test/failure-injection.e2e-spec.ts`, 15 scenarios end to end (HTTP app + worker
  relay/consumer + real fakes, modes injected through the fakes' control API). Each asserts durable
  state and every system's ledger (one charge, one ERP sale, one shipment, one invoice per paid
  order), with 10 s deadlines and a "no negative stock" check after each. Scenarios already proven
  in their own files are referenced, not repeated: parallel checkouts and same-key races
  (checkout), settle vs expiry (payments), refund behind a dead sale (delivery), webhook signature
  and validation (each destination). The cancel-vs-settle race from amendment 14 is tested as
  cancel vs pay (20 rounds), because cancel is refused while a payment is pending.
