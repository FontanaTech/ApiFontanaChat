import { Pool, type PoolClient } from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** Interfaz mínima común a pg (Neon) y PGlite (pruebas). Siempre consultas parametrizadas. */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Ejecuta SQL sin parámetros (admite varias sentencias; usado por migraciones). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function wrapClient(c: Pool | PoolClient): Queryable {
  return {
    async query(sql, params) {
      const r = await c.query(sql, params as any[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) {
      await c.query(sql);
    },
  };
}

export function createPgDb(databaseUrl: string): Db {
  if (!databaseUrl) throw new Error('DATABASE_URL no está configurada');
  const pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  pool.on('error', (err) => console.error('[pg] error en cliente inactivo:', err.message));
  const base = wrapClient(pool);
  return {
    ...base,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrapClient(client));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
