import { apiError } from '../common/errors.js';
import type { Tx } from '../idempotency/idempotency.service.js';

/** Lock the order row for the rest of the transaction. Every money or stock change starts here. */
export async function lockOrder(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id } });
  if (!order) throw apiError(404, 'order_not_found', 'No such order.');
  return order;
}

/**
 * Return an order's reserved units to sellable stock (call only after winning the transition). Units
 * the ERP has removed meanwhile (`shortfall`) are repaid first instead of becoming sellable again.
 */
export async function releaseStock(tx: Tx, orderId: string): Promise<void> {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    orderBy: { sku: 'asc' },
  });
  for (const item of items)
    await tx.$executeRaw`
      UPDATE products
      SET stock = stock + ${item.qty} - LEAST(shortfall, ${item.qty}),
          shortfall = shortfall - LEAST(shortfall, ${item.qty})
      WHERE id = ${item.productId}::uuid`;
}
