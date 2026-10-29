import type { Queryable } from '../db';

export type EventType = 'page_view' | 'chat_open' | 'button_click' | 'handoff_created' | 'whatsapp_click';

export interface PublicSession {
  id: string;
  company_id: string;
  origin: string;
  page_path: string;
  expires_at: string;
  /** Huella del visitante (IP + navegador); null en sesiones anteriores a la medición de ingresos. */
  visitor_hash: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
}

const SESSION_COLS = 'id, company_id, origin, page_path, expires_at, visitor_hash, browser, os, device';

export async function createPublicSession(
  q: Queryable,
  d: {
    companyId: string; tokenHash: string; origin: string; pagePath: string; expiresAt: Date;
    visitorHash?: string | null; browser?: string | null; os?: string | null; device?: string | null;
  },
): Promise<PublicSession> {
  return (
    await q.query<PublicSession>(
      `INSERT INTO public_sessions (company_id, token_hash, origin, page_path, expires_at, visitor_hash, browser, os, device)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${SESSION_COLS}`,
      [d.companyId, d.tokenHash, d.origin, d.pagePath, d.expiresAt.toISOString(), d.visitorHash ?? null, d.browser ?? null, d.os ?? null, d.device ?? null],
    )
  ).rows[0];
}

/** La sesión solo se resuelve si pertenece a la empresa indicada (aislamiento). */
export async function findPublicSession(q: Queryable, companyId: string, tokenHash: string): Promise<PublicSession | null> {
  return (
    (
      await q.query<PublicSession>(
        `SELECT ${SESSION_COLS} FROM public_sessions
         WHERE token_hash = $1 AND company_id = $2 AND expires_at > now()`,
        [tokenHash, companyId],
      )
    ).rows[0] ?? null
  );
}

/** Minutos sin actividad del visitante tras los cuales un nuevo page_view cuenta como un nuevo ingreso. */
export const VISIT_WINDOW_MINUTES = 30;

/**
 * Registra un evento. Un `page_view` es un *ingreso* (`isVisit`) solo si el visitante (`visitorHash`) no tuvo ningún evento en los
 * últimos 30 minutos: moverse entre vistas, abrir otra pestaña o recargar no cuenta como ingreso nuevo.
 * Sin `visitorHash` (bots, sesiones antiguas) nunca es ingreso.
 */
export async function insertEvent(
  q: Queryable,
  e: {
    companyId: string; sessionId: string; type: EventType; buttonId?: string | null; handoffId?: string | null; pagePath?: string | null;
    visitorHash?: string | null;
  },
): Promise<{ isVisit: boolean }> {
  const r = await q.query<{ is_visit: boolean }>(
    `INSERT INTO events (company_id, session_id, type, button_id, handoff_id, page_path, visitor_hash, is_visit)
     SELECT $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::text, $7::text,
            ($3::text = 'page_view' AND $7::text IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM events x WHERE x.company_id = $1::uuid AND x.visitor_hash = $7::text
                 AND x.created_at > now() - make_interval(mins => ${VISIT_WINDOW_MINUTES})))
     RETURNING is_visit`,
    [e.companyId, e.sessionId, e.type, e.buttonId ?? null, e.handoffId ?? null, e.pagePath ?? null, e.visitorHash ?? null],
  );
  return { isVisit: r.rows[0].is_visit };
}

export interface Handoff {
  id: string;
  company_id: string;
  session_id: string;
  button_id: string | null;
  portfolio_id: string | null;
  advisor_id: string;
  phone_id: string;
  phone_number: string;
  visitor_name: string;
  reason: string;
  wa_url: string;
  status: string;
  created_at: string;
}

export async function findHandoffByKey(q: Queryable, companyId: string, sessionId: string, key: string): Promise<Handoff | null> {
  return (
    (
      await q.query<Handoff>(
        'SELECT * FROM handoffs WHERE company_id = $1 AND session_id = $2 AND idempotency_key = $3',
        [companyId, sessionId, key],
      )
    ).rows[0] ?? null
  );
}

export async function insertHandoff(
  q: Queryable,
  d: {
    companyId: string; sessionId: string; key: string; buttonId: string | null; portfolioId: string | null; advisorId: string;
    phoneId: string; phoneNumber: string; name: string; reason: string; waUrl: string;
  },
): Promise<Handoff> {
  return (
    await q.query<Handoff>(
      `INSERT INTO handoffs (company_id, session_id, idempotency_key, button_id, portfolio_id, advisor_id, phone_id, phone_number,
         visitor_name, reason, wa_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [d.companyId, d.sessionId, d.key, d.buttonId, d.portfolioId, d.advisorId, d.phoneId, d.phoneNumber, d.name, d.reason, d.waUrl],
    )
  ).rows[0];
}

export async function getHandoffForSession(q: Queryable, companyId: string, sessionId: string, id: string): Promise<Handoff | null> {
  return (
    (
      await q.query<Handoff>('SELECT * FROM handoffs WHERE id = $1 AND company_id = $2 AND session_id = $3', [id, companyId, sessionId])
    ).rows[0] ?? null
  );
}

export async function markWhatsappClicked(q: Queryable, companyId: string, id: string): Promise<boolean> {
  const r = await q.query(
    `UPDATE handoffs SET status = 'whatsapp_clicked', whatsapp_clicked_at = now()
     WHERE id = $1 AND company_id = $2 AND status = 'created'`,
    [id, companyId],
  );
  return r.rowCount > 0;
}

/* ---------- consultas administrativas (siempre por empresa) ---------- */
export async function listHandoffs(q: Queryable, companyId: string, from: Date, to: Date, limit: number, offset: number) {
  return (
    await q.query(
      `SELECT h.id, h.created_at, h.visitor_name, h.reason, h.phone_number, h.status, h.whatsapp_clicked_at,
              b.label AS button_label, ad.name AS advisor_name, w.name AS portfolio_name
       FROM handoffs h
       LEFT JOIN buttons b ON b.id = h.button_id AND b.company_id = h.company_id
       LEFT JOIN portfolios w ON w.id = h.portfolio_id AND w.company_id = h.company_id
       JOIN advisors ad ON ad.id = h.advisor_id AND ad.company_id = h.company_id
       WHERE h.company_id = $1 AND h.created_at >= $2 AND h.created_at < $3
       ORDER BY h.created_at DESC LIMIT $4 OFFSET $5`,
      [companyId, from.toISOString(), to.toISOString(), limit, offset],
    )
  ).rows;
}

export async function listEvents(q: Queryable, companyId: string, from: Date, to: Date, limit: number, offset: number) {
  return (
    await q.query(
      `SELECT e.id, e.created_at, e.type, e.is_visit, e.page_path, e.session_id, b.label AS button_label, s.browser, s.os, s.device
       FROM events e
       LEFT JOIN public_sessions s ON s.id = e.session_id AND s.company_id = e.company_id
       LEFT JOIN buttons b ON b.id = e.button_id AND b.company_id = e.company_id
       WHERE e.company_id = $1 AND e.created_at >= $2 AND e.created_at < $3
       ORDER BY e.created_at DESC LIMIT $4 OFFSET $5`,
      [companyId, from.toISOString(), to.toISOString(), limit, offset],
    )
  ).rows;
}

export async function metrics(q: Queryable, companyId: string, from: Date, to: Date) {
  const f = from.toISOString();
  const t = to.toISOString();
  const totals = await q.query<{ type: string; total: number; sessions: number }>(
    `SELECT type, count(*)::int AS total, count(DISTINCT session_id)::int AS sessions FROM events
     WHERE company_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY type`,
    [companyId, f, t],
  );
  const byAdvisor = await q.query(
    `SELECT ad.name AS advisor, count(*)::int AS handoffs,
            count(*) FILTER (WHERE h.status = 'whatsapp_clicked')::int AS whatsapp_clicks
     FROM handoffs h JOIN advisors ad ON ad.id = h.advisor_id AND ad.company_id = h.company_id
     WHERE h.company_id = $1 AND h.created_at >= $2 AND h.created_at < $3 GROUP BY ad.id, ad.name ORDER BY handoffs DESC`,
    [companyId, f, t],
  );
  const byPortfolio = await q.query(
    `SELECT COALESCE(w.name, '(sin cartera)') AS portfolio, count(*)::int AS handoffs,
            count(*) FILTER (WHERE h.status = 'whatsapp_clicked')::int AS whatsapp_clicks
     FROM handoffs h LEFT JOIN portfolios w ON w.id = h.portfolio_id AND w.company_id = h.company_id
     WHERE h.company_id = $1 AND h.created_at >= $2 AND h.created_at < $3 GROUP BY w.id, w.name ORDER BY handoffs DESC`,
    [companyId, f, t],
  );
  const visitStats = await q.query<{ visits: number; visitors: number }>(
    `SELECT count(*)::int AS visits, count(DISTINCT visitor_hash)::int AS visitors FROM events
     WHERE company_id = $1 AND is_visit AND created_at >= $2 AND created_at < $3`,
    [companyId, f, t],
  );
  // Ingresos por dispositivo, navegador y sistema (según la sesión que originó cada ingreso).
  const breakdown = async (col: 'device' | 'browser' | 'os') =>
    (
      await q.query<{ name: string; visits: number }>(
        `SELECT COALESCE(s.${col}, 'Desconocido') AS name, count(*)::int AS visits
         FROM events e JOIN public_sessions s ON s.id = e.session_id AND s.company_id = e.company_id
         WHERE e.company_id = $1 AND e.is_visit AND e.created_at >= $2 AND e.created_at < $3 GROUP BY 1 ORDER BY 2 DESC`,
        [companyId, f, t],
      )
    ).rows;
  const [byDevice, byBrowser, byOs] = await Promise.all([breakdown('device'), breakdown('browser'), breakdown('os')]);
  const visitsByDay = await q.query<{ day: string; type: string; total: number }>(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, 'visit' AS type, count(*)::int AS total FROM events
     WHERE company_id = $1 AND is_visit AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 1`,
    [companyId, f, t],
  );
  const byDay = await q.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, type, count(*)::int AS total FROM events
     WHERE company_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1, 2 ORDER BY 1`,
    [companyId, f, t],
  );
  const counts: Record<string, number> = {};
  const sessions: Record<string, number> = {};
  for (const r of totals.rows) {
    counts[r.type] = r.total;
    sessions[r.type] = r.sessions;
  }
  // "Ingresos" (visitas únicas por 30 min de inactividad) y visitantes distintos; page_view sigue siendo el total de vistas de página.
  counts.visit = visitStats.rows[0]?.visits ?? 0;
  sessions.visit = visitStats.rows[0]?.visitors ?? 0;
  const days = [...byDay.rows, ...visitsByDay.rows].sort((a: any, b: any) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { counts, sessions, byAdvisor: byAdvisor.rows, byPortfolio: byPortfolio.rows, byDay: days, byDevice, byBrowser, byOs };
}
