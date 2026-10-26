# Review instructions

## Passes
Run three passes and tag each finding with its pass:
- Bugs: money and stock correctness (overselling, double charge, double refund, VAT rounding),
  state transitions outside `lockOrder`/`settlePayment`, races between webhook, reconciliation,
  expiry and cancel, delivery engine (lost or duplicated deliveries, ordering, leases, dead letters),
  queries made through the global client inside a transaction, missing error handling
- Security: webhook signature checked on the raw body before anything else, timing-safe compare and
  timestamp window, idempotency keys on every money- or stock-changing route, admin and control
  keys never in the web bundle or URLs, input bounds, full phone numbers or tokens in logs
- Compliance: the change matches docs/sdlc/<change>/spec.md (including "Review amendments") and
  plan.md, and this repo's CLAUDE.md conventions; plan departures not recorded in plan.md are findings

## What Important means here
Important = could charge, refund, ship or invoice the wrong number of times, oversell or lose
stock, lose or duplicate an event's effect, leak a key, or breach the spec. Style and naming are nits.

## Cap the nits
Report at most five nits per review; summarize the rest as a count.

## Do not report
Generated files under `*/src/generated/`, `web/AGENTS.md`, lockfiles, shadcn-generated
`web/src/components/ui/*`, and anything CI already enforces (oxlint, eslint, prettier, tsc).
