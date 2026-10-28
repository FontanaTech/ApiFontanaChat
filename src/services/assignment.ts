import type { Queryable } from '../db';

export interface Recipient {
  advisorId: string;
  advisorName: string;
  phoneId: string;
  number: string;
}

/**
 * Destinatarios vigentes, leídos de la base en cada llamada (sin caché), por lo que un cambio de
 * teléfono aplica de inmediato sin recompilar ningún sitio. Solo cuentan asesores activos con
 * teléfono activo; por asesor se usa su teléfono principal (o el más antiguo).
 * Orden estable (antigüedad del asesor) para que el round robin sea predecible.
 */
export async function eligibleRecipients(q: Queryable, companyId: string, advisorId: string | null = null): Promise<Recipient[]> {
  const r = await q.query<any>(
    `SELECT advisor_id, advisor_name, phone_id, number FROM (
       SELECT DISTINCT ON (a.id) a.id AS advisor_id, a.name AS advisor_name, a.created_at, p.id AS phone_id, p.number
       FROM advisors a JOIN phones p ON p.advisor_id = a.id AND p.company_id = a.company_id
       WHERE a.company_id = $1 AND a.active AND p.active AND ($2::uuid IS NULL OR a.id = $2)
       ORDER BY a.id, p.is_primary DESC, p.created_at, p.id
     ) t ORDER BY created_at, advisor_id`,
    [companyId, advisorId],
  );
  return r.rows.map((x: any) => ({ advisorId: x.advisor_id, advisorName: x.advisor_name, phoneId: x.phone_id, number: x.number }));
}

/**
 * Elige destinatario. Con `advisorId` (botón fijo) devuelve a ese asesor si está disponible.
 * Sin él, rota entre todos los disponibles; debe llamarse dentro de una transacción porque bloquea
 * la fila de la empresa para que el round robin sea consistente bajo concurrencia.
 */
export async function assignRecipient(q: Queryable, companyId: string, advisorId: string | null = null): Promise<Recipient | null> {
  if (advisorId) return (await eligibleRecipients(q, companyId, advisorId))[0] ?? null;
  const locked = await q.query<{ rr_cursor: number }>('SELECT rr_cursor FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!locked.rows[0]) return null;
  const list = await eligibleRecipients(q, companyId);
  if (list.length === 0) return null;
  const cursor = locked.rows[0].rr_cursor;
  await q.query('UPDATE companies SET rr_cursor = $2 WHERE id = $1', [companyId, (cursor + 1) % 1_000_000]);
  return list[cursor % list.length];
}
