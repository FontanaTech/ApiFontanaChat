import type { Queryable } from '../db';

export interface Advisor { id: string; company_id: string; name: string; active: boolean }
export interface Phone {
  id: string; company_id: string; advisor_id: string; number: string; label: string; is_primary: boolean; active: boolean;
  portfolio_id: string | null;
}
export interface Button {
  id: string; company_id: string; key: string; advisor_id: string | null; portfolio_id: string | null; label: string; color: string;
  text_color: string; sort_order: number; active: boolean;
}

const ADVISOR_COLS = 'id, company_id, name, active';
const PHONE_COLS = 'id, company_id, advisor_id, number, label, is_primary, active, portfolio_id';
const BUTTON_COLS = 'id, company_id, key, advisor_id, portfolio_id, label, color, text_color, sort_order, active';

/* ---------- asesores ---------- */
export async function listAdvisors(q: Queryable, companyId: string): Promise<Advisor[]> {
  return (await q.query<Advisor>(`SELECT ${ADVISOR_COLS} FROM advisors WHERE company_id = $1 ORDER BY name`, [companyId])).rows;
}
export async function getAdvisor(q: Queryable, companyId: string, id: string): Promise<Advisor | null> {
  return (await q.query<Advisor>(`SELECT ${ADVISOR_COLS} FROM advisors WHERE id = $1 AND company_id = $2`, [id, companyId])).rows[0] ?? null;
}
export async function createAdvisor(q: Queryable, companyId: string, name: string): Promise<Advisor> {
  const advisor = (await q.query<Advisor>(`INSERT INTO advisors (company_id, name) VALUES ($1, $2) RETURNING ${ADVISOR_COLS}`, [companyId, name])).rows[0];
  await q.query(`INSERT INTO advisor_status (advisor_id, company_id) VALUES ($1, $2) ON CONFLICT (advisor_id) DO NOTHING`, [advisor.id, companyId]);
  return advisor;
}
export async function updateAdvisor(
  q: Queryable, companyId: string, id: string, d: { name?: string; active?: boolean },
): Promise<Advisor | null> {
  const advisor = (
    (
      await q.query<Advisor>(
        `UPDATE advisors SET name = COALESCE($3, name), active = COALESCE($4, active), updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING ${ADVISOR_COLS}`,
        [id, companyId, d.name ?? null, d.active ?? null],
      )
    ).rows[0] ?? null
  );
  if (advisor && d.active === false) await q.query(`UPDATE advisor_status SET status = 'offline', updated_at = now() WHERE advisor_id = $1`, [advisor.id]);
  return advisor;
}

/* ---------- teléfonos ---------- */
export async function listPhones(q: Queryable, companyId: string): Promise<Phone[]> {
  return (
    await q.query<Phone>(`SELECT ${PHONE_COLS} FROM phones WHERE company_id = $1 ORDER BY advisor_id, is_primary DESC, created_at`, [companyId])
  ).rows;
}
export async function getPhone(q: Queryable, companyId: string, id: string): Promise<Phone | null> {
  return (await q.query<Phone>(`SELECT ${PHONE_COLS} FROM phones WHERE id = $1 AND company_id = $2`, [id, companyId])).rows[0] ?? null;
}
export async function createPhone(
  q: Queryable, companyId: string, d: { advisorId: string; number: string; label: string; isPrimary: boolean; portfolioId?: string | null },
): Promise<Phone> {
  const phone = (
    await q.query<Phone>(
      `INSERT INTO phones (company_id, advisor_id, number, label, is_primary, portfolio_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PHONE_COLS}`,
      [companyId, d.advisorId, d.number, d.label, d.isPrimary, d.portfolioId ?? null],
    )
  ).rows[0];
  if (phone.portfolio_id) await q.query(
    `INSERT INTO advisor_portfolios (company_id, advisor_id, portfolio_id) VALUES ($1,$2,$3) ON CONFLICT (advisor_id, portfolio_id) DO NOTHING`,
    [companyId, phone.advisor_id, phone.portfolio_id],
  );
  return phone;
}
export async function updatePhone(
  q: Queryable, companyId: string, id: string, d: { number?: string; label?: string; isPrimary?: boolean; active?: boolean; portfolioId?: string },
): Promise<Phone | null> {
  const phone = (
    (
      await q.query<Phone>(
        `UPDATE phones SET number = COALESCE($3, number), label = COALESCE($4, label),
           is_primary = COALESCE($5, is_primary), active = COALESCE($6, active),
           portfolio_id = COALESCE($7::uuid, portfolio_id), updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING ${PHONE_COLS}`,
        [id, companyId, d.number ?? null, d.label ?? null, d.isPrimary ?? null, d.active ?? null, d.portfolioId ?? null],
      )
    ).rows[0] ?? null
  );
  if (phone?.portfolio_id) await q.query(
    `INSERT INTO advisor_portfolios (company_id, advisor_id, portfolio_id) VALUES ($1,$2,$3) ON CONFLICT (advisor_id, portfolio_id) DO NOTHING`,
    [companyId, phone.advisor_id, phone.portfolio_id],
  );
  return phone;
}

/** Elimina el teléfono; las derivaciones previas conservan el número y quedan sin `phone_id`. Si era el principal, promueve otro del asesor. */
export async function deletePhone(q: Queryable, companyId: string, phone: Phone): Promise<void> {
  await q.query('DELETE FROM phones WHERE id = $1 AND company_id = $2', [phone.id, companyId]);
  if (phone.is_primary) {
    await q.query(
      `UPDATE phones SET is_primary = true, updated_at = now()
       WHERE id = (SELECT id FROM phones WHERE advisor_id = $1 AND company_id = $2 ORDER BY active DESC, created_at LIMIT 1)`,
      [phone.advisor_id, companyId],
    );
  }
}

/* ---------- botones ---------- */
export async function listButtons(q: Queryable, companyId: string, onlyActive = false): Promise<Button[]> {
  return (
    await q.query<Button>(
      `SELECT ${BUTTON_COLS} FROM buttons WHERE company_id = $1 AND ($2::boolean = false OR active) ORDER BY sort_order, label`,
      [companyId, onlyActive],
    )
  ).rows;
}
export async function getButton(q: Queryable, companyId: string, id: string): Promise<Button | null> {
  return (await q.query<Button>(`SELECT ${BUTTON_COLS} FROM buttons WHERE id = $1 AND company_id = $2`, [id, companyId])).rows[0] ?? null;
}
export async function getButtonByKey(q: Queryable, companyId: string, key: string): Promise<Button | null> {
  return (await q.query<Button>(`SELECT ${BUTTON_COLS} FROM buttons WHERE key = $1 AND company_id = $2`, [key, companyId])).rows[0] ?? null;
}
export async function createButton(
  q: Queryable, companyId: string,
  d: { key: string; advisorId?: string | null; portfolioId?: string | null; label: string; color: string; textColor: string; sortOrder: number },
): Promise<Button> {
  return (
    await q.query<Button>(
      `INSERT INTO buttons (company_id, key, advisor_id, portfolio_id, label, color, text_color, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${BUTTON_COLS}`,
      [companyId, d.key, d.advisorId ?? null, d.portfolioId ?? null, d.label, d.color, d.textColor, d.sortOrder],
    )
  ).rows[0];
}
/** `advisorId: null` desvincula el botón del asesor (pasa a rotativo); `undefined` no lo toca. */
export async function updateButton(
  q: Queryable, companyId: string, id: string,
  d: { advisorId?: string | null; portfolioId?: string | null; label?: string; color?: string; textColor?: string; sortOrder?: number; active?: boolean },
): Promise<Button | null> {
  return (
    (
      await q.query<Button>(
        `UPDATE buttons SET
           advisor_id = CASE WHEN $3::boolean THEN $4::uuid ELSE advisor_id END,
           portfolio_id = CASE WHEN $10::boolean THEN $11::uuid ELSE portfolio_id END,
           label = COALESCE($5, label), color = COALESCE($6, color), text_color = COALESCE($7, text_color),
           sort_order = COALESCE($8, sort_order), active = COALESCE($9, active), updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING ${BUTTON_COLS}`,
        [
          id, companyId, d.advisorId !== undefined, d.advisorId ?? null,
          d.label ?? null, d.color ?? null, d.textColor ?? null, d.sortOrder ?? null, d.active ?? null,
          d.portfolioId !== undefined, d.portfolioId ?? null,
        ],
      )
    ).rows[0] ?? null
  );
}
