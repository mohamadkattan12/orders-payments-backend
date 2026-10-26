import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SenderService } from '../src/webhooks/sender.service.js';

type Received = {
  path: string;
  signature: string;
  body: { id: string; type: string; data: Record<string, unknown> };
};
const KEY = { 'X-Control-Key': 'dev-control-key' };

/** Waits until `check` stops throwing (webhooks arrive asynchronously). */
async function eventually<T>(
  check: () => T | Promise<T>,
  ms = 5000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

describe('fake external systems (e2e)', () => {
  let app: INestApplication;
  let store: Server;
  let received: Received[] = [];
  let failNext = 0; // the fake store answers 500 this many times

  const http = () => request(app.getHttpServer());
  const control = (system: string, body: object) =>
    http().post(`/control/${system}`).set(KEY).send(body).expect(200);
  const charge = (
    token = 'tok_success',
    key: string = randomUUID(),
    ref: string = randomUUID(),
  ) =>
    http().post('/fakepay/charges').set('Idempotency-Key', key).send({
      amountHalalas: 4500,
      currency: 'SAR',
      token,
      merchantReference: ref,
    });

  beforeAll(async () => {
    store = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (failNext > 0) {
          failNext--;
          res.writeHead(500).end();
          return;
        }
        const header = String(
          req.headers['fakepay-signature'] ??
            req.headers['erp-signature'] ??
            req.headers['courier-signature'] ??
            '',
        );
        received.push({
          path: req.url!,
          signature: header,
          body: JSON.parse(raw),
        });
        // verify the signature the way the store will
        const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
        const system = req.url!.split('/').pop()!;
        const expected = createHmac('sha256', `dev-${system}-secret`)
          .update(`${t}.${raw}`)
          .digest('hex');
        res.writeHead(v1 === expected ? 200 : 401).end();
      });
    });
    await new Promise<void>((r) => store.listen(0, '127.0.0.1', r));
    process.env.STORE_WEBHOOK_BASE = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(async () => {
    await http().post('/control/reset').set(KEY).expect(200);
    received = [];
    failNext = 0;
  });

  afterAll(async () => {
    await app.close();
    await new Promise((r) => store.close(r));
  });

  it('a charge answers pending, then a signed payment.succeeded webhook arrives', async () => {
    const res = await charge().expect(201);
    expect(res.body).toMatchObject({
      status: 'pending',
      amountHalalas: 4500,
      id: expect.stringMatching(/^pay_/),
    });
    const [hook] = await eventually(() => {
      expect(received).toHaveLength(1);
      return received;
    });
    expect(hook).toMatchObject({
      path: '/webhooks/fakepay',
      body: {
        type: 'payment.succeeded',
        data: { id: res.body.id, status: 'succeeded' },
      },
    });
    expect(hook.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const ledger = await http()
      .get('/control/fakepay/ledger')
      .set(KEY)
      .expect(200);
    expect(ledger.body.webhooks[0]).toMatchObject({
      attempts: 1,
      lastError: null,
    });
  });

  it('a declined token fails, and lookup by merchant reference shows it', async () => {
    const ref = randomUUID();
    await charge('tok_decline', randomUUID(), ref).expect(201);
    await eventually(() =>
      expect(received[0]?.body.type).toBe('payment.failed'),
    );
    const found = await http()
      .get(`/fakepay/charges?merchant_reference=${ref}`)
      .expect(200);
    expect(found.body).toMatchObject({
      status: 'failed',
      failureReason: 'card_declined',
    });
  });

  it('a repeated key replays the response and charges once; a different body is 422', async () => {
    const key = randomUUID();
    const ref = randomUUID();
    const first = await charge('tok_success', key, ref).expect(201);
    const again = await charge('tok_success', key, ref).expect(201);
    expect(again.body).toEqual(first.body);
    await charge('tok_decline', key, ref).expect(422);
    const parallel = randomUUID();
    const pref = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => charge('tok_success', parallel, pref)),
    );
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const ledger = await http().get('/control/fakepay/ledger').set(KEY);
    expect(ledger.body.charges).toHaveLength(2);
    await eventually(() => expect(received).toHaveLength(2)); // one webhook per charge, not per request
  });

  it('down answers 503 without charging; flaky fails exactly N times', async () => {
    await control('fakepay', { mode: 'down' });
    await charge().expect(503);
    await control('erp', { mode: 'flaky', failCount: 2 });
    const record = () =>
      http()
        .post('/erp/records')
        .set('Idempotency-Key', 'k1')
        .send({
          kind: 'sale',
          orderId: 'o1',
          totalHalalas: 100,
          lines: [{ sku: 'A', qty: 1 }],
        });
    await record().expect(503);
    await record().expect(503);
    await record().expect(201);
    expect(
      (await http().get('/control/fakepay/ledger').set(KEY)).body.charges,
    ).toHaveLength(0);
    expect(
      (await http().get('/control/erp/ledger').set(KEY)).body.records,
    ).toHaveLength(1);
  });

  it('response_lost charges but drops the connection; the charge is found by reference', async () => {
    await control('fakepay', { mode: 'response_lost' });
    const ref = randomUUID();
    await expect(charge('tok_success', randomUUID(), ref)).rejects.toThrow(
      /socket hang up|ECONNRESET/,
    );
    const found = await http()
      .get(`/fakepay/charges?merchant_reference=${ref}`)
      .expect(200);
    expect(found.body.status).toBe('succeeded');
  });

  it('webhook_lost sends nothing; duplicate sends the same event twice', async () => {
    await control('fakepay', { mode: 'webhook_lost' });
    await charge().expect(201);
    await new Promise((r) => setTimeout(r, 500));
    expect(received).toHaveLength(0);
    await control('fakepay', { mode: 'duplicate' });
    await charge().expect(201);
    await eventually(() => expect(received).toHaveLength(2));
    expect(received[0].body.id).toBe(received[1].body.id);
  });

  it('keeps retrying until the store answers 2xx', async () => {
    failNext = 2;
    await charge().expect(201);
    await eventually(() => expect(received).toHaveLength(1));
    const ledger = await http().get('/control/fakepay/ledger').set(KEY);
    expect(ledger.body.webhooks[0].attempts).toBe(3);
  });

  it('courier tracking: in order normally, newest first when out_of_order is flushed', async () => {
    const ship = () =>
      http()
        .post('/courier/shipments')
        .set('Idempotency-Key', randomUUID())
        .send({
          orderId: 'o1',
          recipient: { name: 'Sara', phone: '+966512345678', city: 'Riyadh' },
          items: [{ sku: 'A', qty: 1 }],
        })
        .expect(201);
    const a = await ship();
    await http()
      .post(`/control/courier/shipments/${a.body.shipmentId}/advance`)
      .set(KEY)
      .send({ to: 'delivered' })
      .expect(200);
    await eventually(() => expect(received).toHaveLength(4));
    expect(received.map((r) => r.body.data.seq)).toEqual([1, 2, 3, 4]);

    received = [];
    await control('courier', { mode: 'out_of_order' });
    const b = await ship();
    await http()
      .post(`/control/courier/shipments/${b.body.shipmentId}/advance`)
      .set(KEY)
      .send({ to: 'in_transit' })
      .expect(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0); // held
    await http()
      .post('/control/courier/flush')
      .set(KEY)
      .expect(200, { released: 3 });
    await eventually(() => expect(received).toHaveLength(3));
    expect(received.map((r) => r.body.data.status)).toEqual([
      'in_transit',
      'picked_up',
      'created',
    ]);
  });

  it('refunds a succeeded charge once; a failed charge is not refundable', async () => {
    const ok = await charge().expect(201);
    const refund = (chargeId: string) =>
      http()
        .post('/fakepay/refunds')
        .set('Idempotency-Key', randomUUID())
        .send({
          chargeId,
          amountHalalas: 4500,
          merchantReference: randomUUID(),
        });
    await refund(ok.body.id).expect(201);
    await refund(ok.body.id).expect(409);
    const bad = await charge('tok_decline').expect(201);
    await refund(bad.body.id).expect(409);
    await eventually(() =>
      expect(received.map((r) => r.body.type).sort()).toEqual([
        'payment.failed',
        'payment.succeeded',
        'refund.succeeded',
      ]),
    );
  });

  it('the e-invoicing portal returns the same clearance for the same invoice UUID', async () => {
    const invoice = {
      invoiceUuid: randomUUID(),
      number: 1,
      kind: 'invoice',
      orderId: 'o1',
      subtotalHalalas: 3913,
      vatHalalas: 587,
      totalHalalas: 4500,
    };
    const a = await http()
      .post('/einvoice/invoices')
      .set('Idempotency-Key', 'a')
      .send(invoice)
      .expect(201);
    const b = await http()
      .post('/einvoice/invoices')
      .set('Idempotency-Key', 'b')
      .send(invoice)
      .expect(201);
    expect(b.body.clearanceId).toBe(a.body.clearanceId);
  });

  it('the ERP pushes signed stock adjustments', async () => {
    await http()
      .post('/control/erp/adjust')
      .set(KEY)
      .send({ sku: 'OUD-OIL-12ML', delta: -2 })
      .expect(200);
    await eventually(() =>
      expect(received[0]).toMatchObject({
        path: '/webhooks/erp',
        body: {
          type: 'stock.adjusted',
          data: { sku: 'OUD-OIL-12ML', delta: -2 },
        },
      }),
    );
  });

  it('controls need the key, and only offer each system its real failure modes', async () => {
    await http().post('/control/fakepay').send({ mode: 'down' }).expect(403);
    await http()
      .post('/control/fakepay')
      .set({ 'X-Control-Key': 'wrong-key-123' })
      .send({ mode: 'down' })
      .expect(403);
    await http()
      .post('/control/einvoice')
      .set(KEY)
      .send({ mode: 'duplicate' })
      .expect(400);
    await http()
      .post('/control/nope')
      .set(KEY)
      .send({ mode: 'ok' })
      .expect(400);
  });
  it('flush releases webhooks queued in one transaction newest first, every time', async () => {
    await control('courier', { mode: 'out_of_order' });
    const prisma = app.get(PrismaService);
    const sender = app.get(SenderService);
    for (let round = 0; round < 50; round++) {
      await prisma.$transaction(async (tx) => {
        for (const n of [1, 2, 3])
          await sender.emit(tx, 'courier', '/webhooks/courier', 'test.order', {
            round,
            n,
          });
      });
      await sender.flush('courier');
      const rows = await prisma.outgoingWebhook.findMany({
        where: {
          system: 'courier',
          body: { path: ['data', 'round'], equals: round },
        },
        orderBy: { sendAfter: 'asc' },
      });
      expect(
        rows.map((r) => (r.body as { data: { n: number } }).data.n),
        `round ${round}`,
      ).toEqual([3, 2, 1]);
    }
  });
});
