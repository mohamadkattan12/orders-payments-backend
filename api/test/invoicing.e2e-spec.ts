import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { InvoicingHandler } from '../src/destinations/invoicing/invoicing.handler.js';
import { DeliveryWorker } from '../src/outbox/delivery.worker.js';
import { Dispatcher } from '../src/outbox/dispatcher.js';
import { RelayService } from '../src/outbox/relay.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { createTestApp, eventually, fakes, resetData } from './support/app.js';

const customer = { name: 'Sara', phone: '+966512345678', city: 'Riyadh' };
const ADMIN = { 'X-Admin-Key': 'dev-admin-key' };
// 2 × 45.00 SAR + 1 × 65.00 SAR; line VAT = round(9000 × 15/115) + round(6500 × 15/115) = 1174 + 848.
const ITEMS = [
  { sku: 'DATES-SUKKARI-1KG', qty: 2 },
  { sku: 'COFFEE-SAUDI-500G', qty: 1 },
];
const TOTALS = {
  totalHalalas: 15500,
  vatHalalas: 2022,
  subtotalHalalas: 13478,
};

interface PortalInvoice {
  clearanceId: string;
  invoiceUuid: string;
  kind: string;
  orderId: string;
  payload: Record<string, unknown>;
}

describe('invoicing destination (e2e, real fakes)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let relayTimer: NodeJS.Timeout;

  const http = () => request(app.getHttpServer());
  const mode = (body: object) =>
    fakes('/control/einvoice', { method: 'POST', body: JSON.stringify(body) });
  const portal = async () =>
    (
      (await (await fakes('/control/einvoice/ledger')).json()) as {
        invoices: PortalInvoice[];
      }
    ).invoices;
  const invoices = (orderId: string) =>
    prisma.invoice.findMany({ where: { orderId }, orderBy: { number: 'asc' } });
  const delivery = (orderId: string, eventType: string) =>
    prisma.delivery.findFirstOrThrow({
      where: { orderId, eventType, destination: 'invoicing' },
    });
  const delivered = (orderId: string, eventType: string) =>
    eventually(async () => {
      const d = await delivery(orderId, eventType);
      expect(d.status).toBe('delivered');
      return d;
    });

  /** Checkout and pay through the real API and FakePay webhook. */
  const paidOrder = async () => {
    const { id } = (
      await http()
        .post('/orders')
        .set('Idempotency-Key', randomUUID())
        .send({ customer, items: ITEMS })
        .expect(201)
    ).body as { id: string };
    await http()
      .post(`/orders/${id}/pay`)
      .set('Idempotency-Key', randomUUID())
      .send({ token: 'tok_success' })
      .expect(202);
    return id;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp({ listen: true }));
    worker = await (
      await Test.createTestingModule({ imports: [WorkerModule] }).compile()
    ).init();
    await worker.get(Dispatcher).queue.obliterate({ force: true });
    worker.get(DeliveryWorker).start();
    const relay = worker.get(RelayService);
    relayTimer = setInterval(() => void relay.relayOnce().catch(() => {}), 100);
  });

  beforeEach(async () => {
    await resetData(prisma);
  });

  afterAll(async () => {
    clearInterval(relayTimer);
    await worker.close();
    await app.close();
  });

  it('order.paid → one invoice with the line VAT totals, cleared by the portal once', async () => {
    const id = await paidOrder();
    const d = await delivered(id, 'order.paid');
    const [invoice, ...more] = await invoices(id);
    expect(more).toEqual([]);
    expect(invoice).toMatchObject({
      kind: 'invoice',
      referencesInvoice: null,
      ...TOTALS,
      clearanceId: expect.stringMatching(/^clr_/),
    });
    const items = await prisma.orderItem.findMany({ where: { orderId: id } });
    expect(invoice.vatHalalas).toBe(
      items.reduce((a, i) => a + i.lineVatHalalas, 0),
    );
    expect(d.externalRef).toBe(invoice.clearanceId);
    const ledger = await portal();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      clearanceId: invoice.clearanceId,
      invoiceUuid: invoice.id,
      kind: 'invoice',
      orderId: id,
      payload: { number: invoice.number, ...TOTALS },
    });
  });

  it('portal down, then up: retried and delivered once, with one invoice and one number', async () => {
    await mode({ mode: 'down' });
    const id = await paidOrder();
    await eventually(async () =>
      expect((await delivery(id, 'order.paid')).attempts).toBeGreaterThan(1),
    );
    const pending = await delivery(id, 'order.paid');
    expect(pending.status).toBe('pending');
    expect(pending.lastError).toContain('503');
    const [draft] = await invoices(id); // the number is taken once, before the first call
    expect(draft.clearanceId).toBeNull();
    await mode({ mode: 'ok' });
    const d = await delivered(id, 'order.paid');
    const all = await invoices(id);
    expect(all).toHaveLength(1);
    expect(all[0].number).toBe(draft.number);
    expect(d.externalRef).toBe(all[0].clearanceId);
    expect(await portal()).toHaveLength(1);
  });

  it('order.refunded → one credit note referencing the invoice, same totals', async () => {
    const id = await paidOrder();
    await delivered(id, 'order.paid');
    await http()
      .post(`/admin/orders/${id}/refund`)
      .set(ADMIN)
      .set('Idempotency-Key', randomUUID())
      .expect(202);
    const d = await delivered(id, 'order.refunded');
    const [invoice, credit, ...more] = await invoices(id);
    expect(more).toEqual([]);
    expect(credit).toMatchObject({
      kind: 'credit_note',
      referencesInvoice: invoice.id,
      ...TOTALS,
      clearanceId: expect.stringMatching(/^clr_/),
    });
    expect(credit.number).toBeGreaterThan(invoice.number);
    expect(d.externalRef).toBe(credit.clearanceId);
    const ledger = await portal();
    expect(ledger.map((i) => [i.kind, i.invoiceUuid])).toEqual([
      ['invoice', invoice.id],
      ['credit_note', credit.id],
    ]);
  });

  it('a repeated delivery reuses the invoice: no second row, number or portal submission', async () => {
    const id = await paidOrder();
    const d = await delivered(id, 'order.paid');
    const [invoice] = await invoices(id);
    const handler = worker.get(InvoicingHandler);
    // Replayed after success: the stored clearance id short-circuits the call.
    expect(await handler.deliver(d)).toEqual({
      externalRef: invoice.clearanceId,
    });
    // Crashed after the portal cleared it but before we stored the clearance id: resubmitted
    // with the same key and invoice UUID, the portal answers with the same clearance.
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { clearanceId: null },
    });
    expect(await handler.deliver(d)).toEqual({
      externalRef: invoice.clearanceId,
    });
    expect(await invoices(id)).toEqual([invoice]);
    expect(await portal()).toHaveLength(1);
  });
});
