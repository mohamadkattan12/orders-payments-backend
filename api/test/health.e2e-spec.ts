import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PRODUCTS } from '../src/seed/data.js';
import { createTestApp } from './support/app.js';

describe('health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('is alive, and ready once migrated, seeded and connected to Redis', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200, { status: 'ok' });
    const ready = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(ready.body).toEqual({
      status: 'ready',
      db: 'ok',
      redis: 'ok',
      migrations: 1,
      products: PRODUCTS.length,
    });
  });
});
