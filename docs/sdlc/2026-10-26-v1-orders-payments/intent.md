# Intent: Orders and payments backend for an online store (portfolio project #3)

Author: Mohamad Nour · Source: conversation (portfolio plan after LinkedIn KSA research) · Date: 2026-10-26
Status: draft

## Problem
Projects #1 (arabic-docs-qa) and #2 (clinic-booking-agent) show AI work: retrieval, agents and
evaluation. Neither shows the **backend reliability** that fintech, retail and integration posts in
KSA ask for (Tamara, Moyasar, retail/logistics integrators, DP World): money that is never charged
twice, stock that is never oversold, and integrations with other systems that keep working when
those systems fail, time out or send the same message twice.

## Proposed outcome
A public repo (`mohamadkattan12`) where a reviewer runs `docker compose up` and:
1. Uses a REST API (OpenAPI docs) for a fictional Saudi online store, "Mithal Store": products and
   stock, carts, checkout into orders, payment, cancellation and refund. Prices in SAR with 15% VAT.
2. Pays through a **built-in fake payment gateway** that behaves like a real one: asynchronous
   results, signed webhooks, declines, timeouts, and duplicate or out-of-order webhook deliveries.
   No real gateway account or keys are needed anywhere.
3. Sees every state change reach three **simulated external systems** through a reliable event
   pipeline (transactional outbox in Postgres, relayed to BullMQ queues on Redis, with retries,
   backoff and a dead-letter queue):
   - **ERP**: receives paid orders and sends stock adjustments back;
   - **Courier** (SMSA/Aramex style): creates shipments and sends tracking webhooks;
   - **E-invoicing** (ZATCA-style, simplified and not certified): one invoice record per paid order,
     and a credit note per refund.
4. Opens a **small admin page** (Next.js) listing orders, payments, webhook deliveries, outbox
   events, retries and dead letters, and can replay a dead-lettered event.
5. Can switch each fake system into a failure mode (down, slow, duplicate, out of order) and watch
   the system recover without losing or duplicating anything.

## Affected users and systems
- Recruiters and hiring engineers at KSA fintech, retail and integration companies (readers).
- Mohamad (owner).
- New standalone repo: `~/dev/projects/portfolio/orders-payments-backend`. Nothing else is touched.

## Constraints
- Stack: TypeScript, NestJS, PostgreSQL, Redis + BullMQ, Next.js admin page; scaffolded with
  official CLIs. Docker Compose, everything bound to 127.0.0.1.
- Fake payment provider only (decided 2026-10-26): no Moyasar or other real gateway integration.
- Fictional store, products and customers only. Nothing from Mohamad's employer work (CXOne,
  WhatsApp Business, the commerce platform under `~/dev/projects/commerce-platform`) is copied or
  referenced.
- Idempotency keys on every money- or stock-changing request; webhook signatures verified;
  amounts as integer halalas.
- Commits authored by mohamadkattan12 only, no Claude attribution lines; Claude workflow files
  (CLAUDE.md, REVIEW.md) stay in the repo.
- No AI features and no API spending in this project.

## Out of scope
- Real payment gateways, real couriers, certified ZATCA e-invoicing (XML signing, QR, clearance).
- Customer storefront UI, customer accounts and login (an API key for the admin page only).
- Multi-tenancy, multi-currency, discounts and coupons, tax other than 15% VAT.
- Hosting or a live deployment.

## Success measure
- **Failure-injection tests** (in CI): with each fake system failing, timing out, or sending
  duplicate and out-of-order messages, every paid order is charged exactly once, reaches the ERP,
  courier and invoicing exactly once in effect, and every event ends delivered or in the dead-letter
  queue (none lost).
- **Load test** (k6, local): N concurrent checkouts for a product with less stock than buyers:
  zero oversold units, zero double charges, with p50/p95 latency reported in the README.
- `docker compose up` from a fresh clone works without any keys.

## Open questions
- Repo name: `orders-payments-backend` (proposed).
- Load-test size (proposed: 200 concurrent checkouts on 50 units).
