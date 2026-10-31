import type { Admin } from '../models/admins';
import type { Company } from '../models/companies';
import type { PublicSession } from '../models/public';
import type { Db, Queryable } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { normalize } from '../utils/text';

export type ChatStatus = 'BOT_ACTIVO' | 'EN_ESPERA_ASESOR' | 'TOMADO_POR_ASESOR' | 'REMITIDO_WHATSAPP' | 'CERRADO' | 'ABANDONADO';
export type SenderType = 'USER' | 'BOT' | 'ADVISOR' | 'SYSTEM';

export interface LiveChatSession {
  id: string; company_id: string; public_session_id: string; portfolio_id: string | null;
  document: string | null; visitor_name: string | null; subject: string; status: ChatStatus;
  current_advisor_id: string | null; pending_transfer_to: string | null; waiting_since: string | null;
  taken_at: string | null; started_at: string; last_interaction_at: string; closed_at: string | null;
  close_reason: string | null; summary: string;
}

export interface ChatMessage {
  id: string; chat_session_id: string; sender_type: SenderType; advisor_id: string | null;
  advisor_name?: string | null; content: string; metadata?: Record<string, unknown>; created_at: string;
}

const HUMAN_RE = /\b(asesor|asesora|agente|persona|humano|representante|hablar con alguien|atencion humana)\b/i;

async function portfolioId(q: Queryable, companyId: string, key?: string): Promise<string | null> {
  if (!key) return null;
  const r = await q.query<{ id: string }>('SELECT id FROM portfolios WHERE company_id = $1 AND key = $2 AND active', [companyId, key]);
  if (!r.rows[0]) throw badRequest('Cartera inexistente o inactiva');
  return r.rows[0].id;
}

export async function ensureConversation(
  q: Queryable, companyId: string, publicSessionId: string,
  profile: { portfolioKey?: string; document?: string; name?: string; subject?: string } = {},
): Promise<LiveChatSession> {
  const pid = await portfolioId(q, companyId, profile.portfolioKey);
  return (await q.query<LiveChatSession>(
    `INSERT INTO chat_sessions (company_id, public_session_id, portfolio_id, document, visitor_name, subject)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (public_session_id) DO UPDATE SET
       portfolio_id = COALESCE(chat_sessions.portfolio_id, EXCLUDED.portfolio_id),
       document = COALESCE(chat_sessions.document, EXCLUDED.document),
       visitor_name = COALESCE(chat_sessions.visitor_name, EXCLUDED.visitor_name),
       subject = CASE WHEN chat_sessions.subject = '' THEN EXCLUDED.subject ELSE chat_sessions.subject END,
       updated_at = now()
     RETURNING *`,
    [companyId, publicSessionId, pid, profile.document ?? null, profile.name ?? null, profile.subject ?? ''],
  )).rows[0];
}

export async function startUserTurn(
  db: Db, company: Company, publicSession: PublicSession, message: string,
  profile: { portfolioKey?: string; document?: string; name?: string; subject?: string } = {},
): Promise<{ conversation: LiveChatSession; message: ChatMessage; botMayReply: boolean; escalated: boolean; created: boolean }> {
  return db.tx(async (q) => {
    const existed = await q.query('SELECT 1 FROM chat_sessions WHERE company_id = $1 AND public_session_id = $2', [company.id, publicSession.id]);
    const inferred = { ...profile };
    if (!inferred.document) inferred.document = message.match(/\b\d{5,15}\b/)?.[0];
    if (!inferred.portfolioKey) {
      const text = normalize(message);
      const portfolios = await q.query<{ key: string; name: string; aliases: string[] }>('SELECT key, name, aliases FROM portfolios WHERE company_id = $1 AND active ORDER BY sort_order, name', [company.id]);
      inferred.portfolioKey = portfolios.rows.find((p) => [p.key, p.name, ...(p.aliases ?? [])].some((term) => text.includes(normalize(term))))?.key;
    }
    if (!inferred.subject && !/^\s*(hola|buenas|buenos dias)\b/i.test(normalize(message))) inferred.subject = message.slice(0, 300);
    const initial = await ensureConversation(q, company.id, publicSession.id, inferred);
    const locked = (await q.query<LiveChatSession>('SELECT * FROM chat_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE', [initial.id, company.id])).rows[0];
    if (locked.status === 'CERRADO' || locked.status === 'REMITIDO_WHATSAPP') throw conflict('La conversación ya finalizó');
    const escalate = HUMAN_RE.test(message) && locked.status === 'BOT_ACTIVO';
    const nextStatus = escalate ? 'EN_ESPERA_ASESOR' : locked.status;
    const conversation = (await q.query<LiveChatSession>(
      `UPDATE chat_sessions SET status = $3, waiting_since = CASE WHEN $3 = 'EN_ESPERA_ASESOR' THEN COALESCE(waiting_since, now()) ELSE waiting_since END,
         last_interaction_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
      [locked.id, company.id, nextStatus],
    )).rows[0];
    const saved = (await q.query<ChatMessage>(
      `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, content) VALUES ($1,$2,'USER',$3) RETURNING *`,
      [company.id, locked.id, message],
    )).rows[0];
    return { conversation, message: saved, botMayReply: nextStatus === 'BOT_ACTIVO', escalated: escalate, created: existed.rows.length === 0 };
  });
}

export async function finishBotTurn(db: Db, companyId: string, conversationId: string, content: string, escalate = false) {
  return db.tx(async (q) => {
    const current = (await q.query<LiveChatSession>('SELECT * FROM chat_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE', [conversationId, companyId])).rows[0];
    if (!current) throw notFound('Conversación no encontrada');
    if (current.status !== 'BOT_ACTIVO') return { conversation: current, message: null as ChatMessage | null };
    if (escalate) {
      const conversation = (await q.query<LiveChatSession>(
        `UPDATE chat_sessions SET status = 'EN_ESPERA_ASESOR', waiting_since = now(), last_interaction_at = now(), updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING *`, [conversationId, companyId],
      )).rows[0];
      const system = (await q.query<ChatMessage>(
        `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, content)
         VALUES ($1,$2,'SYSTEM',$3) RETURNING *`,
        [companyId, conversationId, content || 'Tu solicitud quedó en espera de un asesor. Puedes continuar escribiendo aquí.'],
      )).rows[0];
      return { conversation, message: system };
    }
    const message = (await q.query<ChatMessage>(
      `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, content) VALUES ($1,$2,'BOT',$3) RETURNING *`,
      [companyId, conversationId, content],
    )).rows[0];
    await q.query('UPDATE chat_sessions SET last_interaction_at = now(), updated_at = now() WHERE id = $1', [conversationId]);
    return { conversation: current, message };
  });
}

export async function publicConversation(q: Queryable, companyId: string, publicSessionId: string) {
  const conversation = (await q.query<LiveChatSession>('SELECT * FROM chat_sessions WHERE company_id = $1 AND public_session_id = $2', [companyId, publicSessionId])).rows[0] ?? null;
  if (!conversation) return { conversation: null, messages: [] as ChatMessage[] };
  const messages = (await q.query<ChatMessage>(
    `SELECT m.id, m.chat_session_id, m.sender_type, m.advisor_id, a.name AS advisor_name, m.content, m.metadata, m.created_at
     FROM chat_messages m LEFT JOIN advisors a ON a.id = m.advisor_id AND a.company_id = m.company_id
     WHERE m.company_id = $1 AND m.chat_session_id = $2 ORDER BY m.created_at, m.id`, [companyId, conversation.id],
  )).rows;
  return { conversation, messages };
}

export async function advisorCanAccess(q: Queryable, admin: Admin, companyId: string, portfolio: string | null) {
  if (admin.role !== 'advisor') return true;
  if (!admin.advisor_id || !portfolio) return false;
  const r = await q.query('SELECT 1 FROM advisor_portfolios WHERE company_id = $1 AND advisor_id = $2 AND portfolio_id = $3', [companyId, admin.advisor_id, portfolio]);
  return r.rows.length > 0;
}

export async function listConversations(q: Queryable, companyId: string, admin: Admin, filters: Record<string, string | undefined>) {
  await q.query(
    `UPDATE chat_sessions SET status = 'ABANDONADO', updated_at = now()
     WHERE company_id = $1 AND status IN ('BOT_ACTIVO','EN_ESPERA_ASESOR')
       AND last_interaction_at < now() - interval '30 minutes'`, [companyId],
  );
  const values: unknown[] = [companyId, admin.role === 'advisor' ? admin.advisor_id : null];
  let where = `s.company_id = $1 AND ($2::uuid IS NULL OR EXISTS (
    SELECT 1 FROM advisor_portfolios ap WHERE ap.company_id = s.company_id AND ap.advisor_id = $2 AND ap.portfolio_id = s.portfolio_id))`;
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where += ` AND ${sql.split('?').join(`$${values.length}`)}`;
  };
  if (filters.status) add('s.status = ?', filters.status);
  if (filters.portfolioId) add('s.portfolio_id = ?::uuid', filters.portfolioId);
  if (filters.advisorId) add('s.current_advisor_id = ?::uuid', filters.advisorId);
  if (filters.search) add(`(s.document ILIKE '%' || ? || '%' OR s.visitor_name ILIKE '%' || ? || '%' OR s.id::text ILIKE '%' || ? || '%')`, filters.search);
  if (filters.from && !Number.isNaN(Date.parse(filters.from))) add('s.started_at >= ?::timestamptz', new Date(filters.from).toISOString());
  if (filters.to && !Number.isNaN(Date.parse(filters.to))) add('s.started_at <= ?::timestamptz', new Date(filters.to).toISOString());
  if (filters.pending === 'true') where += ` AND s.status = 'EN_ESPERA_ASESOR'`;
  return (await q.query<any>(
    `SELECT s.*, p.name AS portfolio_name, a.name AS advisor_name, m.content AS last_message,
       GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(s.waiting_since, s.last_interaction_at)))::int) AS waiting_seconds
     FROM chat_sessions s
     LEFT JOIN portfolios p ON p.id = s.portfolio_id AND p.company_id = s.company_id
     LEFT JOIN advisors a ON a.id = s.current_advisor_id AND a.company_id = s.company_id
     LEFT JOIN LATERAL (SELECT content FROM chat_messages WHERE chat_session_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1) m ON true
     WHERE ${where} ORDER BY CASE s.status WHEN 'EN_ESPERA_ASESOR' THEN 0 WHEN 'TOMADO_POR_ASESOR' THEN 1 ELSE 2 END, s.last_interaction_at DESC LIMIT 200`, values,
  )).rows;
}

export async function getConversationForAdmin(q: Queryable, companyId: string, chatId: string, admin: Admin) {
  const conversation = (await q.query<any>(
    `SELECT s.*, p.name AS portfolio_name, a.name AS advisor_name FROM chat_sessions s
     LEFT JOIN portfolios p ON p.id = s.portfolio_id AND p.company_id = s.company_id
     LEFT JOIN advisors a ON a.id = s.current_advisor_id AND a.company_id = s.company_id
     WHERE s.id = $1 AND s.company_id = $2`, [chatId, companyId],
  )).rows[0];
  if (!conversation || !(await advisorCanAccess(q, admin, companyId, conversation.portfolio_id))) throw notFound('Conversación no encontrada');
  const messages = (await q.query<any>(
    `SELECT m.*, a.name AS advisor_name FROM chat_messages m LEFT JOIN advisors a ON a.id = m.advisor_id AND a.company_id = m.company_id
     WHERE m.chat_session_id = $1 AND m.company_id = $2 ORDER BY m.created_at, m.id`, [chatId, companyId],
  )).rows;
  return { conversation, messages };
}

export function actorAdvisor(admin: Admin): string {
  if (!admin.advisor_id) throw forbidden('La cuenta no está vinculada a un asesor');
  return admin.advisor_id;
}

export function ownerOrManager(admin: Admin, conversation: LiveChatSession) {
  if (admin.role !== 'advisor') return;
  if (!admin.advisor_id || conversation.current_advisor_id !== admin.advisor_id) throw forbidden('Solo el asesor dueño o un administrador puede realizar esta acción');
}

export async function auditChat(q: Queryable, admin: Admin, companyId: string, chatId: string, action: string, before: unknown, after: unknown) {
  await q.query(
    `INSERT INTO chat_audit_logs (company_id, chat_session_id, admin_id, advisor_id, action, before_data, after_data)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [companyId, chatId, admin.id, admin.advisor_id ?? null, action, JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
  );
}

export async function lockConversation(q: Queryable, companyId: string, chatId: string): Promise<LiveChatSession> {
  const row = (await q.query<LiveChatSession>('SELECT * FROM chat_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE', [chatId, companyId])).rows[0];
  if (!row) throw notFound('Conversación no encontrada');
  return row;
}

