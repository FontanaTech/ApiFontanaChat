import type { Queryable } from '../db';
import { normalize } from '../utils/text';

export interface Portfolio {
  id: string;
  company_id: string;
  key: string;
  name: string;
  description: string;
  aliases: string[];
  is_default: boolean;
  active: boolean;
  sort_order: number;
}
export interface PortfolioWithPhones extends Portfolio {
  /** Teléfonos activos de asesores activos en esta cartera. */
  phone_count: number;
}

const COLS = 'w.id, w.company_id, w.key, w.name, w.description, w.aliases, w.is_default, w.active, w.sort_order';

/** Las palabras que identifican una cartera se guardan normalizadas (minúsculas, sin tildes) y sin repetir. */
export const normalizeAliases = (aliases: string[] = []): string[] => [...new Set(aliases.map((a) => normalize(a)).filter((a) => a.length >= 2))];

export async function listPortfolios(q: Queryable, companyId: string, onlyActive = false): Promise<PortfolioWithPhones[]> {
  return (
    await q.query<PortfolioWithPhones>(
      `SELECT ${COLS},
         (SELECT count(*)::int FROM phones p JOIN advisors a ON a.id = p.advisor_id AND a.company_id = p.company_id
           WHERE p.portfolio_id = w.id AND p.company_id = w.company_id AND p.active AND a.active) AS phone_count
       FROM portfolios w WHERE w.company_id = $1 AND ($2::boolean = false OR w.active)
       ORDER BY w.is_default DESC, w.sort_order, w.name`,
      [companyId, onlyActive],
    )
  ).rows;
}
export async function getPortfolio(q: Queryable, companyId: string, id: string): Promise<Portfolio | null> {
  return (await q.query<Portfolio>(`SELECT ${COLS} FROM portfolios w WHERE w.id = $1 AND w.company_id = $2`, [id, companyId])).rows[0] ?? null;
}
export async function getPortfolioByKey(q: Queryable, companyId: string, key: string): Promise<Portfolio | null> {
  return (await q.query<Portfolio>(`SELECT ${COLS} FROM portfolios w WHERE w.key = $1 AND w.company_id = $2`, [key, companyId])).rows[0] ?? null;
}
export async function getDefaultPortfolio(q: Queryable, companyId: string): Promise<Portfolio | null> {
  return (await q.query<Portfolio>(`SELECT ${COLS} FROM portfolios w WHERE w.company_id = $1 AND w.is_default`, [companyId])).rows[0] ?? null;
}

export async function createPortfolio(
  q: Queryable,
  companyId: string,
  d: { key: string; name: string; description?: string; aliases?: string[]; isDefault?: boolean; sortOrder?: number },
): Promise<Portfolio> {
  if (d.isDefault) await q.query('UPDATE portfolios SET is_default = false WHERE company_id = $1 AND is_default', [companyId]);
  return (
    await q.query<Portfolio>(
      `INSERT INTO portfolios AS w (company_id, key, name, description, aliases, is_default, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
      [companyId, d.key, d.name, d.description ?? '', normalizeAliases(d.aliases), d.isDefault ?? false, d.sortOrder ?? 0],
    )
  ).rows[0];
}

/** `isDefault: true` la convierte en la única por defecto (y la activa). */
export async function updatePortfolio(
  q: Queryable,
  companyId: string,
  id: string,
  d: { name?: string; description?: string; aliases?: string[]; isDefault?: true; active?: boolean; sortOrder?: number },
): Promise<Portfolio | null> {
  if (d.isDefault) await q.query('UPDATE portfolios SET is_default = false WHERE company_id = $1 AND is_default AND id <> $2', [companyId, id]);
  return (
    (
      await q.query<Portfolio>(
        `UPDATE portfolios AS w SET
           name = COALESCE($3, name), description = COALESCE($4, description),
           aliases = COALESCE($5::text[], aliases),
           is_default = CASE WHEN $6::boolean THEN true ELSE is_default END,
           active = CASE WHEN $6::boolean THEN true ELSE COALESCE($7, active) END,
           sort_order = COALESCE($8, sort_order), updated_at = now()
         WHERE w.id = $1 AND w.company_id = $2 RETURNING ${COLS}`,
        [
          id, companyId, d.name ?? null, d.description ?? null, d.aliases ? normalizeAliases(d.aliases) : null,
          d.isDefault === true, d.active ?? null, d.sortOrder ?? null,
        ],
      )
    ).rows[0] ?? null
  );
}

/**
 * Cartera cuyas palabras (alias) aparecen en el texto del visitante; si varias coinciden gana la palabra más larga.
 * Solo carteras activas. Se usa para pasar al visitante con los asesores de la cartera que menciona.
 */
export async function findPortfolioByText(q: Queryable, companyId: string, text: string): Promise<Portfolio | null> {
  const t = ` ${normalize(text)} `;
  let best: { p: Portfolio; len: number } | null = null;
  for (const p of await listPortfolios(q, companyId, true)) {
    for (const a of p.aliases) {
      if (t.includes(` ${a} `) && (!best || a.length > best.len)) best = { p, len: a.length };
    }
  }
  return best?.p ?? null;
}
