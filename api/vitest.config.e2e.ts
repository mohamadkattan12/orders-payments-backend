import { defineConfig } from 'vitest/config';
import { dbName, SLOT } from './test/support/slot.js';

const admin =
  process.env.TEST_ADMIN_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5436/postgres';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/support/database.ts', './test/support/fakes.ts'],
    env: {
      DATABASE_URL: admin.replace(/\/[^/]+$/, `/${dbName('shop_test')}`),
      THROTTLE_LIMIT: '100000',
      DELIVERY_BASE_MS: '20', // retries in milliseconds instead of seconds
      FAKES_URL: `http://127.0.0.1:${8299 + SLOT * 1000}`,
      REDIS_URL:
        process.env.TEST_REDIS_URL ?? `redis://localhost:6380/${1 + SLOT}`, // db 1: never the dev queues
    },
    fileParallelism: false, // the e2e files share one test database
    testTimeout: 60_000, // real-database races and stress loops take longer than the 5 s default
  },
});
