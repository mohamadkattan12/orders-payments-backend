-- At most one payment in flight per order. A succeeded payment for an order that is already paid,
-- expired or cancelled must be able to exist until it is refunded (spec amendment 2), so the rule
-- is "one pending", not "one non-failed". Retries need every earlier attempt failed: enforced by
-- pay() under the order lock.
DROP INDEX "payments_one_active_per_order";
CREATE UNIQUE INDEX "payments_one_pending_per_order" ON "payments" ("orderId") WHERE "status" = 'pending';
