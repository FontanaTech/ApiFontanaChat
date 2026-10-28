import type { Queryable } from '../db';

export interface Recipient {
  advisorId: string;
  advisorName: string;
  phoneId: string;
  number: string;
  /** Cartera del teléfono elegido (null si es un teléfono antiguo sin cartera). */
  portfolioId: string | null;
}

export interface RecipientFilter {
  /** Asesor concreto (botón con asesor fijo): se usa su teléfono principal, sin mirar la cartera. */
  advisorId?: string | null;
  /** Solo teléfonos de esta cartera. */
  portfolioId?: string | null;
}

/**
 * Destinatarios vigentes, leídos de la base en cada llamada (sin caché), por lo que un cambio de
 * teléfono aplica de inmediato sin recompilar ningún sitio. Solo cuentan asesores activos con teléfono
 * activo en una cartera activa; por asesor se usa su teléfono principal (o el más antiguo) dentro del filtro.
 * Orden estable (antigüedad del asesor) para que el round robin sea predecible.
 */
export async function eligibleRecipients(q: Queryable, companyId: string, f: RecipientFilter = {}): Promise<Recipient[]> {
  const r = await q.query<any>(
    `SELECT advisor_id, advisor_name, phone_id, number, portfolio_id FROM (
       SELECT DISTINCT ON (a.id) a.id AS advisor_id, a.name AS advisor_name, a.created_at, p.id AS phone_id, p.number, p.portfolio_id
       FROM advisors a
       JOIN phones p ON p.advisor_id = a.id AND p.company_id = a.company_id
       LEFT JOIN portfolios w ON w.id = p.portfolio_id AND w.company_id = p.company_id
       WHERE a.company_id = $1 AND a.active AND p.active
         AND ($2::uuid IS NULL OR a.id = $2)
         AND ($3::uuid IS NULL OR p.portfolio_id = $3)
         AND (p.portfolio_id IS NULL OR w.active)
       ORDER BY a.id, p.is_primary DESC, p.created_at, p.id
     ) t ORDER BY created_at, advisor_id`,
    [companyId, f.advisorId ?? null, f.advisorId ? null : (f.portfolioId ?? null)],
  );
  return r.rows.map((x: any) => ({
    advisorId: x.advisor_id, advisorName: x.advisor_name, phoneId: x.phone_id, number: x.number, portfolioId: x.portfolio_id ?? null,
  }));
}

/**
 * Elige destinatario. Con `advisorId` (botón fijo) devuelve a ese asesor si está disponible.
 * Con `portfolioId` rota entre los asesores de esa cartera; sin ninguno, entre todos los de la empresa.
 * Debe llamarse dentro de una transacción: bloquea la fila que guarda el turno (cartera o empresa)
 * para que el round robin sea consistente bajo concurrencia.
 */
export async function assignRecipient(q: Queryable, companyId: string, f: RecipientFilter = {}): Promise<Recipient | null> {
  if (f.advisorId) return (await eligibleRecipients(q, companyId, f))[0] ?? null;
  const table = f.portfolioId ? 'portfolios' : 'companies';
  const locked = f.portfolioId
    ? await q.query<{ rr_cursor: number }>('SELECT rr_cursor FROM portfolios WHERE id = $1 AND company_id = $2 FOR UPDATE', [f.portfolioId, companyId])
    : await q.query<{ rr_cursor: number }>('SELECT rr_cursor FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!locked.rows[0]) return null;
  const list = await eligibleRecipients(q, companyId, f);
  if (list.length === 0) return null;
  const cursor = locked.rows[0].rr_cursor;
  const next = (cursor + 1) % 1_000_000;
  if (f.portfolioId) await q.query('UPDATE portfolios SET rr_cursor = $3 WHERE id = $1 AND company_id = $2', [f.portfolioId, companyId, next]);
  else await q.query(`UPDATE ${table} SET rr_cursor = $2 WHERE id = $1`, [companyId, next]);
  return list[cursor % list.length];
}
