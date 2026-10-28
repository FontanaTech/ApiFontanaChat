import type { Queryable } from '../db';

export interface Advisor { id: string; company_id: string; name: string; active: boolean }
export interface Phone {
  id: string; company_id: string; advisor_id: string; number: string; label: string; is_primary: boolean; active: boolean;
}
export interface Button {
  id: string; company_id: string; key: string; advisor_id: string | null; label: string; color: string; text_color: string;
  sort_order: number; active: boolean;
}

const ADVISOR_COLS = 'id, company_id, name, active';
const PHONE_COLS = 'id, company_id, advisor_id, number, label, is_primary, active';
const BUTTON_COLS = 'id, company_id, key, advisor_id, label, color, text_color, sort_order, active';

/* ---------- asesores ---------- */
export async function listAdvisors(q: Queryable, companyId: string): Promise<Advisor[]> {
  return (await q.query<Advisor>(`SELECT ${ADVISOR_COLS} FROM advisors WHERE company_id = $1 ORDER BY name`, [companyId])).rows;
}
export async function getAdvisor(q: Queryable, companyId: string, id: string): Promise<Advisor | null> {
  return (await q.query<Advisor>(`SELECT ${ADVISOR_COLS} FROM advisors WHERE id = $1 AND company_id = $2`, [id, companyId])).rows[0] ?? null;
}
export async function createAdvisor(q: Queryable, companyId: string, name: string): Promise<Advisor> {
  return (await q.query<Advisor>(`INSERT INTO advisors (company_id, name) VALUES ($1, $2) RETURNING ${ADVISOR_COLS}`, [companyId, name])).rows[0];
}
export async function updateAdvisor(
  q: Queryable, companyId: string, id: string, d: { name?: string; active?: boolean },
): Promise<Advisor | null> {
  return (
    (
      await q.query<Advisor>(
        `UPDATE advisors SET name = COALESCE($3, name), active = COALESCE($4, active), updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING ${ADVISOR_COLS}`,
        [id, companyId, d.name ?? null, d.active ?? null],
      )
    ).rows[0] ?? null
  );
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
  q: Queryable, companyId: string, d: { advisorId: string; number: string; label: string; isPrimary: boolean },
): Promise<Phone> {
  return (
    await q.query<Phone>(
      `INSERT INTO phones (company_id, advisor_id, number, label, is_primary) VALUES ($1, $2, $3, $4, $5) RETURNING ${PHONE_COLS}`,
      [companyId, d.advisorId, d.number, d.label, d.isPrimary],
    )
  ).rows[0];
}
export async function updatePhone(
  q: Queryable, companyId: string, id: string, d: { number?: string; label?: string; isPrimary?: boolean; active?: boolean },
): Promise<Phone | null> {
  return (
    (
      await q.query<Phone>(
        `UPDATE phones SET number = COALESCE($3, number), label = COALESCE($4, label),
           is_primary = COALESCE($5, is_primary), active = COALESCE($6, active), updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING ${PHONE_COLS}`,
        [id, companyId, d.number ?? null, d.label ?? null, d.isPrimary ?? null, d.active ?? null],
      )
    ).rows[0] ?? null
  );
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
  d: { key: string; advisorId?: string | null; label: string; color: string; textColor: string; sortOrder: number },
): Promise<Button> {
  return (
    await q.query<Button>(
      `INSERT INTO buttons (company_id, key, advisor_id, label, color, text_color, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${BUTTON_COLS}`,
      [companyId, d.key, d.advisorId ?? null, d.label, d.color, d.textColor, d.sortOrder],
    )
  ).rows[0];
}
/** `advisorId: null` desvincula el botón del asesor (pasa a rotativo); `undefined` no lo toca. */
export async function updateButton(
  q: Queryable, companyId: string, id: string,
  d: { advisorId?: string | null; label?: string; color?: string; textColor?: string; sortOrder?: number; active?: boolean },
): Promise<Button | null> {
  return (
    (
      await q.query<Button>(
        `UPDATE buttons SET
           advisor_id = CASE WHEN $3::boolean THEN $4::uuid ELSE advisor_id END,
           label = COALESCE($5, label), color = COALESCE($6, color), text_color = COALESCE($7, text_color),
           sort_order = COALESCE($8, sort_order), active = COALESCE($9, active), updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING ${BUTTON_COLS}`,
        [
          id, companyId, d.advisorId !== undefined, d.advisorId ?? null,
          d.label ?? null, d.color ?? null, d.textColor ?? null, d.sortOrder ?? null, d.active ?? null,
        ],
      )
    ).rows[0] ?? null
  );
}
