# Orders and payments backend

Public portfolio project: the order and payment core of a fictional store ("Mithal Store", SAR,
15% VAT included): checkout with stock reservation, a fake gateway answering by webhook, a
transactional outbox delivering to a fake ERP, courier and e-invoicing portal. Local Docker only;
admin routes need `X-Admin-Key`. Owner: mohamadkattan12.

## Commands
- Run: `docker compose up -d --build` → `curl -s localhost:8100/health/ready` → `{"status":"ready",…,"migrations":3,"products":12}`; admin http://localhost:3200/admin (`dev-admin-key`)
- API (in `api/`): `pnpm lint && pnpm format:check && pnpm typecheck` → exit 0; `pnpm test` → `18 passed`; `pnpm test:e2e` → `86 passed` (needs the compose `db` and `redis`; builds and starts `../fakes` on :8299)
- Fakes (in `fakes/`): same lint/format/typecheck; `pnpm test:e2e` → `15 passed`
- Web (in `web/`): `pnpm lint && pnpm typecheck && pnpm build` → exit 0, routes `/`, `/admin`
- Parallel e2e runs (worktrees, agents): prefix `E2E_SLOT=n` (own databases, ports +n×1000, Redis db 1+n). Never run two unslotted e2e suites at once.
- Load test: `THROTTLE_LIMIT=100000 docker compose up -d api && load/run.sh` → all invariant lines `ok`
- Migrations: `pnpm exec prisma migrate dev --name <slug> --create-only`, edit if needed, then `pnpm exec prisma migrate deploy` (`migrate dev` hangs after hand edits)

## Verifying your work
Run lint, format, types, unit and e2e tests in every package you touched and paste the output
tails; run the api e2e suite twice when touching anything concurrent. If a test fails, fix the
code, not the test. Admin page changes: check them in Chrome (orders, timeline, dead letter → Replay).

## Conventions
- Scaffold and add dependencies with commands (`nest g`, `pnpm add`, `pnpm dlx shadcn add`, `prisma migrate dev`), not hand-written boilerplate.
- Commits are authored by the owner only: no `Claude-Session` or `Co-Authored-By` trailers.
- Money is integer halalas, VAT-inclusive; VAT per line = round(line × 15/115) (`common/money.ts`); totals are sums of snapshotted lines. Business time (holds, expiry, reconciliation, refunds) is read through `Clock`; the delivery engine and idempotency-key TTL use the wall clock and Postgres `now()`.
- Every money- or stock-changing endpoint takes `Idempotency-Key`; key, effect and stored response commit in one transaction (`IdempotencyService.runInTransaction`).
- State changes others must hear about write an outbox row in the same transaction. Order transitions go through `lockOrder`; payments settle only via `settlePayment` (webhook, reconciliation and expiry share it).
- Delivery state lives in Postgres (`deliveries`); BullMQ jobs are wake-ups (job ids `<delivery id>_<tag>`, no `:`). A destination handler throws to mean "retry" and sends `Idempotency-Key: <event id>:<destination>`.
- Inbound webhooks: verify HMAC on the raw body first, then validate, then `InboxService.handle` (inbox row + effect + outbox atomic). Malformed → 400 not stored; business rejection → 422 recorded.
- Inside a transaction use its client for every query: a second pooled query can exhaust the pool under load.
- Inbound webhook controllers live in their own modules registered in `AppModule` only; the worker loads the destination modules and must not get HTTP controllers.
- Changes follow the `sdlc` skill (`docs/sdlc/<date>-<slug>/`), one commit per plan step, departures recorded in plan.md. Bugs: failing test committed first.

## Architecture
- `api/src/orders`, `payments`, `webhooks`, `idempotency`: checkout, pay/settle/reconcile/refund/expiry, inbox
- `api/src/outbox/`: relay, dispatcher (BullMQ), delivery engine (claim, lease, backoff, dead, replay, sweep, per-order ordering), routing
- `api/src/destinations/{erp,courier,invoicing}/`: handlers + inbound webhooks; `api/src/admin/`: admin API
- `api/src/worker.ts`: relay + consumer + timers; `api/test/failure-injection.e2e-spec.ts`: req 18 end to end
- `fakes/`: FakePay, ERP, courier, portal; modes and ledgers under `/control` (`X-Control-Key`)
- `web/src/app/admin/`: admin page; `load/`: k6 + `run.sh`
- Generated: `*/src/generated/prisma` (git-ignored), `web/AGENTS.md` (written by Next.js), lockfiles

## Deploy
None: local Docker only. Reset data: `docker compose down -v`.

## Things Claude gets wrong
- Text replacements written before Prettier formats a file miss reformatted lines: check each edit applied (lint and typecheck caught this 4 times while building).
- Ordering by a timestamp that can tie (Prisma fills `now()` at millisecond resolution) gives flaky order; use a sequence column.
- Fakes in a failure mode keep that mode for later steps of the same test (e.g. `webhook_lost` also drops the refund webhook): reset the mode before the step that needs it.
