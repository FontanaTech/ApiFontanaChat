import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './index';

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Aplica en orden las migraciones SQL pendientes. Verifica checksum de las ya aplicadas. */
export async function runMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const done = await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
  const doneMap = new Map(done.rows.map((r) => [r.name, r.checksum]));
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const result: MigrationResult = { applied: [], skipped: [] };

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prev = doneMap.get(file);
    if (prev) {
      if (prev !== checksum) throw new Error(`La migración ya aplicada ${file} fue modificada. Crea una nueva migración.`);
      result.skipped.push(file);
      continue;
    }
    await db.tx(async (q) => {
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
    });
    result.applied.push(file);
  }
  return result;
}
