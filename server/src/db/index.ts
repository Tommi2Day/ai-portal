import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
export const db = drizzle(pool, { schema });

export async function runMigrations() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/db -> ../../drizzle ; src/db -> ../../drizzle
  // Several replicas may start at once: serialize migrations with a session-level advisory lock.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await migrate(db, { migrationsFolder: path.resolve(here, '../../drizzle') });
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}
