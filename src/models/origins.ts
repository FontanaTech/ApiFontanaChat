import type { Queryable } from '../db';

export interface Origin {
  id: string;
  company_id: string;
  origin: string;
  active: boolean;
  created_at: string;
}

export async function listOrigins(q: Queryable, companyId: string): Promise<Origin[]> {
  return (await q.query<Origin>('SELECT * FROM allowed_origins WHERE company_id = $1 ORDER BY origin', [companyId])).rows;
}

export async function getOrigin(q: Queryable, companyId: string, id: string): Promise<Origin | null> {
  return (
    (await q.query<Origin>('SELECT * FROM allowed_origins WHERE id = $1 AND company_id = $2', [id, companyId])).rows[0] ?? null
  );
}

export async function createOrigin(q: Queryable, companyId: string, origin: string): Promise<Origin> {
  return (
    await q.query<Origin>('INSERT INTO allowed_origins (company_id, origin) VALUES ($1, $2) RETURNING *', [companyId, origin])
  ).rows[0];
}

export async function setOriginActive(q: Queryable, companyId: string, id: string, active: boolean): Promise<Origin | null> {
  return (
    (
      await q.query<Origin>('UPDATE allowed_origins SET active = $3 WHERE id = $1 AND company_id = $2 RETURNING *', [
        id,
        companyId,
        active,
      ])
    ).rows[0] ?? null
  );
}

export async function activeOrigins(q: Queryable, companyId: string): Promise<string[]> {
  const r = await q.query<{ origin: string }>('SELECT origin FROM allowed_origins WHERE company_id = $1 AND active', [companyId]);
  return r.rows.map((x) => x.origin);
}
