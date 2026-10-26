import { Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Clock } from '../common/clock.js';
import { RECONCILE_AFTER_MS } from '../common/config.js';
import { apiError } from '../common/errors.js';
import type { Payment, Refund } from '../generated/prisma/client.js';
import {
  IdempotencyService,
  type Tx,
} from '../idempotency/idempotency.service.js';
import { lockOrder, releaseStock } from '../orders/order-locks.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakepayClient } from './fakepay.client.js';

/** A webhook or lookup that is authentic but makes no business sense: recorded, then 4xx. */
export class Rejection extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface ChargeOutcome {
  paymentId: string; // our id = the provider's merchant reference
  providerPaymentId: string;
  status: 'succeeded' | 'failed';
  amountHalalas: number;
  failureReason?: string | null;
}

export interface RefundOutcome {
  refundId: string; // our id = the provider's merchant reference
  providerRefundId: string;
  amountHalalas: number;
}

export const paymentView = (p: Payment) => ({
  id: p.id,
  status: p.status,
  amountHalalas: p.amountHalalas,
  failureReason: p.failureReason,
  createdAt: p.createdAt.toISOString(),
});

const lockPayment = async (tx: Tx, id: string) => {
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.payment.findUniqueOrThrow({ where: { id } });
};

const lockRefund = async (tx: Tx, id: string) => {
  await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.refund.findUniqueOrThrow({ where: { id } });
};

const TX = { maxWait: 10_000, timeout: 15_000 };
const REFUND_RETRY_AFTER_MS = 10_000; // leave a just-requested refund to its first submit

/**
 * Money moves here. Every change locks the order first, then the payment or refund, so webhooks,
 * reconciliation, expiry, cancellation and refunds serialize per order.
 */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger('Payments');

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly fakepay: FakepayClient,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Commit a pending payment first, then call FakePay with the payment id as idempotency key and
   * merchant reference. A lost response or a crash leaves a pending row that reconciliation settles.
   */
  async pay(orderId: string, key: string | undefined, token: string) {
    const accepted = await this.idempotency.runInTransaction(
      `pay:${orderId}`,
      key,
      { token },
      async (tx) => {
        const order = await lockOrder(tx, orderId);
        if (order.status !== 'pending_payment')
          throw apiError(
            409,
            'order_not_payable',
            `The order is ${order.status}.`,
          );
        if (order.expiresAt <= this.clock.now())
          throw apiError(
            409,
            'order_expired',
            'The order expired; check out again.',
          );
        const active = await tx.payment.findFirst({
          where: { orderId, status: { in: ['pending', 'succeeded'] } },
        });
        if (active)
          throw apiError(
            409,
            'payment_in_progress',
            'A payment for this order is already in progress.',
          );
        const payment = await tx.payment.create({
          data: { orderId, amountHalalas: order.totalHalalas, token },
        });
        return { status: 202, body: paymentView(payment) };
      },
    );
    if (!accepted.replayed)
      await this.submit((accepted.body as { id: string }).id);
    return accepted;
  }

  /** Send a pending payment to FakePay. Safe to repeat: the payment id is the idempotency key. */
  async submit(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    if (payment.status !== 'pending') return;
    const result = await this.fakepay.createCharge(
      payment.id,
      payment.amountHalalas,
      payment.token,
    );
    if (result.kind === 'accepted')
      await this.prisma.payment.updateMany({
        where: { id: payment.id, providerPaymentId: null },
        data: { providerPaymentId: result.value.id },
      });
    else if (
      result.kind === 'refused' &&
      result.error !== 'duplicate_merchant_reference'
    )
      // The provider definitely did nothing: the attempt failed and the customer may retry.
      await this.prisma.$transaction(async (tx) => {
        await lockOrder(tx, payment.orderId);
        await tx.payment.updateMany({
          where: { id: payment.id, status: 'pending' },
          data: { status: 'failed', failureReason: `refused: ${result.error}` },
        });
      }, TX);
    else
      this.log.warn({
        message: `payment outcome unknown (${result.error}); reconciliation will settle it`,
        paymentId: payment.id,
        orderId: payment.orderId,
      });
  }

  /**
   * The one way a charge outcome is applied (webhook or reconciliation). Safe to call twice. A
   * success that can't settle the order (expired, cancelled, already paid) is refunded.
   */
  async settlePayment(
    tx: Tx,
    outcome: ChargeOutcome,
  ): Promise<'applied' | 'noop'> {
    // Our references are UUIDs; anything else is unknown (and must not reach a uuid column).
    if (!isUUID(outcome.paymentId)) throw new Rejection('unknown_payment');
    const known = await tx.payment.findUnique({
      where: { id: outcome.paymentId },
    });
    if (!known) throw new Rejection('unknown_payment');
    const order = await lockOrder(tx, known.orderId);
    const payment = await lockPayment(tx, known.id);
    if (outcome.amountHalalas !== payment.amountHalalas)
      throw new Rejection('amount_mismatch');
    if (
      payment.providerPaymentId &&
      payment.providerPaymentId !== outcome.providerPaymentId
    )
      throw new Rejection('provider_payment_mismatch');

    if (outcome.status === 'failed') {
      if (payment.status !== 'pending') return 'noop'; // a late failure never undoes a success
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'failed',
          providerPaymentId: outcome.providerPaymentId,
          failureReason: outcome.failureReason ?? 'failed',
        },
      });
      return 'applied';
    }

    if (payment.status === 'succeeded' || payment.status === 'refunded')
      return 'noop';
    // pending, or failed by our own guess ("never reached the provider") but it did: the provider wins
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'succeeded',
        providerPaymentId: outcome.providerPaymentId,
        failureReason: null,
      },
    });
    const otherSuccess = await tx.payment.count({
      where: {
        orderId: order.id,
        status: 'succeeded',
        id: { not: payment.id },
      },
    });
    if (order.status === 'pending_payment' && otherSuccess === 0) {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'paid', version: { increment: 1 } },
      });
      const items = await tx.orderItem.findMany({
        where: { orderId: order.id },
        orderBy: { sku: 'asc' },
      });
      await tx.outboxEvent.create({
        data: {
          type: 'order.paid',
          orderId: order.id,
          payload: {
            orderId: order.id,
            paymentId: payment.id,
            totalHalalas: order.totalHalalas,
            vatHalalas: order.vatHalalas,
            subtotalHalalas: order.subtotalHalalas,
            customer: {
              name: order.customerName,
              phone: order.customerPhone,
              city: order.city,
            },
            items: items.map((i) => ({
              sku: i.sku,
              qty: i.qty,
              unitPriceHalalas: i.unitPriceHalalas,
              lineTotalHalalas: i.lineTotalHalalas,
              lineVatHalalas: i.lineVatHalalas,
            })),
          },
        },
      });
    } else {
      await this.requestRefund(tx, payment, 'order_not_payable');
    }
    return 'applied';
  }

  /** One refund per payment, committed before FakePay is asked (its id is the idempotency key). */
  async requestRefund(
    tx: Tx,
    payment: Payment,
    reason: 'admin' | 'order_not_payable',
  ): Promise<Refund> {
    return (
      (await tx.refund.findUnique({ where: { paymentId: payment.id } })) ??
      tx.refund.create({
        data: {
          paymentId: payment.id,
          amountHalalas: payment.amountHalalas,
          reason,
        },
      })
    );
  }

  /** Admin refund of a paid order: the payment that settled it is the succeeded one with no refund. */
  async refundOrder(orderId: string, key: string | undefined) {
    const accepted = await this.idempotency.runInTransaction(
      `refund:${orderId}`,
      key,
      {},
      async (tx) => {
        const order = await lockOrder(tx, orderId);
        if (order.status !== 'paid')
          throw apiError(
            409,
            'order_not_refundable',
            `The order is ${order.status}.`,
          );
        const payment = await tx.payment.findFirst({
          where: { orderId, status: 'succeeded', refund: null },
          orderBy: { createdAt: 'asc' },
        });
        if (!payment)
          throw apiError(409, 'order_not_refundable', 'No refundable payment.');
        const refund = await this.requestRefund(tx, payment, 'admin');
        return {
          status: 202,
          body: {
            id: refund.id,
            status: refund.status,
            amountHalalas: refund.amountHalalas,
          },
        };
      },
    );
    if (!accepted.replayed)
      await this.submitRefund((accepted.body as { id: string }).id);
    return accepted;
  }

  /** Send a pending refund to FakePay. Safe to repeat: the refund id is the idempotency key. */
  async submitRefund(refundId: string): Promise<void> {
    const refund = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { payment: true },
    });
    if (refund.status !== 'pending' || !refund.payment.providerPaymentId)
      return;
    const result = await this.fakepay.createRefund(
      refund.id,
      refund.payment.providerPaymentId,
      refund.amountHalalas,
    );
    if (result.kind === 'accepted')
      await this.prisma.refund.updateMany({
        where: { id: refund.id, providerRefundId: null },
        data: { providerRefundId: result.value.id },
      });
    else
      this.log.warn({
        message: `refund ${result.kind} (${result.error}); will retry`,
        refundId: refund.id,
        orderId: refund.payment.orderId,
      });
  }

  /** Apply a provider's refund success (webhook or reconciliation). Safe to call twice. */
  async settleRefund(
    tx: Tx,
    outcome: RefundOutcome,
  ): Promise<'applied' | 'noop'> {
    if (!isUUID(outcome.refundId)) throw new Rejection('unknown_refund');
    const known = await tx.refund.findUnique({
      where: { id: outcome.refundId },
      include: { payment: true },
    });
    if (!known) throw new Rejection('unknown_refund');
    const order = await lockOrder(tx, known.payment.orderId);
    const refund = await lockRefund(tx, known.id);
    if (outcome.amountHalalas !== refund.amountHalalas)
      throw new Rejection('amount_mismatch');
    if (refund.status !== 'pending') return 'noop';
    await tx.refund.update({
      where: { id: refund.id },
      data: { status: 'succeeded', providerRefundId: outcome.providerRefundId },
    });
    await tx.payment.update({
      where: { id: refund.paymentId },
      data: { status: 'refunded' },
    });
    if (refund.reason === 'admin' && order.status === 'paid') {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'refunded', version: { increment: 1 } },
      });
      await tx.outboxEvent.create({
        data: {
          type: 'order.refunded',
          orderId: order.id,
          payload: {
            orderId: order.id,
            refundId: refund.id,
            amountHalalas: refund.amountHalalas,
          },
        },
      });
    }
    return 'applied';
  }

  /** Payments pending for 2+ minutes: ask FakePay by our reference and settle like a webhook. */
  async reconcilePayments(): Promise<number> {
    const stale = await this.prisma.payment.findMany({
      where: {
        status: 'pending',
        createdAt: {
          lt: new Date(this.clock.now().getTime() - RECONCILE_AFTER_MS),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    let settled = 0;
    for (const payment of stale) {
      const found = await this.fakepay.findCharge(payment.id);
      if (found.kind === 'accepted' && found.value.status !== 'pending') {
        const charge = found.value;
        await this.prisma.$transaction(
          (tx) =>
            this.settlePayment(tx, {
              paymentId: payment.id,
              providerPaymentId: charge.id,
              status: charge.status as 'succeeded' | 'failed',
              amountHalalas: charge.amountHalalas,
              failureReason: charge.failureReason,
            }),
          TX,
        );
        settled++;
      } else if (found.kind === 'refused' && found.status === 404) {
        // FakePay never saw it (crash or refused connection before the call): retry while payable.
        const payable = await this.prisma.order.findFirst({
          where: {
            id: payment.orderId,
            status: 'pending_payment',
            expiresAt: { gt: this.clock.now() },
          },
        });
        if (payable) await this.submit(payment.id);
        else
          await this.prisma.$transaction(async (tx) => {
            await lockOrder(tx, payment.orderId);
            await tx.payment.updateMany({
              where: { id: payment.id, status: 'pending' },
              data: { status: 'failed', failureReason: 'not_submitted' },
            });
          }, TX);
      }
    }
    return settled;
  }

  /** Pending refunds: settle them from FakePay's answer, or (re)submit those it never saw. */
  async processRefunds(): Promise<number> {
    const pending = await this.prisma.refund.findMany({
      where: {
        status: 'pending',
        createdAt: {
          lt: new Date(this.clock.now().getTime() - REFUND_RETRY_AFTER_MS),
        },
      },
      take: 50,
    });
    let settled = 0;
    for (const refund of pending) {
      const found = await this.fakepay.findRefund(refund.id);
      if (found.kind === 'accepted' && found.value.status === 'succeeded') {
        const r = found.value;
        await this.prisma.$transaction(
          (tx) =>
            this.settleRefund(tx, {
              refundId: refund.id,
              providerRefundId: r.id,
              amountHalalas: r.amountHalalas,
            }),
          TX,
        );
        settled++;
      } else if (found.kind === 'refused' && found.status === 404) {
        await this.submitRefund(refund.id);
      }
    }
    return settled;
  }

  /** Release the stock of unpaid orders past their hold, unless a payment is still in flight. */
  async expireDue(): Promise<number> {
    const now = this.clock.now();
    const due = await this.prisma.order.findMany({
      where: { status: 'pending_payment', expiresAt: { lt: now } },
      select: { id: true },
      take: 100,
    });
    let expired = 0;
    for (const { id } of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const order = await lockOrder(tx, id);
        if (order.status !== 'pending_payment' || order.expiresAt >= now)
          return false;
        // A payment still pending is settled by reconciliation first; a late success is refunded.
        const inFlight = await tx.payment.count({
          where: {
            orderId: id,
            status: 'pending',
            createdAt: { gt: new Date(now.getTime() - 2 * RECONCILE_AFTER_MS) },
          },
        });
        if (inFlight) return false;
        await tx.order.update({
          where: { id },
          data: { status: 'expired', version: { increment: 1 } },
        });
        await releaseStock(tx, id);
        await tx.outboxEvent.create({
          data: {
            type: 'order.expired',
            orderId: id,
            payload: { orderId: id },
          },
        });
        return true;
      }, TX);
      if (done) expired++;
    }
    return expired;
  }
}
