/**
 * In-process PostgreSQL (PGlite + pgvector) with the real migrations, as a drop-in for src/db/index.ts.
 * Usage in a test file:
 *   vi.mock('../src/db/index.js', async () => (await import('./support/pgdb.js')).testDb());
 * Each test file gets its own database (vitest isolates modules per file).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../../src/db/schema.js';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function testDb() {
  const pg = await PGlite.create({ extensions: { vector } });
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder });
  // pg.Pool subset used by the app: query() and connect() for advisory-lock sessions (single connection here)
  const query = async (text: string, params?: unknown[]) => {
    const r = await pg.query(text, params as never[]);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }), end: async () => pg.close() };
  return { db, pool, runMigrations: async () => {}, pg };
}

/** Deletes all rows (keeps the schema) – call in beforeEach for independent tests. */
export async function resetDb(pg: PGlite) {
  const { rows } = await pg.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '%migrations%'");
  if (rows.length) await pg.exec(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
