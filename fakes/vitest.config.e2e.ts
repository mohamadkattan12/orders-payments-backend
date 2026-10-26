import { defineConfig } from 'vitest/config';
import { dbName } from './test/support/slot.js';

const admin =
  process.env.TEST_ADMIN_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5436/postgres';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/support/database.ts'],
    env: {
      DATABASE_URL: admin.replace(/\/[^/]+$/, `/${dbName('fakes_test')}`),
    },
    fileParallelism: false, // the e2e files share one test database
    testTimeout: 60_000, // real-database races and stress loops take longer than the 5 s default
  },
});
