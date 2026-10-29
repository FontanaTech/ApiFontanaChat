import type { Queryable } from '../db';

export interface Company {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  content_url: string | null;
  content_hash: string | null;
  content_synced_at: string | null;
  content_status: 'never' | 'ok' | 'error';
  content_error: string | null;
  /** Límite diario de tokens del modelo para esta empresa; null = sin límite propio. */
  llm_daily_tokens: number | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  'id, slug, name, active, content_url, content_hash, content_synced_at, content_status, content_error, llm_daily_tokens, created_at, updated_at';

export async function listCompanies(q: Queryable, onlyId?: string): Promise<Company[]> {
  const r = onlyId
    ? await q.query<Company>(`SELECT ${COLS} FROM companies WHERE id = $1 ORDER BY name`, [onlyId])
    : await q.query<Company>(`SELECT ${COLS} FROM companies ORDER BY name`);
  return r.rows;
}

export async function getCompany(q: Queryable, id: string): Promise<Company | null> {
  const r = await q.query<Company>(`SELECT ${COLS} FROM companies WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function getCompanyBySlug(q: Queryable, slug: string): Promise<Company | null> {
  const r = await q.query<Company>(`SELECT ${COLS} FROM companies WHERE slug = $1`, [slug]);
  return r.rows[0] ?? null;
}

export async function getCompanyContent(q: Queryable, id: string): Promise<unknown | null> {
  const r = await q.query<{ content_json: unknown }>('SELECT content_json FROM companies WHERE id = $1', [id]);
  return r.rows[0]?.content_json ?? null;
}

export async function createCompany(
  q: Queryable,
  d: { slug: string; name: string; contentUrl?: string | null },
): Promise<Company> {
  const r = await q.query<Company>(
    `INSERT INTO companies (slug, name, content_url) VALUES ($1, $2, $3) RETURNING ${COLS}`,
    [d.slug, d.name, d.contentUrl ?? null],
  );
  return r.rows[0];
}

export async function updateCompany(
  q: Queryable,
  id: string,
  d: { name?: string; slug?: string; active?: boolean; contentUrl?: string | null; llmDailyTokens?: number | null },
): Promise<Company | null> {
  const r = await q.query<Company>(
    `UPDATE companies SET
       name = COALESCE($2, name),
       slug = COALESCE($3, slug),
       active = COALESCE($4, active),
       content_url = CASE WHEN $5::boolean THEN $6 ELSE content_url END,
       llm_daily_tokens = CASE WHEN $7::boolean THEN $8::integer ELSE llm_daily_tokens END,
       updated_at = now()
     WHERE id = $1 RETURNING ${COLS}`,
    [id, d.name ?? null, d.slug ?? null, d.active ?? null, d.contentUrl !== undefined, d.contentUrl ?? null, d.llmDailyTokens !== undefined, d.llmDailyTokens ?? null],
  );
  return r.rows[0] ?? null;
}

export async function saveContentResult(
  q: Queryable,
  id: string,
  res: { ok: true; json: unknown; hash: string } | { ok: false; error: string },
): Promise<Company> {
  const r = res.ok
    ? await q.query<Company>(
        `UPDATE companies SET content_json = $2::jsonb, content_hash = $3, content_synced_at = now(),
           content_status = 'ok', content_error = NULL, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
        [id, JSON.stringify(res.json), res.hash],
      )
    : await q.query<Company>(
        `UPDATE companies SET content_synced_at = now(), content_status = 'error', content_error = $2, updated_at = now()
         WHERE id = $1 RETURNING ${COLS}`,
        [id, res.error.slice(0, 500)],
      );
  return r.rows[0];
}
