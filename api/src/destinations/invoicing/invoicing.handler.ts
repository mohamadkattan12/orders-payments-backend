import { Injectable } from '@nestjs/common';
import { CALL_TIMEOUT_MS, config } from '../../common/config.js';
import {
  type Delivery,
  type Invoice,
  type InvoiceKind,
  Prisma,
} from '../../generated/prisma/client.js';
import type { DestinationHandler } from '../../outbox/destinations.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * order.paid → the order's invoice; order.refunded → its credit note. The row (and its sequence
 * number) is created once, before the first portal call, so retries resubmit the same document;
 * the portal dedupes by idempotency key and by our invoice UUID.
 */
@Injectable()
export class InvoicingHandler implements DestinationHandler {
  constructor(private readonly prisma: PrismaService) {}

  async deliver(delivery: Delivery): Promise<{ externalRef?: string }> {
    const kind: InvoiceKind =
      delivery.eventType === 'order.paid' ? 'invoice' : 'credit_note';
    const doc = await this.document(delivery.orderId, kind);
    if (doc.clearanceId) return { externalRef: doc.clearanceId }; // already cleared: skip the call

    const res = await fetch(`${config.fakesUrl()}/einvoice/invoices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${delivery.eventId}:invoicing`,
      },
      body: JSON.stringify({
        invoiceUuid: doc.id,
        number: doc.number,
        kind,
        orderId: doc.orderId,
        subtotalHalalas: doc.subtotalHalalas,
        vatHalalas: doc.vatHalalas,
        totalHalalas: doc.totalHalalas,
      }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`einvoice HTTP ${res.status}`);
    const { clearanceId } = (await res.json()) as { clearanceId: string };
    await this.prisma.invoice.update({
      where: { id: doc.id },
      data: { clearanceId },
    });
    return { externalRef: clearanceId };
  }

  /** The order's invoice or credit note, created on first use; totals from the snapshotted lines. */
  private async document(orderId: string, kind: InvoiceKind): Promise<Invoice> {
    const where = { orderId_kind: { orderId, kind } };
    // Look first: an insert that hits the unique key would still burn a sequence number.
    const existing = await this.prisma.invoice.findUnique({ where });
    if (existing) return existing;

    let totals: Pick<
      Invoice,
      'subtotalHalalas' | 'vatHalalas' | 'totalHalalas'
    >;
    let referencesInvoice: string | null = null;
    if (kind === 'invoice') {
      const items = await this.prisma.orderItem.findMany({
        where: { orderId },
      });
      const totalHalalas = items.reduce((a, i) => a + i.lineTotalHalalas, 0);
      const vatHalalas = items.reduce((a, i) => a + i.lineVatHalalas, 0);
      totals = {
        totalHalalas,
        vatHalalas,
        subtotalHalalas: totalHalalas - vatHalalas,
      };
    } else {
      // The engine delivers order.refunded only after order.paid (PREDECESSOR), so this exists.
      const invoice = await this.prisma.invoice.findUniqueOrThrow({
        where: { orderId_kind: { orderId, kind: 'invoice' } },
      });
      totals = {
        totalHalalas: invoice.totalHalalas,
        vatHalalas: invoice.vatHalalas,
        subtotalHalalas: invoice.subtotalHalalas,
      };
      referencesInvoice = invoice.id;
    }

    try {
      return await this.prisma.invoice.create({
        data: { orderId, kind, referencesInvoice, ...totals },
      });
    } catch (error) {
      // A concurrent creator won (only possible past a lease expiry): use its row.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return this.prisma.invoice.findUniqueOrThrow({ where });
      throw error;
    }
  }
}
