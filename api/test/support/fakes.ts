import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5436/postgres';
const FAKES_DIR = resolve(__dirname, '../../../fakes');
export const FAKES_PORT = 8299;
export const STORE_PORT = 8199; // test apps that need webhooks listen here

/**
 * Vitest global setup: the real fakes app (built from ../fakes) on its own throwaway database,
 * sending webhooks to the test app on STORE_PORT.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const name = 'fakes_for_api_test';
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const env = { ...process.env, DATABASE_URL: url };
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: FAKES_DIR,
    env,
    stdio: 'ignore',
  });
  execFileSync('pnpm', ['build'], { cwd: FAKES_DIR, stdio: 'ignore' });
  const fakes: ChildProcess = spawn('node', ['dist/main.js'], {
    cwd: FAKES_DIR,
    env: {
      ...env,
      PORT: String(FAKES_PORT),
      STORE_WEBHOOK_BASE: `http://127.0.0.1:${STORE_PORT}`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${FAKES_PORT}/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (i > 100) throw new Error('fakes did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  return async () => {
    fakes.kill();
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.end();
  };
}
