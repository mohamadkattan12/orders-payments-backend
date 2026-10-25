import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp, resetData } from './support/app.js';

describe('database rules (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  beforeEach(async () => {
    await resetData(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  const order = () =>
    prisma.order.create({
      data: {
        customerName: 'Test',
        customerPhone: '+966500000000',
        city: 'Riyadh',
        subtotalHalalas: 3913,
        vatHalalas: 587,
        totalHalalas: 4500,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });

  it('stock can never go below zero', async () => {
    await expect(
      prisma.product.update({
        where: { sku: 'HONEY-SIDR-500G' }, // seeded with 2
        data: { stock: { decrement: 3 } },
      }),
    ).rejects.toThrow(/products_stock_nonnegative/);
  });

  it('an order has at most one pending payment', async () => {
    const { id: orderId } = await order();
    const pay = (status: 'pending' | 'failed' | 'succeeded') =>
      prisma.payment.create({
        data: { orderId, amountHalalas: 4500, token: 'tok_success', status },
      });
    await pay('failed');
    await pay('failed'); // retries after failures are fine
    await pay('succeeded'); // a late extra success can exist until it is refunded
    await pay('pending');
    await expect(pay('pending')).rejects.toThrow(/Unique constraint/);
  });

  it('invoice numbers come from one sequence', async () => {
    const { id: orderId } = await order();
    const totals = {
      subtotalHalalas: 3913,
      vatHalalas: 587,
      totalHalalas: 4500,
    };
    const a = await prisma.invoice.create({
      data: { orderId, kind: 'invoice', ...totals },
    });
    const b = await prisma.invoice.create({
      data: { orderId, kind: 'credit_note', ...totals },
    });
    expect(b.number).toBe(a.number + 1);
  });
});
