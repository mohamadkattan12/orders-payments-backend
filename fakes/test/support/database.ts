import { execFileSync } from 'node:child_process';
import { Client } from 'pg';

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5436/postgres';

/** Vitest global setup: a fresh, migrated test database for the e2e run. */
export default async function setup(): Promise<() => Promise<void>> {
  const name = 'fakes_test';
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'ignore',
  });
  return async () => {
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.end();
  };
}
