import type { Admin } from '../models/admins';
import type { Company } from '../models/companies';
import type { PublicSession } from '../models/public';
import type { Db, Queryable } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { normalize } from '../utils/text';
import { classify } from './intents';
import { extractVisitorData, type DataField, type Extracted } from './visitorData';

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

const REOPEN_SQL = `UPDATE chat_sessions SET status = CASE WHEN waiting_since IS NOT NULL AND current_advisor_id IS NULL THEN 'EN_ESPERA_ASESOR' ELSE 'BOT_ACTIVO' END,
  last_seen_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`;

/** Palabras de "quiero hablar con un asesor": sin ellas se ve si el mensaje traía además un tema. */
const HUMAN_FILLER = /\b(quiero|quisiera|necesito|deseo|me gustaria|puedo|podria|por favor|favor|hablar|comunicarme|comunicar|con|un|una|el|la|al|asesor|asesora|asesores|agente|operador|operadora|persona|humano|real|alguien|que|me|llamen|llame|contacten|contacte|atencion|humana|ahora|ya|urgente|porfa)\b/g;

/**
 * Veces que se piden los datos que faltan a quien va a pasar con un asesor: si el visitante deja de darlos tras
 * MAX_HANDOFF_DATA_REQUESTS pedidos sin avance, pasa igual a la cola y el asesor los pedirá. Mientras siga entregando
 * datos se le pide lo que falte, hasta MAX_HANDOFF_DATA_REQUESTS_HARD pedidos en total.
 */
export const MAX_HANDOFF_DATA_REQUESTS = 2;
export const MAX_HANDOFF_DATA_REQUESTS_HARD = 4;

export type { DataField };

/**
 * Datos que aún faltan para pasar la conversación a un asesor: nombre, documento y la cartera, esta última solo si la
 * empresa tiene más de una activa (con una sola no hay nada que elegir: se asigna sola al pasar a la cola).
 */
export function missingData(conv: Pick<LiveChatSession, 'visitor_name' | 'document' | 'portfolio_id'>, choosePortfolio: boolean): DataField[] {
  const missing: DataField[] = [];
  if (!conv.visitor_name) missing.push('name');
  if (!conv.document) missing.push('document');
  if (!conv.portfolio_id && choosePortfolio) missing.push('portfolio');
  return missing;
}

/** "tu nombre, tu número de documento y la cartera de tu consulta (A, B)". */
export function dataList(missing: DataField[], portfolios: string[]): string {
  const parts = missing.map((f) => f === 'name' ? 'tu nombre' : f === 'document' ? 'tu número de documento' : `la cartera de tu consulta (${portfolios.join(', ')})`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}` : parts[0] ?? '';
}

/** Lo que el bot ya hizo en esta conversación, leído de los metadatos de sus mensajes. */
export interface BotState {
  /** Último mensaje del bot: tipo y dato pedido ('handoff' = pidió los datos para pasar con un asesor). */
  lastKind: string | null;
  lastField: string | null;
  /** Veces que pidió los datos para pasar con un asesor desde la última vez que el visitante canceló. */
  handoffAsks: number;
  /** De esos pedidos, cuántos van desde la última vez que el visitante entregó algún dato (sin avance). */
  stalledAsks: number;
  /** Ya preguntó el nombre por iniciativa propia (solo se hace una vez). */
  nameAsked: boolean;
}

export async function botState(q: Queryable, companyId: string, conversationId: string): Promise<BotState> {
  const rows = (await q.query<{ kind: string | null; field: string | null; progress: string | null }>(
    `SELECT metadata->>'kind' AS kind, metadata->>'field' AS field, metadata->>'progress' AS progress FROM chat_messages
     WHERE company_id = $1 AND chat_session_id = $2 AND sender_type = 'BOT' ORDER BY created_at, id`, [companyId, conversationId])).rows;
  let handoffAsks = 0;
  let stalledAsks = 0;
  for (const r of rows) {
    if (r.kind === 'handoff_cancel') { handoffAsks = 0; stalledAsks = 0; }
    else if (r.kind === 'data_request' && r.field === 'handoff') {
      handoffAsks++;
      // Un pedido hecho justo después de recibir un dato reinicia la cuenta: el visitante está colaborando.
      stalledAsks = r.progress === 'true' ? 1 : stalledAsks + 1;
    }
  }
  const last = rows.at(-1);
  return {
    lastKind: last?.kind ?? null, lastField: last?.field ?? null, handoffAsks, stalledAsks,
    nameAsked: rows.some((r) => r.kind === 'data_request' && r.field === 'name'),
  };
}

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

export interface UserTurn {
  conversation: LiveChatSession;
  message: ChatMessage;
  created: boolean;
  /** El bot puede responder (activo o en espera de asesor); con un asesor al mando queda en silencio. */
  botMayReply: boolean;
  /** Dato que pidió el bot en su último mensaje ('name' | 'document' | 'portfolio' | 'handoff'). */
  lastBotField: string | null;
  /** Datos capturados en ESTE mensaje (ya guardados en la conversación). */
  captured: DataField[];
  extracted: Extracted;
}

/**
 * Paso 1 de cada turno: guarda el mensaje del visitante y los datos que trae (nombre, documento, cartera).
 * No decide respuestas ni escalamientos: eso lo hace liveBot.ts con el resultado.
 */
export async function startUserTurn(
  db: Db, company: Company, publicSession: PublicSession, message: string,
  profile: { portfolioKey?: string; document?: string; name?: string; subject?: string } = {},
): Promise<UserTurn> {
  return db.tx(async (q) => {
    const existed = await q.query('SELECT 1 FROM chat_sessions WHERE company_id = $1 AND public_session_id = $2', [company.id, publicSession.id]);
    const portfolios = (await q.query<{ id: string; key: string; name: string; aliases: string[] }>(
      'SELECT id, key, name, aliases FROM portfolios WHERE company_id = $1 AND active ORDER BY sort_order, name', [company.id])).rows;
    const initial = await ensureConversation(q, company.id, publicSession.id, profile);
    let current = (await q.query<LiveChatSession>('SELECT * FROM chat_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE', [initial.id, company.id])).rows[0];
    // El visitante volvió tras ser marcado como ausente: la conversación se reabre donde estaba.
    if (current.status === 'ABANDONADO') current = (await q.query<LiveChatSession>(REOPEN_SQL, [current.id, company.id])).rows[0];
    if (current.status === 'CERRADO' || current.status === 'REMITIDO_WHATSAPP') throw conflict('La conversación ya finalizó');

    const lastBot = (await q.query<{ kind: string | null; field: string | null }>(
      `SELECT metadata->>'kind' AS kind, metadata->>'field' AS field FROM chat_messages WHERE company_id = $1 AND chat_session_id = $2 AND sender_type = 'BOT'
       ORDER BY created_at DESC, id DESC LIMIT 1`, [company.id, current.id])).rows[0];
    const lastBotField = lastBot?.field ?? null;

    // Captura: el documento y la cartera se reconocen en cualquier mensaje; un nombre suelto solo si el bot lo pidió
    // (o si, tras ofrecerle un asesor, responde con sus datos: "Pedro Gómez 30000003").
    const askedName = current.visitor_name ? false
      : lastBotField === 'name' || lastBotField === 'handoff' ? true : lastBot?.kind === 'offer' ? 'weak' as const : false;
    const x = extractVisitorData(message, portfolios, askedName);
    const answering = (f: DataField) => lastBotField === f || lastBotField === 'handoff';
    const captured: DataField[] = [];
    let name = current.visitor_name;
    if (x.name && (!name || (x.nameExplicit && normalize(x.name) !== normalize(name)))) { name = x.name; captured.push('name'); }
    let document = current.document;
    if (x.document && x.document !== document && (!document || answering('document'))) { document = x.document; captured.push('document'); }
    let portfolio = current.portfolio_id;
    const found = x.portfolioKey ? portfolios.find((p) => p.key === x.portfolioKey) : undefined;
    if (found && found.id !== portfolio && (!portfolio || answering('portfolio'))) { portfolio = found.id; captured.push('portfolio'); }
    // El tema de la consulta (lo que verán el asesor y el WhatsApp) es el primer mensaje con contenido real, no un dato.
    const intent = classify(message);
    // "Quiero hablar con un asesor" no es un tema; "quiero hablar con un asesor sobre mi deuda" sí.
    const topic = intent === 'human' ? x.rest.replace(HUMAN_FILLER, ' ') : x.rest;
    const subject = !current.subject && topic.split(' ').filter((w) => w.length >= 3).length >= 2 && !['greeting', 'identity', 'thanks', 'help'].includes(intent)
      ? message.slice(0, 300) : current.subject;

    const conversation = (await q.query<LiveChatSession>(
      `UPDATE chat_sessions SET visitor_name = $3, document = $4, portfolio_id = $5, subject = $6,
         last_interaction_at = now(), last_seen_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
      [current.id, company.id, name, document, portfolio, subject],
    )).rows[0];
    const saved = (await q.query<ChatMessage>(
      `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, content) VALUES ($1,$2,'USER',$3) RETURNING *`,
      [company.id, current.id, message],
    )).rows[0];
    return {
      conversation, message: saved, created: existed.rows.length === 0, lastBotField, captured, extracted: x,
      botMayReply: conversation.status === 'BOT_ACTIVO' || conversation.status === 'EN_ESPERA_ASESOR',
    };
  });
}

export async function finishBotTurn(
  db: Db, companyId: string, conversationId: string, content: string, escalate = false, metadata: Record<string, unknown> = {},
  opts: { assignPortfolioId?: string | null } = {},
) {
  return db.tx(async (q) => {
    const current = (await q.query<LiveChatSession>('SELECT * FROM chat_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE', [conversationId, companyId])).rows[0];
    if (!current) throw notFound('Conversación no encontrada');
    // El bot responde mientras está activo o mientras el visitante espera a un asesor; al tomar el control se pausa.
    if (current.status !== 'BOT_ACTIVO' && current.status !== 'EN_ESPERA_ASESOR') return { conversation: current, message: null as ChatMessage | null };
    if (escalate && current.status === 'BOT_ACTIVO') {
      // Con una sola cartera activa no hay nada que preguntar: la conversación llega al panel ya con su cartera.
      const conversation = (await q.query<LiveChatSession>(
        `UPDATE chat_sessions SET status = 'EN_ESPERA_ASESOR', waiting_since = now(), portfolio_id = COALESCE(portfolio_id, $3::uuid),
           last_interaction_at = now(), updated_at = now()
         WHERE id = $1 AND company_id = $2 RETURNING *`, [conversationId, companyId, opts.assignPortfolioId ?? null],
      )).rows[0];
      const system = (await q.query<ChatMessage>(
        `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, content)
         VALUES ($1,$2,'SYSTEM',$3) RETURNING *`,
        [companyId, conversationId, content || 'Tu solicitud quedó en espera de un asesor. Puedes continuar escribiendo aquí.'],
      )).rows[0];
      return { conversation, message: system };
    }
    const message = (await q.query<ChatMessage>(
      `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, content, metadata) VALUES ($1,$2,'BOT',$3,$4::jsonb) RETURNING *`,
      [companyId, conversationId, content, JSON.stringify(metadata)],
    )).rows[0];
    await q.query('UPDATE chat_sessions SET last_interaction_at = now(), updated_at = now() WHERE id = $1', [conversationId]);
    return { conversation: current, message };
  });
}

/** Últimos mensajes de la conversación (sin el actual), para que el modelo tenga el hilo completo. */
export async function recentTurns(q: Queryable, companyId: string, conversationId: string, excludeId: string, limit = 6) {
  const r = await q.query<{ sender_type: SenderType; content: string }>(
    `SELECT sender_type, content FROM chat_messages WHERE company_id = $1 AND chat_session_id = $2 AND id <> $3
     ORDER BY created_at DESC, id DESC LIMIT $4`, [companyId, conversationId, excludeId, limit]);
  return r.rows.reverse().map((m) => ({ role: m.sender_type === 'USER' ? 'user' as const : 'assistant' as const, content: m.content }));
}

/** La página avisa que el visitante sigue activo (en cualquier parte del sitio). Si estaba marcado como ausente, se reabre. */
export async function touchConversation(q: Queryable, companyId: string, publicSessionId: string): Promise<{ status: ChatStatus | null; reopened: boolean }> {
  const r = await q.query<LiveChatSession>('UPDATE chat_sessions SET last_seen_at = now() WHERE company_id = $1 AND public_session_id = $2 RETURNING *', [companyId, publicSessionId]);
  if (r.rows[0]?.status === 'ABANDONADO') return { status: (await q.query<LiveChatSession>(REOPEN_SQL, [r.rows[0].id, companyId])).rows[0].status, reopened: true };
  return { status: r.rows[0]?.status ?? null, reopened: false };
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
       AND GREATEST(last_interaction_at, COALESCE(last_seen_at, last_interaction_at)) < now() - interval '5 minutes'`, [companyId],
  );
  const values: unknown[] = [companyId, admin.role === 'advisor' ? admin.advisor_id : null];
  let where = `s.company_id = $1 AND ($2::uuid IS NULL OR EXISTS (
    SELECT 1 FROM advisor_portfolios ap WHERE ap.company_id = s.company_id AND ap.advisor_id = $2 AND ap.portfolio_id = s.portfolio_id))`;
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where += ` AND ${sql.split('?').join(`$${values.length}`)}`;
  };
  // Vista "live": solo lo que sigue en curso. Vista "history": remitidos, cerrados y abandonados (siguen guardados en la base).
  if (filters.view === 'live') where += ` AND s.status IN ('BOT_ACTIVO','EN_ESPERA_ASESOR','TOMADO_POR_ASESOR')`;
  if (filters.view === 'history') where += ` AND s.status IN ('REMITIDO_WHATSAPP','CERRADO','ABANDONADO')`;
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

