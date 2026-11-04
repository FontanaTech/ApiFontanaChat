import type { Admin } from '../models/admins';
import type { Company } from '../models/companies';
import type { PublicSession } from '../models/public';
import type { Db, Queryable } from '../db';
import { conflict, forbidden, notFound } from '../utils/errors';
import { normalize } from '../utils/text';
import { analyze, COMMERCIAL_RE, HUMAN_NEGATED, isCancel, isHold, isRefuse, isWaitQuestion, isWhyData, mentionsCase, topicText, yesNo } from './intents';
import { FIRST_NAMES } from './lexicon';
import { deniedName, extractVisitorData, namedPortfolios, type CaptureContext, type DataField, type Extracted } from './visitorData';

export type ChatStatus = 'BOT_ACTIVO' | 'EN_ESPERA_ASESOR' | 'TOMADO_POR_ASESOR' | 'REMITIDO_WHATSAPP' | 'CERRADO' | 'ABANDONADO';
export type SenderType = 'USER' | 'BOT' | 'ADVISOR' | 'SYSTEM';

export interface LiveChatSession {
  id: string; company_id: string; public_session_id: string; portfolio_id: string | null;
  document: string | null; visitor_name: string | null; subject: string; status: ChatStatus;
  current_advisor_id: string | null; pending_transfer_to: string | null; waiting_since: string | null;
  taken_at: string | null; started_at: string; last_interaction_at: string; closed_at: string | null;
  close_reason: string | null; summary: string;
  /** La cartera la puso el sistema al pasar a la cola (no la eligió el visitante): la que diga después la reemplaza. */
  portfolio_auto?: boolean;
}

export interface ChatMessage {
  id: string; chat_session_id: string; sender_type: SenderType; advisor_id: string | null;
  advisor_name?: string | null; content: string; metadata?: Record<string, unknown>; created_at: string;
}

const REOPEN_SQL = `UPDATE chat_sessions SET status = CASE WHEN waiting_since IS NOT NULL AND current_advisor_id IS NULL THEN 'EN_ESPERA_ASESOR' ELSE 'BOT_ACTIVO' END,
  last_seen_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`;

/** Palabras de "quiero hablar con un asesor": sin ellas se ve si el mensaje traía además un tema. */
const HUMAN_FILLER = /\b(quiero|quisiera|necesito|deseo|me gustaria|gustaria|puedo|podria|podrian|pueden|puede|puedes|podrias|por favor|favor|hablar|comunicarme|comunicar|comunicaran|comunicara|contactar|contactarme|pasar|pasarme|pasen|pase|pasame|paseme|pasenme|pasas|pasa|pases|pasarias|comunicame|comuniqueme|comuniquenme|comunicas|comunican|conectame|conecteme|conectenme|conectas|conectar|conectarme|transfiereme|transfierame|transfieranme|con|un|una|el|la|al|los|las|de|sus|mi|tu|su|este|esta|ese|esa|alguno|alguna|algun|hay|disponible|disponibles|asesor|asesora|asesores|asesoras|agente|agentes|operador|operadora|persona|humano|real|alguien|gerente|encargado|encargada|jefe|jefa|supervisor|supervisora|coordinador|coordinadora|director|directora|funcionario|funcionaria|representante|ejecutivo|ejecutiva|otro|que|me|nos|llamar|llamarme|llamen|llame|llamara|contacten|contacte|atencion|humana|ahora|ya|urgente|porfa|porfavor|otra|vez|nuevamente|nuevo|directamente|mismo|ser|atendido|atendida|por|gracias|dame|deme)\b/g;
/** "¿Me puedes pasar con uno?" tras nombrar a un asesor: pide uno, no trae un tema. */
const REFERS_ONE = /\b(pasar|pasarme|pasas|pasame|paseme|comunicar|comunicarme|comunicas|hablar|conectar|conectarme|conectas) con (uno|una|el|ella)\b/;
/** "La primera", "la segunda opción", "la última": elige entre las carteras que nombró el bot. */
const ORDINALS = ['primero', 'segundo', 'tercero', 'cuarto'];
const ORDINAL = /^(?:(?:es|seria|creo que)\s+)?(?:la |el )?(primera|primero|segunda|segundo|tercera|tercero|cuarta|cuarto|ultima|ultimo)(?: opcion| de (?:esas|esos|las dos|los dos))?(?: (?:por favor|gracias))?$/;

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
  /**
   * Último mensaje del lado del bot: tipo y dato pedido ('handoff' = pidió los datos para pasar con un asesor).
   * 'system' = un aviso del sistema (pasó a la cola, un asesor tomó o devolvió el chat).
   */
  lastKind: string | null;
  lastField: string | null;
  /** Veces que pidió los datos para pasar con un asesor desde la última vez que se canceló o pasó a la cola. */
  handoffAsks: number;
  /** De esos pedidos, cuántos van desde la última vez que el visitante entregó algún dato (sin avance). */
  stalledAsks: number;
  /** Ya preguntó el nombre por iniciativa propia (solo se hace una vez). */
  nameAsked: boolean;
  /** Texto del último mensaje del bot o del sistema: no se repite el mismo mensaje dos veces seguidas. */
  lastText: string | null;
  /**
   * Datos que ya no se piden en esta toma ("es de Dupree": la cartera no es de la empresa y el asesor la confirma).
   * Se olvidan, como la toma, al cancelar, pasar a la cola o con un aviso del sistema.
   */
  waived: Set<DataField>;
  /**
   * Lo que el bot dijo en esta toma de datos (desde la última vez que se canceló, pasó a la cola o hubo un aviso):
   * así recuerda, p. ej., entre qué carteras le preguntó ("¿Tu consulta es de Flamingo o de Offcorss?").
   */
  collectTexts: string[];
}

export async function botState(q: Queryable, companyId: string, conversationId: string): Promise<BotState> {
  const rows = (await q.query<{ sender_type: SenderType; kind: string | null; field: string | null; progress: string | null; waived: string | null; content: string }>(
    `SELECT sender_type, metadata->>'kind' AS kind, metadata->>'field' AS field, metadata->>'progress' AS progress,
       metadata->>'waived' AS waived, content FROM chat_messages
     WHERE company_id = $1 AND chat_session_id = $2 AND sender_type IN ('BOT','SYSTEM') ORDER BY created_at, id`, [companyId, conversationId])).rows;
  let handoffAsks = 0;
  let stalledAsks = 0;
  let waived = new Set<DataField>();
  let collectTexts: string[] = [];
  for (const r of rows) {
    // Cancelar, pasar a la cola, o que un asesor tome o devuelva el chat cierran la toma de datos: empieza de cero.
    if (r.sender_type === 'SYSTEM' || r.kind === 'handoff_cancel') { handoffAsks = 0; stalledAsks = 0; waived = new Set(); collectTexts = []; continue; }
    collectTexts.push(r.content);
    if (r.kind === 'data_request' && r.field === 'handoff') {
      handoffAsks++;
      // Un pedido hecho justo después de recibir un dato reinicia la cuenta: el visitante está colaborando.
      stalledAsks = r.progress === 'true' ? 1 : stalledAsks + 1;
    }
    if (r.waived) for (const f of r.waived.split(',')) if (f === 'name' || f === 'document' || f === 'portfolio') waived.add(f);
  }
  const last = rows.at(-1);
  return {
    lastKind: last ? (last.sender_type === 'SYSTEM' ? 'system' : last.kind) : null,
    lastField: last && last.sender_type === 'BOT' ? last.field : null,
    handoffAsks, stalledAsks, waived, collectTexts: collectTexts.slice(-6),
    // Pedir los datos para el asesor también pregunta el nombre: si no lo dio, no se le vuelve a preguntar.
    nameAsked: rows.some((r) => r.kind === 'data_request' && (r.field === 'name' || r.field === 'handoff')),
    lastText: last?.content ?? null,
  };
}

/**
 * Cartera que envía el widget. Una clave que ya no existe o está desactivada se ignora (el visitante no puede
 * corregirla y bloquearía todo el chat): la cartera se pregunta o se asigna como si no hubiera llegado.
 */
async function portfolioId(q: Queryable, companyId: string, key?: string): Promise<string | null> {
  if (!key) return null;
  const r = await q.query<{ id: string }>('SELECT id FROM portfolios WHERE company_id = $1 AND key = $2 AND active', [companyId, key]);
  return r.rows[0]?.id ?? null;
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
  /** Dato que pidió el bot en su último mensaje ('name' | 'handoff'); null si lo último fue un aviso del sistema. */
  lastBotField: string | null;
  /** Datos capturados en ESTE mensaje (ya guardados en la conversación). */
  captured: DataField[];
  /** De esos, los que corrigieron un dato que ya estaba ("perdón, mi cédula es…"). */
  replaced: DataField[];
  /** Datos que el visitante negó en este mensaje y se borraron ("no me llamo Pedro" con "Pedro" guardado). */
  cleared: DataField[];
  extracted: Extracted;
}

/**
 * Paso 1 de cada turno: guarda el mensaje del visitante y los datos que trae (nombre, documento, cartera).
 * No decide respuestas ni escalamientos: eso lo hace liveBot.ts con el resultado.
 *
 * Solo se toma un dato suelto (un nombre sin "me llamo", un número sin "cédula") cuando el bot lo está pidiendo y la
 * conversación sigue con el bot. En la cola o con un asesor al mando solo cuentan los datos dichos de forma explícita
 * ("mi cédula es…", "me llamo…"), y la cartera no cambia mientras un asesor atiende (perdería el acceso al chat).
 */
export async function startUserTurn(
  db: Db, company: Company, publicSession: PublicSession, message: string,
  profile: { portfolioKey?: string; document?: string; name?: string; subject?: string } = {},
  opts: { companyNumbers?: Set<string>; siteWords?: Set<string> } = {},
): Promise<UserTurn> {
  return db.tx(async (q) => {
    const existed = await q.query('SELECT 1 FROM chat_sessions WHERE company_id = $1 AND public_session_id = $2', [company.id, publicSession.id]);
    const portfolios = (await q.query<{ id: string; key: string; name: string; aliases: string[]; is_default: boolean }>(
      'SELECT id, key, name, aliases, is_default FROM portfolios WHERE company_id = $1 AND active ORDER BY sort_order, name', [company.id])).rows;
    const initial = await ensureConversation(q, company.id, publicSession.id, profile);
    let current = (await q.query<LiveChatSession>('SELECT * FROM chat_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE', [initial.id, company.id])).rows[0];
    // El visitante volvió tras ser marcado como ausente: la conversación se reabre donde estaba.
    if (current.status === 'ABANDONADO') current = (await q.query<LiveChatSession>(REOPEN_SQL, [current.id, company.id])).rows[0];
    if (current.status === 'CERRADO' || current.status === 'REMITIDO_WHATSAPP') throw conflict('La conversación ya finalizó');

    // Lo último del lado del bot (su mensaje o un aviso del sistema): dice qué estaba pidiendo.
    const lastBot = (await q.query<{ sender_type: SenderType; kind: string | null; field: string | null; content: string }>(
      `SELECT sender_type, metadata->>'kind' AS kind, metadata->>'field' AS field, content FROM chat_messages
       WHERE company_id = $1 AND chat_session_id = $2 AND sender_type IN ('BOT','SYSTEM')
       ORDER BY created_at DESC, id DESC LIMIT 1`, [company.id, current.id])).rows[0];
    const withBot = current.status === 'BOT_ACTIVO';
    const lastBotField = lastBot?.sender_type === 'BOT' ? lastBot.field : null;
    const choosePortfolio = portfolios.length > 1;
    // Una cartera que se desactivó después cuenta como no elegida.
    const hasPortfolio = !!current.portfolio_id && portfolios.some((p) => p.id === current.portfolio_id);
    // La que puso el sistema al pasar a la cola tampoco la eligió el visitante: la que diga después la reemplaza.
    const autoPortfolio = hasPortfolio && !!current.portfolio_auto;
    const missing = missingData({ ...current, portfolio_id: hasPortfolio && !autoPortfolio ? current.portfolio_id : null }, choosePortfolio);
    // En la cola sin asesor, si faltan datos, se toman los que llegan claros (el aviso dijo que el asesor los pedirá).
    const asked: CaptureContext['asked'] = !withBot ? (current.status === 'EN_ESPERA_ASESOR' && missing.length > 0 ? 'queue' : null)
      : lastBotField === 'handoff' ? 'handoff'
        : lastBotField === 'name' && !current.visitor_name ? 'name'
          : lastBot?.kind === 'offer' && !current.visitor_name ? 'offer' : null;
    // El nombre guardado es una sola palabra poco común ("Comfandi", que dio al preguntarle el nombre): si llega uno
    // completo y claro ("Juan Pérez 1020304050"), lo reemplaza.
    const savedName = current.visitor_name?.trim() ?? '';
    const nameLoose = !!savedName && !/\s/.test(savedName) && !FIRST_NAMES.has(normalize(savedName));
    // Con una sola cartera activa no hay nada que elegir: no se busca en el texto (se asigna al pasar a la cola).
    const x = extractVisitorData(message, choosePortfolio ? portfolios : [], {
      asked, missing, companyNumbers: opts.companyNumbers, siteWords: opts.siteWords, nameLoose: withBot && nameLoose, savedName: current.visitor_name,
    });
    // "¿Tu consulta es de Flamingo o de Offcorss?" → "la primera": la cartera es la que nombró el bot en ese orden.
    if (choosePortfolio && !x.portfolioKey && asked === 'handoff' && missing.includes('portfolio')) {
      const pick = ORDINAL.exec(normalize(message));
      if (pick) {
        const offered = namedPortfolios(lastBot?.content ?? '', portfolios).list;
        const options = offered.length >= 2 ? offered : portfolios;
        const chosen = pick[1].startsWith('ultim') ? options.at(-1) : options[ORDINALS.indexOf(pick[1].replace(/a$/, 'o'))];
        if (chosen) x.portfolioKey = chosen.key;
      }
    }

    const captured: DataField[] = [];
    const replaced: DataField[] = [];
    const cleared: DataField[] = [];
    const take = (field: DataField, had: unknown) => { captured.push(field); if (had) replaced.push(field); };
    let name = current.visitor_name;
    // Un nombre suelto no sale de un mensaje que cancela o pregunta para qué ("olvídalo, ¿cuál es el correo?"). Uno que
    // niega otro dato sí lo trae ("Juan Pérez, no tengo la cédula a la mano"): la negativa se lee aparte.
    const looseOk = x.nameExplicit || !(isCancel(message) || isWhyData(message));
    if (!looseOk) x.name = undefined;
    const fullName = !!x.name && x.name.trim().split(/\s+/).length >= 2;
    if (x.name && (!name || (x.nameExplicit && normalize(x.name) !== normalize(name)) || (nameLoose && fullName && normalize(x.name) !== normalize(name)))) {
      take('name', name && !nameLoose ? name : null);
      name = x.name;
    } else if (!x.name && name) {
      // "No me llamo Pedro" con "Pedro" guardado: se borra y el bot lo vuelve a pedir.
      const denied = deniedName(message);
      if (denied && normalize(name).split(' ')[0] === denied.split(' ')[0]) { name = null; cleared.push('name'); }
    }
    let document = current.document;
    if (x.document && x.document !== document && (!document || x.documentExplicit)) { take('document', document); document = x.document; }
    let portfolio = hasPortfolio ? current.portfolio_id : null;
    let portfolioAuto = autoPortfolio;
    const found = x.portfolioKey ? portfolios.find((p) => p.key === x.portfolioKey) : undefined;
    // Ya elegida, solo cambia si la corrige ("es con X", "perdón, es de X"), no si menciona otra ("también tengo una
    // deuda con X"). En la cola hace falta una corrección; con un asesor al mando no cambia (perdería el acceso al chat).
    // La que puso el sistema se reemplaza con la que diga el visitante (y no cuenta como corrección).
    const also = /\b(tambien|ademas|otra deuda|otras deudas|otra cartera|otro credito|otra obligacion)\b/.test(normalize(message));
    const portfolioMayChange = current.status !== 'TOMADO_POR_ASESOR'
      && (!portfolio || autoPortfolio || (!!x.portfolioExplicit && !also && (withBot || !!x.correction)));
    if (found && found.id !== portfolio && portfolioMayChange) {
      take('portfolio', hasPortfolio && !autoPortfolio ? portfolio : null);
      portfolio = found.id;
      portfolioAuto = false;
    } else if (found && found.id === portfolio && autoPortfolio && current.status !== 'TOMADO_POR_ASESOR') {
      take('portfolio', null); // confirmó la que ya tenía asignada
      portfolioAuto = false;
    } else if (!found && current.status === 'EN_ESPERA_ASESOR' && choosePortfolio && hasPortfolio && !autoPortfolio) {
      // En la cola, "no es Flamingo" con Flamingo elegida: deja de ser la suya. Pasa a la cartera por defecto, marcada como
      // puesta por el sistema, para que algún asesor la vea y la confirme; el bot le pregunta cuál es.
      const said = namedPortfolios(message, portfolios);
      if (said.negated && said.list.some((p) => p.id === portfolio)) {
        portfolio = portfolios.find((p) => p.is_default)?.id ?? portfolio;
        portfolioAuto = true;
        cleared.push('portfolio');
      }
    }

    // El tema de la consulta (lo que verán el asesor y el WhatsApp) es el primer mensaje con contenido real: no un
    // dato, un saludo, un pedido de asesor sin tema, una respuesta a la toma de datos ni una pregunta por la espera.
    const { intent, rest } = analyze(message);
    const nm = normalize(message);
    const hadData = !!(x.document || x.name || x.portfolioKey || x.phone);
    // "No quiero que me llamen más, ¿cuánto debo?": la negativa no es el tema, lo demás sí.
    const negated = HUMAN_NEGATED.test(nm);
    const base = negated ? topicText(message) : hadData ? x.rest : rest;
    // "Quiero hablar con un asesor" o "páseme con el gerente" no son un tema; "quiero hablar con un asesor sobre mi deuda" sí.
    const topic = intent === 'human' || REFERS_ONE.test(nm) ? base.replace(HUMAN_FILLER, ' ') : base;
    // Responder a la toma de datos con algo corto ("es de Falabella", "Bancolombia") no es el tema de la consulta.
    const dataReply = (asked === 'handoff' || asked === 'name') && intent === 'other' && !/[?¿]/.test(message) && rest.split(' ').length <= 4;
    // Mientras se le piden los datos, solo un asunto suyo es el tema ("es por una deuda que ya pagué"); una pregunta
    // por el documento, el correo o la espera no ("¿sirve el pasaporte?", "Juan Pérez 1020304050 y cuál es el correo").
    const collectingReply = asked === 'handoff' && intent !== 'sensitive' && !mentionsCase(normalize(topic)) && !COMMERCIAL_RE.test(nm);
    // "No soy Pedro, me confundiste" o "no me llamo Pedro" corrigen el nombre: no son el tema.
    const deniesName = cleared.includes('name') || !!deniedName(message);
    const topical = topic.split(' ').filter((w) => w.length >= 3).length >= 2 && rest.length > 0 && !dataReply && !collectingReply
      && (withBot ? ['other', 'sensitive', 'human'].includes(intent) : intent === 'sensitive')
      && !isCancel(message) && !isRefuse(message) && !isHold(message) && !isWaitQuestion(message) && !isWhyData(message) && yesNo(message) === null
      && !(x.correction && hadData) && !deniesName;
    // "No me pases con ningún asesor, solo dime el correo": el tema es lo que pide, sin la negativa.
    const subject = !current.subject && topical ? subjectText(negated ? withoutAdvisorRefusal(message) : message, x).slice(0, 300) : current.subject;

    const conversation = (await q.query<LiveChatSession>(
      `UPDATE chat_sessions SET visitor_name = $3, document = $4, portfolio_id = $5, subject = $6, portfolio_auto = $7,
         last_interaction_at = now(), last_seen_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
      [current.id, company.id, name, document, portfolio, subject, portfolioAuto],
    )).rows[0];
    const saved = (await q.query<ChatMessage>(
      `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, content) VALUES ($1,$2,'USER',$3) RETURNING *`,
      [company.id, current.id, message],
    )).rows[0];
    return {
      conversation, message: saved, created: existed.rows.length === 0, lastBotField, captured, replaced, cleared, extracted: x,
      botMayReply: conversation.status === 'BOT_ACTIVO' || conversation.status === 'EN_ESPERA_ASESOR',
    };
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Letra con o sin tilde: el nombre guardado ("Pérez") se busca igual si lo escribió sin tilde ("perez"). */
const LOOSE_LETTER: Record<string, string> = { a: '[aáà]', e: '[eéè]', i: '[iíì]', o: '[oóò]', u: '[uúüù]', n: '[nñ]' };
const loosePattern = (word: string) => [...normalize(word)].map((c) => LOOSE_LETTER[c] ?? escapeRe(c)).join('');
const GREET = String.raw`(?:(?:hola|buenas(?:\s+(?:tardes|noches))?|buenos\s+d[ií]as|buen\s+d[ií]a)[,!.\s]+)`;
const INTRO = String.raw`(?:me\s+llamo|mi\s+nombre\s+(?:completo\s+)?es|mi\s+nombre|soy|le\s+escribe|te\s+escribe|les\s+escribe|le\s+habla|te\s+habla|les\s+habla|habla|de\s+parte\s+de)`;
/** "Mi cédula es…", "identificado con cédula…", "con NIT…", "y mi cc es…": la frase que acompaña al documento. */
const DOC_LEAD = String.raw`(?:(?:,\s*|\s+)(?:y|e)\s+)?(?:identificad[oa]s?\s+con\s+|con\s+)?(?:(?:mi|el|la|su)\s+)?(?:n[uú]mero\s+de\s+)?(?:c\.?\s?c\.?|c[eé]dula(?:\s+de\s+(?:ciudadan[ií]a|extranjer[ií]a))?|documento(?:\s+de\s+identidad)?|nit|pasaporte|ppt|identificaci[oó]n|n[uú]mero)?\s*(?:es\s+|no\.?\s*|#\s*|:\s*)?`;
/**
 * El tema tal como lo escribió, sin sus datos: "Juan Pérez quiero saber mi saldo, cc 1020304050" → "quiero saber mi
 * saldo"; "tengo una deuda, me llamo Ana Gómez y mi cédula es 43123456" → "tengo una deuda"; "buenas, soy Lucero Robles
 * y quiero saber el horario" → "quiero saber el horario". El nombre y el documento ya se ven aparte en el panel y en el
 * WhatsApp. Si no queda nada que diga el tema, no hay asunto ('').
 */
export function subjectText(message: string, x: Pick<Extracted, 'document' | 'name'>): string {
  let s = message;
  if (x.document) {
    const digits = x.document.replace(/\D/g, '').split('').join('[.\\s-]?');
    s = s.replace(new RegExp(`${DOC_LEAD}${digits}(?:-\\d)?`, 'iu'), ' ');
  }
  if (x.name) {
    const name = x.name.split(/\s+/).map(loosePattern).join('\\s+');
    // Al inicio ("Hola, me llamo Juan Pérez y…", "Juan Pérez quiero…") o en medio con su presentación (", me llamo Ana").
    s = s.replace(new RegExp(`^\\s*${GREET}?(?:${INTRO}\\s+)?${name}(?![\\p{L}])`, 'iu'), ' ');
    s = s.replace(new RegExp(`(?:[,;]\\s*|\\s+(?:y|e)\\s+|\\s+)${INTRO}\\s+${name}(?![\\p{L}])`, 'iu'), ' ');
  }
  let out = s.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?=\s*[,;:.!?])/g, '').replace(/\s{2,}/g, ' ').trim();
  if (s !== message) {
    // Lo que unía los datos con el tema ya no une nada: "y quiero saber…", "y, ¿cuánto debo?", "…con Flamingo y". (Un
    // "qué" del inicio es la pregunta: "¿qué servicios ofrecen?" queda igual.)
    for (let i = 0; i < 3; i++) out = out.replace(/^[\s,.;:]+/, '').replace(/^(?:y|e|pero|entonces|pues)(?![\p{L}])[\s,]*/iu, '');
    out = out.replace(/(?:[\s,;:]+(?:y|e|con|de|del|o))+[\s,;:]*$/iu, '').replace(/[\s,;:]+$/g, '').trim();
    // "de Bancolombia, queremos cotizar…" (quedó de "soy Laura de Bancolombia"): la empresa va como etiqueta.
    out = out.replace(/^de\s+((?:\p{Lu}[\p{L}&.-]*)(?:\s+\p{Lu}[\p{L}&.-]*){0,3})\s*[,:]\s*/u, '$1: ');
  }
  // Lo que queda debe decir algo: "por favor" o "gracias" solos no son un tema.
  const said = normalize(out).replace(/\b(por favor|porfa|porfavor|porfis|plis|gracias|muchas|ok|listo|bueno|pues|si|no|hola|buenas|solo)\b/g, ' ')
    .split(' ').filter((w) => w.length >= 3);
  return said.length >= 2 || (said.length === 1 && /[?¿]/.test(out)) ? out : '';
}

/**
 * "No me pases con ningún asesor, solo dime el correo" → "solo dime el correo": la negativa al asesor no es el tema.
 * Se quitan las partes de la frase (entre comas o puntos) que solo niegan al asesor o las llamadas.
 */
function withoutAdvisorRefusal(message: string): string {
  return message.split(/(?<=[,;.!?])/).filter((part) => !(HUMAN_NEGATED.test(normalize(part)) && normalize(topicText(part)).split(' ').filter((w) => w.length >= 3).length < 2))
    .join('').replace(/^[\s,;.!]+/, '').trim();
}

/** El tema guardado era este mensaje y resultó no serlo (p. ej. una pregunta fuera de tema): se borra. */
export async function clearSubjectIf(q: Queryable, companyId: string, conversationId: string, message: string) {
  await q.query(`UPDATE chat_sessions SET subject = '' WHERE id = $1 AND company_id = $2 AND subject = $3`, [conversationId, companyId, message.slice(0, 300)]);
}

/**
 * El visitante ya no quiere esperar al asesor: sale de la cola y sigue con el bot. Si un asesor lo tomó en el
 * mismo instante, no se toca (devuelve la conversación tal como está).
 */
export async function cancelWaiting(db: Db, companyId: string, conversationId: string, content: string) {
  return db.tx(async (q) => {
    const current = (await q.query<LiveChatSession>('SELECT * FROM chat_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE', [conversationId, companyId])).rows[0];
    if (!current) throw notFound('Conversación no encontrada');
    if (current.status !== 'EN_ESPERA_ASESOR') return { conversation: current, message: null as ChatMessage | null };
    const conversation = (await q.query<LiveChatSession>(
      `UPDATE chat_sessions SET status = 'BOT_ACTIVO', waiting_since = NULL, last_interaction_at = now(), updated_at = now()
       WHERE id = $1 AND company_id = $2 RETURNING *`, [conversationId, companyId],
    )).rows[0];
    const message = (await q.query<ChatMessage>(
      `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, content, metadata) VALUES ($1,$2,'BOT',$3,$4::jsonb) RETURNING *`,
      [companyId, conversationId, content, JSON.stringify({ kind: 'handoff_cancel' })],
    )).rows[0];
    return { conversation, message };
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
      // Sin cartera (o con una que se desactivó) recibe la indicada: la única activa o la cartera por defecto, para que
      // la vean los asesores de esa cartera (sin cartera ningún asesor la vería).
      // `portfolio_auto` marca que la puso el sistema: si el visitante dice después la suya, la reemplaza.
      const conversation = (await q.query<LiveChatSession>(
        `UPDATE chat_sessions SET status = 'EN_ESPERA_ASESOR', waiting_since = now(),
           portfolio_auto = CASE WHEN $3::uuid IS NOT NULL AND (portfolio_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM portfolios p WHERE p.id = chat_sessions.portfolio_id AND p.company_id = chat_sessions.company_id AND p.active))
             THEN true ELSE portfolio_auto END,
           portfolio_id = CASE WHEN $3::uuid IS NOT NULL AND (portfolio_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM portfolios p WHERE p.id = chat_sessions.portfolio_id AND p.company_id = chat_sessions.company_id AND p.active))
             THEN $3::uuid ELSE portfolio_id END,
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

