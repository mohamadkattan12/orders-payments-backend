import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp, resetData } from './support/app.js';

const customer = { name: 'Sara', phone: '+966512345678', city: 'Riyadh' };

describe('checkout (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const checkout = (body: object, key: string = randomUUID()) =>
    request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(body);
  const stock = async (sku: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { sku } })).stock;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  beforeEach(async () => {
    await resetData(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it('reserves stock, freezes prices and VAT per line, and records order.created', async () => {
    const res = await checkout({
      customer,
      items: [
        { sku: 'SAFFRON-5G', qty: 1 },
        { sku: 'DATES-SUKKARI-1KG', qty: 2 },
      ],
    }).expect(201);
    expect(res.body).toMatchObject({
      status: 'pending_payment',
      items: [
        {
          sku: 'DATES-SUKKARI-1KG',
          qty: 2,
          unitPriceHalalas: 4500,
          lineTotalHalalas: 9000,
          lineVatHalalas: 1174,
        },
        {
          sku: 'SAFFRON-5G',
          qty: 1,
          unitPriceHalalas: 3999,
          lineTotalHalalas: 3999,
          lineVatHalalas: 522,
        },
      ],
      totalHalalas: 12999,
      vatHalalas: 1696,
      subtotalHalalas: 11303,
    });
    const held = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(held).toBeGreaterThan(14 * 60_000);
    expect(held).toBeLessThanOrEqual(15 * 60_000);
    expect(await stock('DATES-SUKKARI-1KG')).toBe(198);
    expect(await stock('SAFFRON-5G')).toBe(149);
    const events = await prisma.outboxEvent.findMany({
      where: { orderId: res.body.id },
    });
    expect(events.map((e) => e.type)).toEqual(['order.created']);
    // a later price change does not touch the order
    await prisma.product.update({
      where: { sku: 'SAFFRON-5G' },
      data: { priceHalalas: 9999 },
    });
    const read = await request(app.getHttpServer())
      .get(`/orders/${res.body.id}`)
      .expect(200);
    expect(read.body.totalHalalas).toBe(12999);
  });

  it('out of stock on any line reserves nothing (409 out_of_stock)', async () => {
    const res = await checkout({
      customer,
      items: [
        { sku: 'DATES-SUKKARI-1KG', qty: 1 },
        { sku: 'HONEY-SIDR-500G', qty: 3 }, // 2 in stock
      ],
    }).expect(409);
    expect(res.body).toMatchObject({
      error: 'out_of_stock',
      message: expect.stringContaining('HONEY-SIDR-500G'),
    });
    expect(await stock('DATES-SUKKARI-1KG')).toBe(200);
    expect(await stock('HONEY-SIDR-500G')).toBe(2);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it.each([
    ['qty 0', { customer, items: [{ sku: 'PRAYER-MAT', qty: 0 }] }],
    ['qty 21', { customer, items: [{ sku: 'PRAYER-MAT', qty: 21 }] }],
    ['fractional qty', { customer, items: [{ sku: 'PRAYER-MAT', qty: 1.5 }] }],
    [
      'a SKU twice',
      {
        customer,
        items: [
          { sku: 'PRAYER-MAT', qty: 1 },
          { sku: 'PRAYER-MAT', qty: 1 },
        ],
      },
    ],
    [
      '21 lines',
      {
        customer,
        items: Array.from({ length: 21 }, (_, i) => ({ sku: `S${i}`, qty: 1 })),
      },
    ],
    ['no items', { customer, items: [] }],
    [
      'a non-Saudi phone',
      {
        customer: { ...customer, phone: '+15551234567' },
        items: [{ sku: 'PRAYER-MAT', qty: 1 }],
      },
    ],
    [
      'an unknown field',
      { customer, items: [{ sku: 'PRAYER-MAT', qty: 1 }], discount: 50 },
    ],
  ])('rejects %s (400)', async (_, body) => {
    await checkout(body).expect(400);
    expect(await prisma.order.count()).toBe(0);
  });

  it('rejects an unknown SKU (400 unknown_sku) and a missing idempotency key', async () => {
    const res = await checkout({
      customer,
      items: [{ sku: 'NOPE', qty: 1 }],
    }).expect(400);
    expect(res.body.error).toBe('unknown_sku');
    const noKey = await request(app.getHttpServer())
      .post('/orders')
      .send({ customer, items: [{ sku: 'PRAYER-MAT', qty: 1 }] })
      .expect(400);
    expect(noKey.body.error).toBe('idempotency_key_required');
  });

  it('a repeated key replays the stored response; a different body with it is 422', async () => {
    const key = randomUUID();
    const body = { customer, items: [{ sku: 'PRAYER-MAT', qty: 2 }] };
    const first = await checkout(body, key).expect(201);
    const again = await checkout(body, key).expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await prisma.order.count()).toBe(1);
    expect(await stock('PRAYER-MAT')).toBe(58);
    const other = await checkout(
      { customer, items: [{ sku: 'PRAYER-MAT', qty: 3 }] },
      key,
    ).expect(422);
    expect(other.body.error).toBe('idempotency_mismatch');
  });

  it('a failed request stores nothing, so the same key can be retried', async () => {
    const key = randomUUID();
    const body = { customer, items: [{ sku: 'HONEY-SIDR-500G', qty: 2 }] };
    await prisma.product.update({
      where: { sku: 'HONEY-SIDR-500G' },
      data: { stock: 1 },
    });
    await checkout(body, key).expect(409);
    await prisma.product.update({
      where: { sku: 'HONEY-SIDR-500G' },
      data: { stock: 5 },
    });
    await checkout(body, key).expect(201);
  });

  it('the same key sent 10 times at once creates one order', async () => {
    const key = randomUUID();
    const body = { customer, items: [{ sku: 'TEA-CUPS-SET', qty: 1 }] };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkout(body, key)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await prisma.order.count()).toBe(1);
    expect(await stock('TEA-CUPS-SET')).toBe(39);
  });

  it('50 parallel checkouts for 10 units: exactly 10 orders, stock 0, never negative', async () => {
    await prisma.product.update({
      where: { sku: 'PRAYER-MAT' },
      data: { stock: 10 },
    });
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        checkout({ customer, items: [{ sku: 'PRAYER-MAT', qty: 1 }] }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 409)).toHaveLength(40);
    expect(await stock('PRAYER-MAT')).toBe(0);
    expect(await prisma.order.count()).toBe(10);
  });

  it('two multi-line checkouts in opposite order do not deadlock', async () => {
    const a = {
      customer,
      items: [
        { sku: 'BAKHOOR-100G', qty: 1 },
        { sku: 'THOBE-WHITE', qty: 1 },
      ],
    };
    const b = {
      customer,
      items: [
        { sku: 'THOBE-WHITE', qty: 1 },
        { sku: 'BAKHOOR-100G', qty: 1 },
      ],
    };
    await prisma.product.updateMany({
      where: { sku: { in: ['BAKHOOR-100G', 'THOBE-WHITE'] } },
      data: { stock: 100 },
    });
    for (let round = 0; round < 10; round++) {
      const results = await Promise.all([
        checkout(a),
        checkout(b),
        checkout(a),
        checkout(b),
      ]);
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    }
    expect(await stock('BAKHOOR-100G')).toBe(60); // 40 orders, no 500s (no deadlock)
    expect(await stock('THOBE-WHITE')).toBe(60);
  });

  it('lists products and 404s an unknown order', async () => {
    const products = await request(app.getHttpServer())
      .get('/products')
      .expect(200);
    expect(products.body).toHaveLength(12);
    expect(products.body[0]).toEqual({
      sku: expect.any(String),
      nameAr: expect.any(String),
      nameEn: expect.any(String),
      priceHalalas: expect.any(Number),
      stock: expect.any(Number),
    });
    await request(app.getHttpServer())
      .get(`/orders/${randomUUID()}`)
      .expect(404);
    await request(app.getHttpServer()).get('/orders/not-a-uuid').expect(400);
  });
});
