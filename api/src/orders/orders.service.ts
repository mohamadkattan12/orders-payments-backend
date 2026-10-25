import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { apiError } from '../common/errors.js';
import { priceLines } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../idempotency/idempotency.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CheckoutDto } from './orders.dto.js';
import { lockOrder, releaseStock } from './order-locks.js';

export const HOLD_MS = 15 * 60 * 1000; // a checkout holds its stock for 15 minutes

const withItems = {
  items: { orderBy: { sku: 'asc' } },
  payments: { orderBy: { createdAt: 'asc' }, include: { refund: true } },
} as const;
type OrderWithItems = Prisma.OrderGetPayload<{ include: typeof withItems }>;

export function orderView(o: OrderWithItems) {
  return {
    id: o.id,
    status: o.status,
    customer: { name: o.customerName, phone: o.customerPhone, city: o.city },
    items: o.items.map((i) => ({
      sku: i.sku,
      qty: i.qty,
      unitPriceHalalas: i.unitPriceHalalas,
      lineTotalHalalas: i.lineTotalHalalas,
      lineVatHalalas: i.lineVatHalalas,
    })),
    subtotalHalalas: o.subtotalHalalas,
    vatHalalas: o.vatHalalas,
    totalHalalas: o.totalHalalas,
    expiresAt: o.expiresAt.toISOString(),
    createdAt: o.createdAt.toISOString(),
    payments: o.payments.map((p) => ({
      id: p.id,
      status: p.status,
      amountHalalas: p.amountHalalas,
      failureReason: p.failureReason,
      refund: p.refund && {
        id: p.refund.id,
        status: p.refund.status,
        reason: p.refund.reason,
      },
    })),
  };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Reserve stock, freeze prices and create the order with its `order.created` event, atomically. */
  async checkout(tx: Tx, dto: CheckoutDto) {
    // Lock rows in one global order (by SKU) so concurrent multi-line checkouts can't deadlock.
    const lines = [...dto.items].sort((a, b) => a.sku.localeCompare(b.sku));
    const reserved: {
      productId: string;
      sku: string;
      qty: number;
      unitPriceHalalas: number;
    }[] = [];
    for (const line of lines) {
      const rows = await tx.$queryRaw<{ id: string; priceHalalas: number }[]>`
        UPDATE products SET stock = stock - ${line.qty}
        WHERE sku = ${line.sku} AND stock >= ${line.qty}
        RETURNING id, "priceHalalas"`;
      if (rows.length === 0) {
        const exists = await tx.product.count({ where: { sku: line.sku } });
        throw exists
          ? apiError(409, 'out_of_stock', `Not enough stock for ${line.sku}.`)
          : apiError(400, 'unknown_sku', `No product with SKU ${line.sku}.`);
      }
      reserved.push({
        productId: rows[0].id,
        sku: line.sku,
        qty: line.qty,
        unitPriceHalalas: rows[0].priceHalalas,
      });
    }
    const priced = priceLines(reserved);
    const order = await tx.order.create({
      data: {
        customerName: dto.customer.name,
        customerPhone: dto.customer.phone,
        city: dto.customer.city,
        subtotalHalalas: priced.subtotalHalalas,
        vatHalalas: priced.vatHalalas,
        totalHalalas: priced.totalHalalas,
        expiresAt: new Date(this.clock.now().getTime() + HOLD_MS),
        items: { create: priced.lines },
      },
      include: withItems,
    });
    await tx.outboxEvent.create({
      data: {
        type: 'order.created',
        orderId: order.id,
        payload: { orderId: order.id, totalHalalas: order.totalHalalas },
      },
    });
    return orderView(order);
  }

  /** Customer cancel of an unpaid order: releases its stock. Cancelling twice returns the same order. */
  async cancel(tx: Tx, id: string) {
    const order = await lockOrder(tx, id);
    if (order.status === 'pending_payment') {
      const inFlight = await tx.payment.count({
        where: { orderId: id, status: 'pending' },
      });
      if (inFlight)
        throw apiError(
          409,
          'payment_in_progress',
          'A payment is in progress; try again shortly.',
        );
      await tx.order.update({
        where: { id },
        data: { status: 'cancelled', version: { increment: 1 } },
      });
      await releaseStock(tx, id);
      await tx.outboxEvent.create({
        data: {
          type: 'order.cancelled',
          orderId: id,
          payload: { orderId: id },
        },
      });
    } else if (order.status !== 'cancelled') {
      throw apiError(
        409,
        'order_not_cancellable',
        `The order is ${order.status}.`,
      );
    }
    return orderView(
      await tx.order.findUniqueOrThrow({ where: { id }, include: withItems }),
    );
  }

  async get(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: withItems,
    });
    if (!order) throw apiError(404, 'order_not_found', 'No such order.');
    return orderView(order);
  }
}
