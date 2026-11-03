import type { Db } from '../db';
import type { Company } from '../models/companies';
import type { PublicSession } from '../models/public';
import { listPortfolios } from '../models/portfolios';
import { joinText, normalize } from '../utils/text';
import { answerChat, helpText, identityText, offerAdvisor, type ChatDeps, type ChatReply } from './chat';
import { AFFIRM_RE, CANCEL_RE, DENY_RE, REFUSE_RE, WAIT_RE, classify } from './intents';
import type { LiveNotify } from './liveEvents';
import {
  botState, dataList, finishBotTurn, MAX_HANDOFF_DATA_REQUESTS, MAX_HANDOFF_DATA_REQUESTS_HARD, missingData, recentTurns, startUserTurn,
  type DataField, type LiveChatSession,
} from './liveChat';
import { onlyData } from './visitorData';

/**
 * Turno del chat en vivo. TODAS las reglas del bot están aquí, en este orden, y cada mensaje sigue un único camino:
 *
 *  R0  Captura (liveChat.startUserTurn): en CUALQUIER mensaje se reconocen y guardan documento, cartera y nombre
 *      ("mi nombre es…" corrige uno anterior). El visitante nunca tiene que repetir un dato.
 *  R1  Asesor al mando (TOMADO_POR_ASESOR): el bot calla; el mensaje va al asesor.
 *  R2  En espera de asesor (EN_ESPERA_ASESOR): el bot sigue ayudando con el sitio; si pregunta por la espera se lo
 *      explica. No vuelve a pedir datos ni a "transferir".
 *  R3  Oferta pendiente ("¿Quieres que te comunique con un asesor?"): "sí" → R4; "no" → sigue la conversación.
 *  R4  Reuniendo datos para el asesor: agradece lo recibido y pide SOLO lo que falta. Si responde otra cosa, se le
 *      contesta y se le recuerda; si cancela, se suelta; si no quiere darlos o deja de darlos, pasa igual a la cola.
 *      Con los datos completos pasa a la cola (EN_ESPERA_ASESOR). Con una sola cartera activa no se pregunta.
 *  R5  Pidió un asesor o es un asunto personal (su deuda, su pago): empieza R4.
 *  R6  Conversación normal: saludo, identidad, gracias y "necesito ayuda" con respuesta fija; si no, el sitio (atajo)
 *      o el modelo con el estado de la conversación. Pregunta el nombre UNA sola vez. Si la página no tiene la
 *      respuesta o el modelo no está disponible, OFRECE un asesor (no lo pasa a la cola sin que el visitante quiera).
 *      Una pregunta fuera de tema se redirige con amabilidad.
 *
 * El modelo NUNCA pide datos ni decide escalar por su cuenta: solo responde o indica "handoff"; el servidor decide.
 */

export interface LiveBotDeps {
  db: Db;
  chat: Omit<ChatDeps, 'liveEscalation' | 'live'>;
  notify: LiveNotify;
}
export interface LiveBody { message: string; portfolioKey?: string; document?: string; name?: string; subject?: string }
export interface LiveResponse {
  type: 'answer' | 'live';
  message: string;
  link?: ChatReply['link'];
  conversation: { id: string; status: string };
}

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
const firstName = (c: LiveChatSession) => c.visitor_name?.split(' ')[0] ?? '';
const endsWithQuestion = (s: string) => /\?\s*$/.test(s);

/** "la cartera Flamingo", pero "la cartera de pruebas" (sin repetir "cartera"). */
const portfolioPhrase = (name: string) => (/^cartera\b/i.test(name) ? `la ${name.charAt(0).toLowerCase()}${name.slice(1)}` : `la cartera ${name}`);

/** Agradece los datos recibidos en este mensaje, en una frase. */
function ackText(captured: DataField[], conv: LiveChatSession, portfolioName: string | undefined, handoff: boolean): string {
  if (captured.length === 0) return '';
  const first = firstName(conv);
  const you = first ? `, ${first}` : '';
  if (captured.length === 1 && captured[0] === 'name') return handoff ? `Gracias, ${first}.` : `Mucho gusto, ${first}.`;
  if (captured.length === 1 && captured[0] === 'document') return `Gracias${you}, ya tengo tu número de documento.`;
  if (captured.length === 1 && captured[0] === 'portfolio') return `Gracias${you}, anoté ${portfolioName ? portfolioPhrase(portfolioName) : 'la cartera'}.`;
  return `Gracias${you}, ya anoté tus datos.`;
}

/** Estado que recibe el modelo: sabe qué datos ya dio el visitante y en qué punto está la atención. */
function stateText(conv: LiveChatSession, portfolioName: string | undefined, collecting: boolean): string {
  const situation = conv.status === 'EN_ESPERA_ASESOR'
    ? 'ya está en espera de un asesor humano, que continuará por este mismo chat'
    : collecting ? 'el sistema le está pidiendo sus datos para pasarlo con un asesor' : 'conversando con el asistente';
  return [
    `- Nombre del visitante: ${conv.visitor_name ?? 'aún no lo ha dado'}`,
    `- Documento: ${conv.document ? 'ya registrado' : 'aún no lo ha dado'}`,
    `- Cartera: ${portfolioName ?? 'aún no la ha indicado'}`,
    `- Situación: ${situation}`,
  ].join('\n');
}

const WAITING = [
  'Ya estás en la fila de atención: un asesor tomará tu conversación en cuanto esté disponible y te escribirá por aquí.',
  'Tu solicitud sigue en espera. En cuanto un asesor se libere, continuará contigo por este mismo chat.',
] as const;
const SENSITIVE_START = [
  'Como es un tema personal, lo revisa mejor un asesor.',
  'Para revisar tu caso te comunico con un asesor.',
  'Eso lo revisa un asesor con tu información.',
] as const;

export async function liveTurn(deps: LiveBotDeps, company: Company, session: PublicSession, body: LiveBody): Promise<LiveResponse> {
  const { db, notify } = deps;
  // R0: guarda el mensaje y los datos que trae.
  const turn = await startUserTurn(db, company, session, body.message, {
    portfolioKey: body.portfolioKey, document: body.document, name: body.name, subject: body.subject,
  });
  const conv = turn.conversation;
  if (turn.created) notify(company.id, 'conversation_created', { conversationId: conv.id, status: conv.status });
  notify(company.id, 'chat_message', { conversationId: conv.id, messageId: turn.message.id, sender: 'USER' });

  // R1: un asesor tiene el control.
  if (!turn.botMayReply) return { type: 'live', message: 'Tu mensaje fue enviado al asesor.', conversation: { id: conv.id, status: conv.status } };

  const portfolios = await listPortfolios(db, company.id, true);
  const portfolioNames = portfolios.map((p) => p.name);
  // Con una sola cartera activa no hay nada que elegir: no se pregunta y se asigna al pasar a la cola.
  const onlyPortfolioId = portfolios.length === 1 ? portfolios[0].id : null;
  const portfolioName = portfolios.find((p) => p.id === conv.portfolio_id)?.name;
  const missing = missingData(conv, portfolios.length > 1);
  const bot = await botState(db, company.id, conv.id);
  const collecting = bot.handoffAsks > 0;
  const n = normalize(body.message);
  const intent = classify(body.message);
  const pureData = onlyData(turn.extracted);
  const first = firstName(conv);
  const you = first ? `, ${first}` : '';

  /** Guarda la respuesta del bot (o el aviso de paso a la cola) y la entrega al visitante. */
  const reply = async (
    text: string,
    opts: { escalate?: boolean; kind?: 'data_request' | 'offer' | 'handoff_cancel'; field?: DataField | 'handoff'; link?: ChatReply['link'] } = {},
  ): Promise<LiveResponse> => {
    // `progress`: este pedido de datos responde a un mensaje que sí trajo datos (el visitante está colaborando).
    const metadata = opts.kind
      ? { kind: opts.kind, ...(opts.field ? { field: opts.field } : {}), ...(opts.field === 'handoff' && turn.captured.length > 0 ? { progress: true } : {}) }
      : {};
    const saved = await finishBotTurn(db, company.id, conv.id, text, !!opts.escalate, metadata, { assignPortfolioId: opts.escalate ? onlyPortfolioId : null });
    if (saved.message) notify(company.id, 'chat_message', { conversationId: conv.id, messageId: saved.message.id, sender: saved.message.sender_type });
    const status = saved.conversation.status;
    if (status !== conv.status) notify(company.id, 'chat_status', { conversationId: conv.id, status });
    // Un asesor tomó el chat mientras el bot pensaba: su respuesta no se envía.
    if (status === 'TOMADO_POR_ASESOR') return { type: 'live', message: 'Tu mensaje fue enviado al asesor.', conversation: { id: conv.id, status } };
    if (opts.escalate && status === 'EN_ESPERA_ASESOR') return { type: 'live', message: text, conversation: { id: conv.id, status } };
    return { type: 'answer', message: text, link: opts.link, conversation: { id: conv.id, status } };
  };

  /** Respuesta del sitio o del modelo, con el hilo de la conversación (desde la base, no desde el navegador) y el estado. */
  const ask = async (): Promise<ChatReply> => answerChat(
    { ...deps.chat, liveEscalation: true, live: { state: stateText(conv, portfolioName, collecting), name: conv.visitor_name } },
    company, session, body.message, await recentTurns(db, company.id, conv.id, turn.message.id),
  );

  // R2: ya en espera de un asesor.
  if (conv.status === 'EN_ESPERA_ASESOR') {
    const ack = ackText(turn.captured, conv, portfolioName, true);
    if (pureData) return reply(joinText(ack || 'Gracias.', 'Se lo paso al asesor, que continuará por este mismo chat.'));
    if (WAIT_RE.test(n) || intent === 'human') return reply(joinText(ack, pick(WAITING)));
    if (intent === 'thanks') return reply(joinText(ack, `¡Con gusto${you}! El asesor continuará contigo por este chat en cuanto esté disponible.`));
    if (intent === 'greeting') return reply(`¡Hola${you}! Ya avisé a un asesor y te escribirá por aquí. Mientras tanto, ¿en qué te ayudo?`);
    if (intent === 'identity') return reply(joinText(identityText(company), 'Un asesor ya tiene tu solicitud y te escribirá por aquí.'));
    const r = await ask();
    if (r.type === 'answer') return reply(joinText(ack, r.message), { link: r.link });
    return reply(joinText(ack, 'Eso lo revisará el asesor que te va a atender por este mismo chat. Mientras tanto, ¿te ayudo con algo más?'));
  }

  /** Pasa a la cola de asesores; con los datos completos lo confirma y, si faltan, avisa que el asesor los pedirá. */
  const escalate = (lead = '', noteMissing = true) => {
    const done = missing.length === 0;
    const queued = `Tu solicitud quedó en espera de un asesor, que continuará por este mismo chat${!done && noteMissing ? ' y te pedirá los datos que falten' : ''}.`;
    const thanks = done ? `Gracias${you}. Ya tengo tus datos.` : lead ? '' : `Gracias${you}.`;
    return reply(joinText(lead, thanks, queued), { escalate: true });
  };

  /**
   * Pide los datos que faltan para pasar con el asesor. Mientras el visitante siga entregando datos se le pide lo que
   * falte; si deja de darlos tras MAX_HANDOFF_DATA_REQUESTS pedidos, pasa igual a la cola (el asesor los pedirá).
   */
  const collect = (lead: string, mode: 'start' | 'continue' | 'remind') => {
    if (missing.length === 0) return escalate(mode === 'remind' ? lead : '');
    const stalled = turn.captured.length === 0 && bot.stalledAsks >= MAX_HANDOFF_DATA_REQUESTS;
    if (stalled || bot.handoffAsks >= MAX_HANDOFF_DATA_REQUESTS_HARD) return escalate(lead);
    const list = dataList(missing, portfolioNames);
    // Si la frase anterior ya nombra al asesor, no se repite la palabra: "…el asesor. Para pasarte con él, …".
    const withAdvisor = /\basesor/i.test(lead) ? 'Para pasarte con él' : 'Para pasarte con el asesor';
    const text = mode === 'start'
      ? joinText(lead, `Para que te atienda desde el primer mensaje, ¿me compartes ${list}?`)
      : mode === 'continue'
        ? joinText(lead, `${withAdvisor} solo me ${missing.length > 1 ? 'faltan' : 'falta'} ${list}.`)
        : joinText(lead, `${withAdvisor}, compárteme ${list}.`);
    return reply(text, { kind: 'data_request', field: 'handoff' });
  };

  const handoffAck = ackText(turn.captured, conv, portfolioName, true);

  // R3: el bot ofreció un asesor en su último mensaje.
  if (bot.lastKind === 'offer') {
    if (pureData) return collect(handoffAck, 'start');
    if (AFFIRM_RE.test(n) || intent === 'human') return collect('¡Listo! Te comunico con un asesor.', 'start');
    if (DENY_RE.test(n)) return reply(`Está bien${you}. ¿Hay algo más en lo que te pueda ayudar?`);
    // Otra pregunta: se atiende normalmente.
  }

  // R4: reuniendo los datos para el asesor.
  if (collecting) {
    if (CANCEL_RE.test(n)) {
      return reply(`Listo${you}, no hay problema. Si más adelante quieres hablar con un asesor, solo dímelo.`, { kind: 'handoff_cancel' });
    }
    if (REFUSE_RE.test(n)) return escalate('Entiendo, no hay problema.', false);
    if (pureData) return collect(handoffAck, 'continue');
    if (intent === 'other') {
      // Preguntó otra cosa mientras faltan datos: se le responde y se le recuerda lo que falta.
      const r = await ask();
      if (r.type === 'answer' && r.reason === 'clarify') return reply(joinText(handoffAck, r.message));
      const said = r.type === 'answer' && r.reason !== 'offtopic' ? r.message
        : r.reason === 'offtopic' ? 'Eso no lo puedo responder por aquí.' : 'Eso te lo resolverá el asesor.';
      return collect(joinText(handoffAck, said), 'remind');
    }
    if (intent === 'identity') return collect(joinText(handoffAck, identityText(company)), 'remind');
    return collect(joinText(handoffAck, intent === 'sensitive' ? 'Entiendo.' : ''), 'continue');
  }

  // R5: pide un asesor o trae un asunto personal.
  if (intent === 'human') return collect(joinText(handoffAck, '¡Claro! Te comunico con un asesor.'), 'start');
  if (intent === 'sensitive') return collect(joinText(handoffAck, pick(SENSITIVE_START)), 'start');

  // R6: conversación normal.
  const ack = ackText(turn.captured, conv, portfolioName, false);
  /** El nombre se pregunta una sola vez, al final de una respuesta que no termina en pregunta. */
  const answer = (text: string, link?: ChatReply['link']) => {
    if (!conv.visitor_name && !bot.nameAsked && !endsWithQuestion(text) && text.length <= 320) {
      return reply(joinText(text, '¿Con quién tengo el gusto?'), { kind: 'data_request', field: 'name', link });
    }
    return reply(text, { link });
  };
  if (intent === 'identity') return answer(identityText(company));
  if (intent === 'greeting') return reply(first ? `¡Hola, ${first}! ¿En qué puedo ayudarte?` : `¡Hola! Soy el asistente virtual de ${company.name}. ¿En qué puedo ayudarte?`);
  if (intent === 'thanks') return reply(`¡Con gusto${you}! Si necesitas algo más, aquí estoy.`);
  if (intent === 'help') return reply(joinText(ack, helpText()));
  // Dio un dato sin que se lo pidieran o respondió "¿con quién tengo el gusto?": se agradece sin pedir más.
  if (pureData) return reply(joinText(ack, '¿En qué te puedo ayudar?'));

  const r = await ask();
  if (r.type === 'answer') return r.reason ? reply(joinText(ack, r.message), { link: r.link }) : answer(joinText(ack, r.message), r.link);
  if (r.reason === 'human' || r.reason === 'sensitive') return collect(joinText(ack, r.message), 'start');
  // La página no tiene la respuesta o el modelo no está disponible: se ofrece un asesor; el visitante decide.
  const lead = r.reason === 'unavailable' ? 'En este momento no tengo esa respuesta a la mano.' : r.message || 'No tengo esa información publicada en el sitio.';
  return reply(joinText(ack, offerAdvisor(lead)), { kind: 'offer' });
}
