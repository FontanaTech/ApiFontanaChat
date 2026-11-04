import type { Db } from '../db';
import type { Company } from '../models/companies';
import type { PublicSession } from '../models/public';
import { listPortfolios } from '../models/portfolios';
import { joinText, normalize, tidy } from '../utils/text';
import {
  answerChat, asksContact, companyFacts, companyName, companyNumberText, helpTexts, identityAgainText, identityText, isComplaint, NAMES_ADVISOR, offerAdvisor,
  offTopicTexts, type ChatDeps, type ChatMoment, type ChatReply,
} from './chat';
import {
  afterYes, analyze, announcesQuestion, asksWhichDocument, cancelOf, COMMERCIAL_RE, HUMAN_NEGATED, isConfused, isHold, isWaitQuestion, isWhyData,
  looksLikeQuestion, negatesAdvisorOnly, refusedFields, refuseQuestion, yesNo,
} from './intents';
import type { LiveNotify } from './liveEvents';
import {
  botState, cancelWaiting, clearSubjectIf, dataList, finishBotTurn, MAX_HANDOFF_DATA_REQUESTS, MAX_HANDOFF_DATA_REQUESTS_HARD, missingData,
  recentTurns, startUserTurn, type DataField, type LiveChatSession, type UserTurn,
} from './liveChat';
import { FIRST_NAMES } from './lexicon';
import { asksForInfo, namedPortfolios, onlyData } from './visitorData';

/**
 * Turno del chat en vivo. TODAS las reglas del bot están aquí, en este orden, y cada mensaje sigue un único camino:
 *
 *  R0  Captura (liveChat.startUserTurn): se reconocen y guardan nombre, documento y cartera. Un dato suelto solo
 *      cuenta si el bot lo está pidiendo; dicho de forma explícita ("mi cédula es…") o corregido ("perdón, es…")
 *      reemplaza uno anterior.
 *  R1  Asesor al mando (TOMADO_POR_ASESOR): el bot calla; el mensaje va al asesor.
 *  R2  En espera de asesor (EN_ESPERA_ASESOR): el bot sigue ayudando con el sitio; si pregunta por la espera se lo
 *      explica; si ya no quiere esperar, sale de la cola. No vuelve a pedir datos ni a "transferir", pero toma los que
 *      faltan si llegan claros.
 *  R3  Oferta pendiente ("¿Quieres que te comunique con un asesor?"): "sí", "por favor", "pásame" → R4; "no" → sigue
 *      la conversación; otra pregunta ("ok, ¿y el teléfono?") se responde como tal; "sí, pero antes…" responde y pide.
 *  R4  Reuniendo datos para el asesor: agradece lo recibido y pide SOLO lo que falta. Si pregunta otra cosa, se le
 *      responde y se le recuerda; si cancela o se despide, se suelta (y se responde lo que haya preguntado); si no
 *      quiere o no puede darlos, pasa igual a la cola; si pide un momento, se le espera. Con los datos completos pasa
 *      a la cola (EN_ESPERA_ASESOR).
 *  R5  Pidió un asesor o es un asunto personal (su deuda, su pago): empieza R4.
 *  R6  Conversación normal: saludo, identidad, gracias y "necesito ayuda" con respuesta fija; si no, el sitio (atajo)
 *      o el modelo con el estado de la conversación. Pregunta el nombre UNA sola vez. Si la página no tiene la
 *      respuesta o el modelo no está disponible, OFRECE un asesor (no lo pasa a la cola sin que el visitante quiera).
 *
 * El modelo NUNCA pide datos ni decide escalar por su cuenta: solo responde o indica "handoff"; el servidor decide.
 * El bot no envía el mismo mensaje dos veces seguidas, y atiende un mensaje a la vez por visitante.
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
const endsWithQuestion = (s: string | null | undefined) => !!s && /\?\s*$/.test(s);
/** "Respuesta. ¿Algo más?" → "Respuesta.": antes de pedir los datos no se deja una pregunta del modelo colgando. */
const withoutTrailingQuestion = (text: string) => {
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.length > 1 && /\?$/.test(parts.at(-1)!) ? parts.slice(0, -1).join(' ') : text;
};
/**
 * "¡Hola! …", "¡Hola, María José! …", "Hola Pedro, …", "¡Qué tal! …" o "¡Hola de nuevo! …" al inicio de la respuesta
 * del modelo: si el bot ya saluda, no se repite. Solo se quita el saludo y el nombre del visitante (o uno de pila):
 * en "Hola, estamos en Colombia, Perú…" o "¡Hola! Sí, trabajamos con Flamingo." la respuesta queda entera.
 */
function withoutGreeting(text: string, name?: string | null): string {
  const g = text.match(/^¡?\s*(?:[Hh]ola|[Bb]uen[oa]s(?: tardes| noches| d[ií]as)?|[Bb]uen d[ií]a|[Ss]aludos|[Qq]u[eé] tal)(?:\s+de nuevo)?/u);
  if (!g) return text;
  let rest = text.slice(g[0].length);
  // El nombre que sigue al saludo: el del visitante o, si no se sabe, uno de pila conocido ("¡Hola, Ana!").
  const who = rest.match(/^,?\s*([A-ZÁÉÍÓÚÑ][\p{L}]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}]+){0,3})(?=\s*[!,.])/u);
  if (who) {
    const first = normalize(who[1]).split(' ')[0];
    const visitor = name ? normalize(name).split(' ')[0] : '';
    if (first === visitor || (!visitor && FIRST_NAMES.has(first))) rest = rest.slice(who[0].length);
  }
  const pause = rest.match(/^\s*[!,.]+\s*/);
  if (!pause) return text; // "Hola" pegado a la frase: no era un saludo aparte
  rest = rest.slice(pause[0].length);
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : text;
}
/** "Quiero un asesor, pero primero dime el correo": la parte que pregunta otra cosa (o null). */
function otherQuestion(message: string): string | null {
  const parts = message.split(/[,;.!?¿¡]+|\s(?:pero|y|e|antes)\s/i).map((p) => p.trim()).filter(Boolean);
  const asks = parts.filter((p) => !['human', 'identity'].includes(analyze(p).intent) && normalize(p).split(' ').length >= 2 && looksLikeQuestion(p));
  return asks.length > 0 ? asks.join(', ') : null;
}
/** Lo que se dice de una pregunta que no tiene respuesta publicada (o sin modelo para responderla). */
const NO_ANSWER = 'En este momento no tengo esa respuesta a la mano.';
/** "Puedes darme otro documento…": a quien pregunta qué documento sirve o qué pasa si no tiene cédula. */
const WHICH_DOCUMENT = 'Puedes darme el número de otro documento de identidad (tarjeta de identidad, pasaporte, cédula de extranjería o PPT). Si no tienes ninguno, no hay problema: el asesor lo revisa contigo.';

/** "la cartera Flamingo", pero "la cartera de pruebas" (sin repetir "cartera"). */
const portfolioPhrase = (name: string) => (/^cartera\b/i.test(name) ? `la ${name.charAt(0).toLowerCase()}${name.slice(1)}` : `la cartera ${name}`);
const fieldPhrase = (f: DataField) => (f === 'name' ? 'tu nombre' : f === 'document' ? 'tu número de documento' : 'la cartera');
const listPhrase = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}` : parts[0] ?? '');

/**
 * Agradece (o confirma la corrección de) los datos recibidos en este mensaje, en una frase. `phoneOnly`: el mensaje
 * solo dejaba un número de contacto (no se guarda como documento; el asesor lo ve en la conversación).
 */
function ackText(turn: Pick<UserTurn, 'captured' | 'replaced'>, conv: LiveChatSession, portfolioName: string | undefined, handoff: boolean, phoneOnly = false): string {
  const { captured, replaced } = turn;
  const first = firstName(conv);
  const you = first ? `, ${first}` : '';
  if (captured.length === 0) return phoneOnly ? (handoff ? `Gracias${you}, el asesor verá tu número de contacto.` : `Gracias${you}, tengo tu número de contacto.`) : '';
  if (replaced.length === captured.length) return `Listo${you}, corregí ${listPhrase(replaced.map(fieldPhrase))}.`;
  if (captured.length === 1 && captured[0] === 'name') return handoff ? `Gracias, ${first}.` : `Mucho gusto, ${first}.`;
  if (captured.length === 1 && captured[0] === 'document') return `Gracias${you}, ya tengo tu número de documento.`;
  if (captured.length === 1 && captured[0] === 'portfolio') return `Gracias${you}, anoté ${portfolioName ? portfolioPhrase(portfolioName) : 'la cartera'}.`;
  return `Gracias${you}, ya anoté tus datos.`;
}

/** Lo que trajo el mensaje, dicho después de atender el pedido ("¡Claro! Te comunico con un asesor. Ya anoté la cartera Flamingo."). */
function dataNotes(turn: Pick<UserTurn, 'captured' | 'replaced' | 'extracted'>, portfolioName: string | undefined): string {
  const notes: string[] = [];
  // La cartera que venía del widget y el visitante cambia al pedir el asesor ("asesor de Offcorss") se anota, no se "corrige".
  const portfolioFixed = turn.replaced.includes('portfolio') && !!turn.extracted.correction;
  const fixed = turn.replaced.filter((f) => f !== 'name' && (f !== 'portfolio' || portfolioFixed));
  if (fixed.length > 0) notes.push(`Corregí ${listPhrase(fixed.map(fieldPhrase))}.`);
  if (turn.captured.includes('document') && !turn.replaced.includes('document')) notes.push('Ya tengo tu número de documento.');
  if (turn.captured.includes('portfolio') && !portfolioFixed) notes.push(`Ya anoté ${portfolioName ? portfolioPhrase(portfolioName) : 'la cartera'}.`);
  if (turn.extracted.phone) notes.push('El asesor verá tu número de contacto.');
  return notes.join(' ');
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
  'Sigues en la fila. El asesor te escribirá por este mismo chat apenas tome tu conversación.',
];
const SENSITIVE_START = [
  'Como es un tema personal, lo revisa mejor un asesor.',
  'Para revisar tu caso te comunico con un asesor.',
  'Eso lo revisa un asesor con tu información.',
] as const;
const thanksTexts = (you: string) => [
  `¡Con gusto${you}! Si necesitas algo más, aquí estoy.`,
  `¡Para servirte${you}! Si te surge otra duda, escríbeme.`,
  `¡Con gusto${you}! Aquí estoy si te surge otra pregunta.`,
];
/** Preguntas del bot que se contestan con un "sí" o un "no" ("¿Hay algo más en lo que te pueda ayudar?"). */
const ANYTHING_ELSE = /(algo m[aá]s|algo de eso|en qu[eé] (te )?(puedo ayudar|ayudo|te puedo ayudar|te ayudo))[^?]*\?\s*$/i;
const UNAVAILABLE = [
  'En este momento no tengo esa respuesta a la mano.',
  'Ese dato tampoco lo tengo a la mano en este momento.',
  'Esa información no la tengo disponible ahora.',
];
const UNCLEAR = [
  '¿Me cuentas un poco más de lo que necesitas? Puedo darte información de nuestros servicios y canales de atención, o comunicarte con un asesor.',
  'No estoy seguro de haberte entendido. ¿Me cuentas en qué te puedo ayudar?',
];
/** Lo que cuenta sin preguntar ("me interesa el servicio para mi empresa"): un asesor puede ayudarle. */
const STATEMENT_LEADS = ['Un asesor puede ayudarte con eso.', 'Eso lo puede revisar contigo un asesor.'];
const COMPLAINT_LEADS = ['Lamento el inconveniente. Un asesor puede revisarlo contigo.', 'Lamento lo ocurrido; un asesor puede ayudarte a revisarlo.'];
/** "Es de Falabella", "por Finandina", "ninguna de esas, es de Movistar": respondió la cartera con una que no es de la empresa. */
const PORTFOLIO_HINT = /^(es )?(de|con|del|por|la de|el de|cartera|es la|es el)\b|^(ninguna|ninguno|no es ninguna|otra|es otra)\b/;
/** Se despide ("no gracias, chao", "no, muchas gracias, adiós", "no, ya me voy"). */
const FAREWELL = /\b(chao|chau|adios|bye|hasta luego|hasta pronto|hasta manana|nos vemos|que (este|estes|esten) bien|buen dia|buena tarde|buena noche|buenas noches|buenas tardes|feliz (dia|tarde|noche)|ya me voy|me voy|bendiciones|que le vaya bien|que te vaya bien)\b/;
/** "Gracias, me sirvió mucho", "muy clara la información, gracias", "gracias, voy a revisar": agradece y cierra. */
const THANKS_WORD = /\b(gracias|agradezco|agradecid[oa]|muy amables?)\b/;
/** Lo que hace que un mensaje con "gracias" no sea solo un cierre (pide o cuenta algo de su caso o del servicio). */
const NOT_ONLY_THANKS = /\b(contratar|cotizar|cotizacion|empresa|negocio|deuda|deudas|pago|pagar|saldo|credito|cuenta|proceso|caso|asesor|asesora|ayuda|ayudar|ayudame|pregunta|duda|consulta|necesito|quiero|quisiera|tengo|como|cuando|donde|cual|cuanto)\b/;
/** "Es la cédula de mi esposa", "es para mi mamá": habla de sus datos, no nombra una entidad. */
const ABOUT_DATA = /\b(cedula|documento|numero|nombre|mama|papa|esposa|esposo|hijo|hija|hermano|hermana|familiar)\b/;
/** Respuestas a quien pregunta por la espera mientras se le piden los datos. */
const WAIT_COLLECTING = 'En cuanto me compartas los datos pasas a la fila de atención, y el asesor te escribirá por este mismo chat apenas esté disponible.';
/** Lo mismo cuando ese mensaje completó los datos (pasa a la cola ahora). */
const WAIT_DONE = 'Ya pasas a la fila de atención: el asesor te escribirá por este mismo chat apenas esté disponible.';
/** "General, Claro u Offcorss", "Offcorss o Flamingo". */
const orList = (parts: string[]) => {
  if (parts.length < 2) return parts[0] ?? '';
  const last = parts.at(-1)!;
  return `${parts.slice(0, -1).join(', ')} ${/^h?o/i.test(normalize(last)) ? 'u' : 'o'} ${last}`;
};

/* Un mensaje a la vez por visitante: si envía dos seguidos, el segundo espera a que el primero termine (así no
   vuelve a pedir datos que el primero ya entregó ni lo pasa dos veces a la cola). */
const inFlight = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (inFlight.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  inFlight.set(key, tail);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === tail) inFlight.delete(key);
  }
}

export function liveTurn(deps: LiveBotDeps, company: Company, session: PublicSession, body: LiveBody): Promise<LiveResponse> {
  return oneAtATime(session.id, () => turn(deps, company, session, body));
}

async function turn(deps: LiveBotDeps, company: Company, session: PublicSession, body: LiveBody): Promise<LiveResponse> {
  const { db, notify } = deps;
  // R0: guarda el mensaje y los datos que trae. Los números y las palabras que publica la empresa nunca son el
  // documento o el nombre del visitante.
  const facts = await companyFacts(db, company);
  const userTurn = await startUserTurn(db, company, session, body.message, {
    portfolioKey: body.portfolioKey, document: body.document, name: body.name, subject: body.subject,
  }, { companyNumbers: facts.numbers, siteWords: facts.words });
  const conv = userTurn.conversation;
  if (userTurn.created) notify(company.id, 'conversation_created', { conversationId: conv.id, status: conv.status });
  notify(company.id, 'chat_message', { conversationId: conv.id, messageId: userTurn.message.id, sender: 'USER' });

  // R1: un asesor tiene el control.
  if (!userTurn.botMayReply) return { type: 'live', message: 'Tu mensaje fue enviado al asesor.', conversation: { id: conv.id, status: conv.status } };

  const portfolios = await listPortfolios(db, company.id, true);
  const portfolioNames = portfolios.map((p) => p.name);
  // Al pasar a la cola sin cartera: la única activa o la cartera por defecto (así la ven los asesores de esa cartera).
  const queuePortfolioId = (portfolios.length === 1 ? portfolios[0].id : null) ?? portfolios.find((p) => p.is_default)?.id ?? null;
  const active = portfolios.find((p) => p.id === conv.portfolio_id);
  const portfolioName = active?.name;
  const bot = await botState(db, company.id, conv.id);
  // La cartera que puso el sistema al pasar a la cola (el visitante no la eligió) sigue pendiente. Lo que el bot ya
  // dejó de pedir en esta toma ("el asesor lo confirma contigo") no se vuelve a pedir.
  const missing = missingData({ ...conv, portfolio_id: active && !conv.portfolio_auto ? conv.portfolio_id : null }, portfolios.length > 1)
    .filter((f) => !bot.waived.has(f));
  const collecting = bot.handoffAsks > 0;
  const analysis = analyze(body.message);
  const { greeted, howAreYou, rest } = analysis;
  const n = normalize(body.message);
  // "¿Me puedes pasar con uno?" justo después de que el bot nombró a un asesor: lo pide.
  const refersAdvisor = analysis.intent === 'other' && NAMES_ADVISOR.test(bot.lastText ?? '')
    && /\b(pasar|pasarme|pasas|pasame|comunicar|comunicarme|comunicas|hablar|conectar|conectarme|conectas) con (uno|una|el|ella)\b/.test(n);
  const intent = refersAdvisor ? 'human' : analysis.intent;
  const answerTo = yesNo(body.message);
  /** Dijo que no quiere un asesor ("no necesito asesor, ¿trabajan los sábados?"): no se le ofrece uno. */
  const negated = HUMAN_NEGATED.test(n);
  const pureData = onlyData(userTurn.extracted);
  /** El mensaje solo dejaba un número de contacto ("mi wsp 3104567890"). */
  const phoneOnly = pureData && !!userTurn.extracted.phone && userTurn.captured.length === 0;
  /** El visitante está colaborando: entregó un dato o un número de contacto. */
  const progressed = userTurn.captured.length > 0 || phoneOnly;
  /** El último mensaje del bot preguntó algo: un "no" o un "mejor no" le responde a esa pregunta. */
  const answering = /\?/.test(bot.lastText ?? '');
  // "1020304050 dónde quedan", "Juan Pérez cuál es el horario": sin los datos, lo que queda pregunta algo.
  const question = looksLikeQuestion(body.message, rest)
    || (userTurn.captured.length > 0 && !!userTurn.extracted.rest && looksLikeQuestion(userTurn.extracted.rest));
  /** "Sí" a secas (y no "sí, ¿cuál es el correo?" ni "sí, el teléfono"). */
  const yesRest = afterYes(body.message);
  const plainYes = answerTo === 'yes' && yesRest.split(' ').filter((w) => w.length >= 3).length < 2 && !asksForInfo(yesRest)
    && !(/[?¿]/.test(body.message) && yesRest.length > 0);
  const first = firstName(conv);
  const you = first ? `, ${first}` : '';
  /** El primer texto que no repite el último mensaje del bot (determinístico). */
  const fresh = (texts: string[]) => texts.find((t) => t !== bot.lastText) ?? texts[0];
  /** Igual, pero un texto que el bot ya dijo con algo más al final ("… ¿Con quién tengo el gusto?") también cuenta como repetido. */
  const freshPrefix = (texts: string[]) => texts.find((t) => !(bot.lastText ?? '').startsWith(t)) ?? texts.at(-1)!;
  /** Uno al azar entre los que no repiten el último mensaje del bot. */
  const vary = (texts: string[]) => {
    const options = texts.filter((t) => t !== bot.lastText);
    return pick(options.length > 0 ? options : texts);
  };

  /** Guarda la respuesta del bot (o el aviso de paso a la cola) y la entrega al visitante. */
  const reply = async (
    text: string,
    opts: {
      escalate?: boolean; kind?: 'data_request' | 'offer' | 'handoff_cancel' | 'clarify' | 'hold' | 'closing'; field?: DataField | 'handoff';
      link?: ChatReply['link']; waived?: DataField[];
    } = {},
  ): Promise<LiveResponse> => {
    // `progress`: este pedido de datos responde a un mensaje que sí trajo datos (el visitante está colaborando).
    // `waived`: datos que el bot deja de pedir en esta toma (el asesor los confirma).
    const metadata = opts.kind
      ? {
        kind: opts.kind, ...(opts.field ? { field: opts.field } : {}), ...(opts.field === 'handoff' && progressed ? { progress: true } : {}),
        ...(opts.waived?.length ? { waived: opts.waived.join(',') } : {}),
      }
      : {};
    const saved = await finishBotTurn(db, company.id, conv.id, text, !!opts.escalate, metadata, { assignPortfolioId: opts.escalate ? queuePortfolioId : null });
    if (saved.message) notify(company.id, 'chat_message', { conversationId: conv.id, messageId: saved.message.id, sender: saved.message.sender_type });
    const status = saved.conversation.status;
    if (status !== conv.status) notify(company.id, 'chat_status', { conversationId: conv.id, status });
    // Un asesor tomó el chat mientras el bot pensaba: su respuesta no se envía.
    if (status === 'TOMADO_POR_ASESOR') return { type: 'live', message: 'Tu mensaje fue enviado al asesor.', conversation: { id: conv.id, status } };
    if (opts.escalate && status === 'EN_ESPERA_ASESOR') return { type: 'live', message: text, conversation: { id: conv.id, status } };
    return { type: 'answer', message: text, link: opts.link, conversation: { id: conv.id, status } };
  };

  /** Respuesta del sitio o del modelo, con el hilo de la conversación (desde la base, no desde el navegador) y el estado. */
  const ask = async (text = body.message): Promise<ChatReply> => answerChat(
    { ...deps.chat, liveEscalation: true, live: { state: stateText(conv, portfolioName, collecting), name: conv.visitor_name } },
    company, session, text, await recentTurns(db, company.id, conv.id, userTurn.message.id),
  );
  /** Respuesta del sitio o del modelo que sirve para contestar (no una oferta, ni fuera de tema, ni una aclaración). */
  let lastAsked: ChatReply | null = null;
  const answerText = async (text?: string): Promise<string | null> => {
    const r = await ask(text);
    lastAsked = r;
    return r.type === 'answer' && !r.reason ? r.message : null;
  };
  /**
   * Lo que se dice de una pregunta que no se pudo responder: lo publicado a medias o la frase del modelo ("El horario
   * no aparece publicado en el sitio."), o que no se tiene la respuesta. Sin ofrecer un asesor (eso lo decide quien llama).
   */
  const unanswered = async (opts: { advisorOk?: boolean } = {}): Promise<string> => {
    const r = lastAsked ?? (await ask());
    const said = r.type !== 'answer' && r.reason === 'not_found' && r.message ? withoutTrailingQuestion(r.message) : '';
    // Al cancelar no se dice "un asesor te lo confirma": se acaba de soltar al asesor.
    return said && (opts.advisorOk || !NAMES_ADVISOR.test(said)) ? said : NO_ANSWER;
  };

  // R2: ya en espera de un asesor.
  if (conv.status === 'EN_ESPERA_ASESOR') {
    const moment: ChatMoment = 'waiting';
    const ack = ackText(userTurn, conv, portfolioName, true);
    /** Si el acuse ya dijo el nombre ("Gracias, Ana."), la frase siguiente no lo repite. */
    const you2 = ack ? '' : you;
    if (phoneOnly) {
      return reply(fresh([
        `Gracias${you}. El asesor verá tu número de contacto y continuará contigo por este mismo chat.`,
        `Anotado${you}: el asesor también verá ese número.`,
      ]));
    }
    const cancel = cancelOf(body.message, { waiting: true, answering });
    if (cancel.cancel) {
      let text = `Listo${you}, cancelé tu solicitud de asesor. Si más adelante lo necesitas, solo dímelo.`;
      if (cancel.question) {
        // Lo que preguntó se responde; si no está publicado, se le dice (no se ignora la pregunta).
        const answer = await answerText() ?? (await unanswered());
        text = joinText(`Listo${you}, cancelé tu solicitud de asesor.`, answer, 'Si más adelante necesitas un asesor, solo dímelo.');
      }
      const saved = await cancelWaiting(db, company.id, conv.id, text);
      if (saved.message) notify(company.id, 'chat_message', { conversationId: conv.id, messageId: saved.message.id, sender: 'BOT' });
      const status = saved.conversation.status;
      if (status !== conv.status) notify(company.id, 'chat_status', { conversationId: conv.id, status });
      if (!saved.message) return { type: 'live', message: 'Tu mensaje fue enviado al asesor.', conversation: { id: conv.id, status } };
      return { type: 'answer', message: text, conversation: { id: conv.id, status } };
    }
    // "No me llamo Pedro": se borró el nombre y se pide de nuevo, para que el asesor lo vea bien.
    if (userTurn.cleared.includes('name')) return reply('Disculpa la confusión. ¿Me dices tu nombre? Así el asesor lo verá cuando tome tu conversación.');
    if (pureData) {
      // Nombró algo que no se guardó (una cartera cuando ya hay otra): no se agradece como si se hubiera anotado.
      if (userTurn.captured.length === 0) {
        return reply(fresh([`Entendido${you}. El asesor lo verá en este mismo chat.`, `Anotado${you}; el asesor lo verá cuando tome tu conversación.`]));
      }
      return reply(fresh([
        joinText(ack, 'Se lo paso al asesor, que continuará por este mismo chat.'),
        joinText(ack, 'También se lo paso al asesor.'),
      ]));
    }
    if (isWaitQuestion(body.message) || intent === 'human') return reply(fresh(WAITING.map((w) => joinText(ack, w))));
    if (plainYes && answering) return reply(fresh(['¡Claro! ¿En qué te ayudo mientras tanto?', 'Cuéntame, ¿qué necesitas saber?']));
    if (plainYes) return reply(fresh([`¡Listo${you}! El asesor te escribirá por aquí en cuanto esté disponible.`, `Perfecto${you}. El asesor continuará contigo por este chat.`]));
    if (intent === 'thanks' || answerTo === 'closing' || answerTo === 'no') {
      return reply(fresh([
        joinText(ack, `¡Con gusto${you2}! El asesor continuará contigo por este chat en cuanto esté disponible.`),
        joinText(ack, `Está bien${you2}. El asesor te escribirá por aquí en cuanto esté disponible.`),
      ]));
    }
    if (intent === 'greeting') {
      return reply(fresh([
        `¡Hola${you}! Ya avisé a un asesor y te escribirá por aquí. Mientras tanto, ¿en qué te ayudo?`,
        `¡Hola${you}! Sigues en la fila; mientras tanto, ¿en qué te ayudo?`,
      ]));
    }
    if (intent === 'identity') {
      return reply(fresh([
        joinText(identityText(company, moment), 'Un asesor ya tiene tu solicitud y te escribirá por aquí.'),
        tidy(`Como te contaba, soy el asistente virtual de ${companyName(company)}; un asesor ya tiene tu solicitud y te escribirá por este chat.`),
      ]));
    }
    if (intent === 'help') return reply(vary(helpTexts(moment).map((t) => joinText(ack, t))));
    const r = await ask();
    if (r.type === 'answer' && r.reason === 'offtopic') return reply(vary(offTopicTexts(company, moment).map((t) => joinText(ack, t))));
    if (r.type === 'answer') return reply(joinText(ack, r.message), { link: r.link });
    // Lo que sí se sabe aunque no esté todo ("Línea …; el horario no aparece publicado"), o que no está publicado.
    if (question && r.reason === 'not_found' && r.message) {
      return reply(joinText(ack, r.message, NAMES_ADVISOR.test(r.message) ? '' : 'El asesor que te atenderá también podrá ayudarte con eso.'));
    }
    // No preguntó nada ("perfecto, aquí sigo"): se le confirma que sigue en la fila.
    if (!question && intent !== 'sensitive') {
      return reply(fresh([
        joinText(ack, `Entendido${you2}. El asesor continuará contigo por este mismo chat.`),
        joinText(ack, `Listo${you2}, el asesor lo verá cuando tome tu conversación.`),
      ]));
    }
    return reply(fresh([
      joinText(ack, 'Eso lo revisará el asesor que te va a atender por este mismo chat. Mientras tanto, ¿te ayudo con algo más?'),
      joinText(ack, 'Esa consulta la resolverá el asesor cuando tome tu conversación. ¿Te ayudo con algo más mientras tanto?'),
    ]));
  }

  /**
   * Pasa a la cola de asesores; con los datos completos lo confirma y, si faltan, avisa que el asesor los pedirá.
   * `opening` es lo que se le responde primero ("Como es un tema personal…", "Entiendo, no hay problema."); se
   * agradece solo si este mensaje trajo datos.
   */
  const escalate = (opening = '', noteMissing = true) => {
    const done = missing.length === 0;
    const queued = `Tu solicitud quedó en espera de un asesor, que continuará por este mismo chat${!done && noteMissing ? ' y te pedirá los datos que falten' : ''}.`;
    const thanks = done ? (opening ? 'Ya tengo tus datos.' : `Gracias${you}. Ya tengo tus datos.`) : !opening && progressed ? `Gracias${you}.` : '';
    return reply(joinText(opening, thanks, queued), { escalate: true });
  };
  /**
   * Respondió una pregunta justo cuando pasa a la cola: la respuesta va como mensaje del bot y el aviso de la cola
   * aparte (sin repetir el agradecimiento ni meter la respuesta dentro del aviso del sistema).
   */
  const answerThenQueue = async (answer: string, noteMissing = true) => {
    const saved = await finishBotTurn(db, company.id, conv.id, answer, false, {});
    if (saved.message) notify(company.id, 'chat_message', { conversationId: conv.id, messageId: saved.message.id, sender: 'BOT' });
    if (saved.conversation.status === 'TOMADO_POR_ASESOR') {
      return { type: 'live' as const, message: 'Tu mensaje fue enviado al asesor.', conversation: { id: conv.id, status: saved.conversation.status } };
    }
    const done = missing.length === 0;
    return reply(
      `Tu solicitud quedó en espera de un asesor, que continuará por este mismo chat${!done && noteMissing ? ' y te pedirá los datos que falten' : ''}.`,
      { escalate: true },
    );
  };

  const handoffAck = ackText(userTurn, conv, portfolioName, true, phoneOnly);

  /**
   * Pide los datos que faltan para pasar con el asesor. `opening`: lo que se responde antes (el motivo o la respuesta
   * a una pregunta); `ack`: el agradecimiento por los datos de este mensaje. Mientras el visitante siga entregando
   * datos se le pide lo que falte; si deja de darlos tras MAX_HANDOFF_DATA_REQUESTS pedidos, pasa igual a la cola
   * (el asesor los pedirá).
   */
  const collect = (mode: 'start' | 'continue' | 'remind', opening = '', ack = handoffAck, opts: { waive?: DataField[] } = {}) => {
    const need = missing.filter((f) => !opts.waive?.includes(f));
    const stalled = !progressed && bot.stalledAsks >= MAX_HANDOFF_DATA_REQUESTS;
    if (need.length === 0 || stalled || bot.handoffAsks >= MAX_HANDOFF_DATA_REQUESTS_HARD) {
      // Lo que se le acababa de responder va aparte del aviso de la cola.
      if (mode === 'remind' && opening) return answerThenQueue(joinText(ack, opening));
      return escalate(opening);
    }
    const list = dataList(need, portfolioNames);
    const lead = joinText(ack, opening);
    // Si la frase anterior ya nombra al asesor, no se repite la palabra: "…el asesor. Para pasarte con él, …".
    const withAdvisor = /\basesora(?![\p{L}])/iu.test(lead) ? 'Para pasarte con ella' : /\basesor(?![\p{L}])/iu.test(lead) ? 'Para pasarte con él' : 'Para pasarte con el asesor';
    const text = mode === 'start'
      ? joinText(lead, `Para que te atienda desde el primer mensaje, ¿me compartes ${list}?`)
      : mode === 'continue'
        ? joinText(lead, `${withAdvisor} solo me ${need.length > 1 ? 'faltan' : 'falta'} ${list}.`)
        : joinText(lead, `${withAdvisor}, compárteme ${list}.`);
    return reply(text, { kind: 'data_request', field: 'handoff', waived: opts.waive });
  };

  // R3: el bot ofreció un asesor en su último mensaje.
  if (bot.lastKind === 'offer') {
    if (pureData) return collect('start');
    // "No entiendo", "¿cómo así?": no dijo que no; se le explica la oferta.
    if (isConfused(body.message)) {
      return reply(fresh([
        'Te explico: puedo pasarte con un asesor por este mismo chat para que revise tu consulta contigo. ¿Quieres que lo haga?',
        'Me refiero a que un asesor puede continuar contigo por este mismo chat. ¿Te comunico con uno?',
      ]), { kind: 'offer' });
    }
    if (answerTo === 'yes' || intent === 'human') {
      // "Sí, pero antes dime dónde quedan": se responde y se sigue con los datos (con los datos completos, la respuesta
      // va como mensaje del bot y el aviso de la cola aparte).
      if (answerTo === 'yes' && !plainYes && intent !== 'human') {
        const answer = await answerText();
        if (answer && missing.length === 0) return answerThenQueue(withoutTrailingQuestion(answer));
        if (answer) return collect('start', joinText(withoutTrailingQuestion(answer), 'Te comunico con un asesor.'));
      }
      return collect('start', '¡Listo! Te comunico con un asesor.');
    }
    // "No gracias, ya pagué": un no, aunque cuente algo más. "No gracias, chao": un no que además se despide.
    const declined = answerTo === 'no' || (answerTo === null && /^(no|nop)( gracias)?\b/.test(n) && !question);
    if (declined && FAREWELL.test(n)) return reply(vary(thanksTexts(you)), { kind: 'closing' });
    if (declined) return reply(fresh([`Está bien${you}. ¿Hay algo más en lo que te pueda ayudar?`, `De acuerdo${you}. ¿Te ayudo con algo más?`]));
    if (answerTo === 'closing') return reply(vary(thanksTexts(you)), { kind: 'closing' });
    // Otra pregunta: se atiende normalmente.
  }

  // R4: reuniendo los datos para el asesor.
  if (collecting) {
    const moment: ChatMoment = 'collecting';
    const cancel = cancelOf(body.message);
    if (cancel.cancel) {
      // "Olvídalo, ¿cuál es el correo?": se suelta la solicitud y se responde lo que preguntó (si no está publicado, se dice).
      const answer = cancel.question ? (await answerText()) ?? (await unanswered()) : null;
      const text = answer
        ? joinText(`Listo${you}, no hay problema.`, answer, 'Si más adelante quieres hablar con un asesor, solo dímelo.')
        : `Listo${you}, no hay problema. Si más adelante quieres hablar con un asesor, solo dímelo.`;
      return reply(text, { kind: 'handoff_cancel' });
    }
    // "No me llamo Pedro": se borró el nombre y se pide de nuevo.
    if (userTurn.cleared.includes('name')) return collect('remind', 'Disculpa la confusión.');
    // "¿Y si no tengo cédula?", "¿sirve la tarjeta de identidad?": se explica qué documento sirve (no es negarse).
    if (asksWhichDocument(body.message) && !userTurn.captured.includes('document')) return collect('remind', WHICH_DOCUMENT);
    // "Un momento, ya te la paso: 43123456" trajo el dato: se toma en vez de esperar.
    if (isHold(body.message) && !progressed) return reply(fresh(['Claro, aquí te espero.', 'Tranquilo, tómate tu tiempo; aquí te espero.']), { kind: 'hold', field: 'handoff' });
    const mentioned = missing.includes('portfolio') ? namedPortfolios(body.message, portfolios) : { list: [], negated: false };
    const named = mentioned.list;
    let refused = refusedFields(body.message);
    // "Flamingo u Offcorss, no estoy seguro": lo que no sabe es la cartera.
    if (refused === 'all' && named.length > 0) refused = ['portfolio'];
    // No sabe la cartera pero faltan otros datos: el asesor la confirma y se sigue con lo demás.
    if (refused && refused !== 'all' && refused.length === 1 && refused[0] === 'portfolio' && missing.some((f) => f !== 'portfolio')) {
      return collect('remind', 'Entiendo, no hay problema: el asesor confirma la cartera contigo.', handoffAck, { waive: ['portfolio'] });
    }
    // "No tengo cédula, tengo pasaporte AB123456": negó un dato que igual entregó; se sigue con lo que falta.
    if (refused && !(progressed && missing.length > 0 && refused !== 'all' && !refused.some((f) => missing.includes(f)))) {
      // "No quiero dar mi cédula, solo dime el correo": pasa sin los datos y se responde la pregunta.
      const answer = refuseQuestion(body.message) ? await answerText() : null;
      if (answer) return answerThenQueue(joinText(handoffAck, 'Entiendo, no hay problema.', answer), false);
      return escalate(joinText(handoffAck, 'Entiendo, no hay problema.'), false);
    }
    if (isWhyData(body.message)) {
      return collect('remind', 'Te los pido solo para que el asesor identifique tu caso y no tengas que repetirlos. Si prefieres no darlos, dímelo y te paso así.');
    }
    // Con los datos de este mensaje ya completos pasa a la cola: no se le dice "en cuanto me compartas los datos".
    if (isWaitQuestion(body.message)) return collect('remind', missing.length === 0 ? WAIT_DONE : WAIT_COLLECTING);
    // "Quiero preguntar otra cosa": se le invita a preguntar, sin contarlo como otro pedido de datos.
    if (announcesQuestion(body.message)) {
      return reply(`Claro, dime qué quieres preguntar. Cuando quieras, me compartes ${dataList(missing, portfolioNames)} para pasarte con el asesor.`, { kind: 'hold', field: 'handoff' });
    }
    if (pureData) return collect('continue');
    // "Sí", "claro", "dale": va a darlos.
    if (plainYes) return collect('continue', 'Perfecto.');
    // "Gracias", "ok": se le recuerda con amabilidad, sin contarlo como un pedido más.
    if ((intent === 'thanks' || answerTo === 'closing') && missing.length > 0) {
      return reply(fresh([
        `Con gusto${you}. Cuando quieras, compárteme ${dataList(missing, portfolioNames)} para pasarte con el asesor.`,
        `Aquí sigo${you}. Para pasarte con el asesor solo necesito ${dataList(missing, portfolioNames)}.`,
      ]), { kind: 'hold', field: 'handoff' });
    }
    if (intent === 'other') {
      // Nombró carteras de la empresa pero no cuál es la suya ("Offcorss y Flamingo", "no es Flamingo"): se le pregunta
      // entre esas (o entre las demás), sin decir que no las encuentra.
      if ((named.length >= 2 || (named.length === 1 && mentioned.negated)) && !userTurn.captured.includes('portfolio') && !question) {
        const options = named.length >= 2 ? named : portfolios.filter((p) => !named.some((x) => x.key === p.key));
        const which = named.length >= 2
          ? `¿Tu consulta es ${orList(options.map((p) => `de ${p.name}`))}?`
          : `Entendido, no es ${named[0].name}. ¿Es de ${orList(options.map((p) => p.name))}? Si no estás seguro, el asesor lo confirma contigo.`;
        const others = missing.filter((f) => f !== 'portfolio');
        const also = others.length > 0 ? `Para pasarte con el asesor también necesito ${dataList(others, portfolioNames)}.` : '';
        return reply(joinText(handoffAck, which, also), { kind: 'data_request', field: 'handoff' });
      }
      // Respondió la cartera con una que no es de la empresa ("es de Falabella", "Finandina", "ninguna, es de Movistar").
      const portfolioReply = missing.includes('portfolio') && !question && !ABOUT_DATA.test(n)
        && (rest.split(' ').length <= 4 || /^(ninguna|ninguno|no es ninguna|otra|es otra)\b/.test(n))
        && (PORTFOLIO_HINT.test(n) || missing.length === 1 || n.split(' ').some((w) => facts.words.has(w)));
      if (portfolioReply) {
        const note = `No encuentro esa cartera entre las nuestras (${portfolioNames.join(', ')})`;
        if (missing.length === 1) return escalate(joinText(handoffAck, `${note}, pero no hay problema: el asesor lo confirma contigo.`), false);
        // No se le vuelve a pedir la cartera que acaba de decir: el asesor la confirma.
        return collect('remind', `${note}, pero no hay problema: el asesor la confirma contigo.`, handoffAck, { waive: ['portfolio'] });
      }
      // No es una pregunta ("jajaja", "busco la cédula"): solo se recuerda lo que falta (si trajo un dato, se agradece).
      if (!question) return collect(progressed ? 'continue' : 'remind');
      // Preguntó otra cosa mientras faltan datos: se le responde y se le recuerda lo que falta.
      const r = await ask();
      if (r.type === 'answer' && r.reason === 'clarify') return reply(joinText(handoffAck, r.message), { kind: 'clarify', field: 'handoff' });
      const said = r.type === 'answer' && r.reason !== 'offtopic' ? withoutTrailingQuestion(r.message)
        : r.reason === 'offtopic' ? 'Eso no lo puedo responder por aquí.'
          : r.reason === 'not_found' && r.message ? r.message : 'Eso te lo resolverá el asesor.';
      return collect('remind', said);
    }
    if (intent === 'identity') return collect('remind', identityText(company, moment));
    if (intent === 'greeting') return collect('remind', `¡Hola${you}!`);
    return collect('continue', intent === 'sensitive' ? 'Entiendo.' : '');
  }

  // R5: pide un asesor o trae un asunto personal. Lo que trajo el mensaje se anota después de atender el pedido (con
  // los datos completos basta el "Ya tengo tus datos" del paso a la cola).
  const notes = missing.length > 0 ? dataNotes(userTurn, portfolioName) : '';
  if (intent === 'human') {
    // "Quiero un asesor, pero primero dime el correo": se responde y se sigue con los datos. Si no está publicado, se
    // dice ("El horario no aparece publicado…"), en vez de ignorar la pregunta.
    const extra = refersAdvisor ? null : otherQuestion(body.message);
    const waitAsk = !!extra && isWaitQuestion(extra);
    const answer = extra && !waitAsk ? await answerText(extra) : null;
    const pending = extra && !waitAsk && !answer ? await unanswered({ advisorOk: true }) : '';
    // Con los datos completos, la respuesta va como mensaje del bot y el aviso de la cola aparte.
    if (answer && missing.length === 0) return answerThenQueue(withoutTrailingQuestion(answer));
    const opening = answer ? joinText(withoutTrailingQuestion(answer), 'Te comunico con un asesor.')
      : pending ? joinText(pending, NAMES_ADVISOR.test(pending) ? 'Te comunico con uno.' : 'Te comunico con un asesor, que te lo confirma.')
        : waitAsk ? `¡Claro${you}! Te comunico con un asesor; te escribirá por este mismo chat apenas esté disponible.`
          : `¡Claro${you}! Te comunico con un asesor.`;
    return collect('start', joinText(opening, notes), '');
  }
  if (intent === 'sensitive') {
    // "Me llamaron del 604 607 4101, ¿es de ustedes?": se confirma el número antes de pedir los datos.
    const ours = await companyNumberText(db, company, body.message);
    // "No quiero que me llamen más, ya pagué": no pide un asesor; se le ofrece revisar su caso sin pedirle los datos.
    if (negated) return reply(joinText(ours ?? '', offerAdvisor('Entiendo. Un asesor puede revisar tu caso por este mismo chat.')), { kind: 'offer' });
    const named = userTurn.captured.includes('name') && !userTurn.replaced.includes('name') ? `Gracias, ${first}.` : '';
    return collect('start', joinText(ours, named, pick(SENSITIVE_START), notes), '');
  }

  // R6: conversación normal.
  const ack = ackText(userTurn, conv, portfolioName, false, phoneOnly);
  const hello = greeted ? (first ? `¡Hola, ${first}!` : '¡Hola!') : '';
  /** Saludo y acuse sin repetir el nombre: "¡Hola, Juan! Mucho gusto." o "¡Hola, Juan! Gracias, ya anoté tus datos.". */
  const ackAfterHello = hello && first
    ? ack.replace(`Mucho gusto, ${first}.`, 'Mucho gusto.').replace(`Gracias, ${first}, `, 'Gracias, ').replace(`Gracias, ${first}.`, 'Gracias.').replace(`Listo, ${first}, `, 'Listo, ')
    : ack;
  const opener = joinText(hello, ackAfterHello);
  /** Si el bot ya saluda o se presenta, la respuesta del modelo va sin su propio saludo (no "¡Hola! ¡Hola! …"). */
  const withOpener = (text: string) => joinText(opener, opener ? withoutGreeting(text, conv.visitor_name) : text);
  /** El nombre se pregunta una sola vez, al final de una respuesta que no termina en pregunta. */
  const answer = (text: string, link?: ChatReply['link']) => {
    if (!conv.visitor_name && !bot.nameAsked && !endsWithQuestion(text) && text.length <= 320) {
      return reply(joinText(text, '¿Con quién tengo el gusto?'), { kind: 'data_request', field: 'name', link });
    }
    return reply(text, { link });
  };
  // "No me llamo Pedro": se borró el nombre que tenía y se le pregunta cómo se llama.
  if (userTurn.cleared.includes('name')) return reply('Disculpa la confusión. ¿Cómo te llamas?', { kind: 'data_request', field: 'name' });
  // El bot preguntó el nombre: si no quiere darlo se respeta; si pregunta para qué, se explica.
  if (bot.lastField === 'name' && !conv.visitor_name) {
    if (answerTo === 'no' || refusedFields(body.message)) return reply('Está bien, no hay problema. ¿En qué te puedo ayudar?');
    if (isWhyData(body.message)) return reply('Solo para saber cómo llamarte; no es obligatorio. ¿En qué te puedo ayudar?');
  }
  // Responde "sí" o "no" a "¿Hay algo más en lo que te pueda ayudar?" o "¿Te ayudo con algo de eso?".
  // Un "ok" ahí es un acuse (se agradece); solo un "sí" explícito y sin más dice que tiene otra consulta.
  if (!pureData && ANYTHING_ELSE.test(bot.lastText ?? '')) {
    if (plainYes && /^(si|sii+|sip|sisas|claro|por supuesto|obvio)\b/.test(rest || n)) {
      return reply(fresh(['¡Claro! Cuéntame, ¿en qué te puedo ayudar?', '¡Listo! ¿Qué necesitas saber?']));
    }
    if (answerTo === 'no' || answerTo === 'closing') return reply(vary(thanksTexts(you)), { kind: 'closing' });
  }
  // "No quiero asesor, gracias": se respeta sin ofrecer uno.
  if (answerTo === 'no' && negatesAdvisorOnly(body.message)) {
    return reply(fresh([`Está bien${you}, no hay problema. Si necesitas algo más, aquí estoy.`, `De acuerdo${you}. Aquí estoy si te surge otra pregunta.`]));
  }
  // Un "no" o un "nada" sin que el bot haya preguntado nada (p. ej. tras despedirse): se despide con amabilidad. Otro
  // "gracias" o un "chao" se responden como cierre.
  const farewell = FAREWELL.test(n);
  if (!pureData && !answering && (answerTo === 'no' || (answerTo === 'closing' && bot.lastKind === 'closing' && !THANKS_WORD.test(n) && !farewell))) {
    return reply(fresh([`Está bien${you}. Aquí estoy si necesitas algo más.`, `De acuerdo${you}. Si te surge otra duda, escríbeme.`]), { kind: 'closing' });
  }
  if (intent === 'identity') {
    // "¿Eres un bot? ¿Cuál es el teléfono?": se presenta y responde lo otro.
    const extra = otherQuestion(body.message);
    const extraAnswer = extra ? await answerText(extra) : null;
    if (extraAnswer) return reply(joinText(identityText(company, 'collecting'), withoutGreeting(extraAnswer, conv.visitor_name)));
    return answer(freshPrefix([identityText(company), identityAgainText(company)]));
  }
  if (intent === 'greeting' || (intent === 'thanks' && greeted && !bot.lastText)) {
    // "Hola, gracias" al empezar es un saludo (todavía no hay nada que agradecer).
    const how = howAreYou ? 'Muy bien, gracias. ' : '';
    return reply(fresh(first
      ? [`¡Hola, ${first}! ${how}¿En qué puedo ayudarte?`, `¡Hola de nuevo, ${first}! ${how}¿En qué te ayudo?`]
      : [tidy(`¡Hola! ${how}Soy el asistente virtual de ${companyName(company)}. ¿En qué puedo ayudarte?`), `¡Hola! ${how}¿En qué te puedo ayudar?`]));
  }
  if (intent === 'thanks') {
    if (farewell && !THANKS_WORD.test(n)) return reply(fresh([`¡Hasta pronto${you}! Aquí estaré si necesitas algo más.`, `¡Que te vaya bien${you}! Si te surge otra duda, escríbeme.`]), { kind: 'closing' });
    return reply(vary(thanksTexts(you)), { kind: 'closing' });
  }
  // "Quiero preguntar algo", "tengo otra pregunta": se le invita a preguntar.
  if (announcesQuestion(body.message)) return reply(fresh([joinText(opener, '¡Claro! Dime, ¿qué quieres preguntar?'), joinText(opener, 'Claro, cuéntame. ¿Qué necesitas saber?')]));
  // "No entiendo", "¿cómo así?": se ofrece explicar mejor.
  if (isConfused(body.message)) {
    return reply(fresh(['Disculpa si no fui claro. ¿Qué parte quieres que te explique mejor?', 'Perdona, me expliqué mal. ¿Qué te gustaría que te aclare?']));
  }
  if (intent === 'help') return reply(vary(helpTexts().map((t) => joinText(ack, t))));
  // Dio un dato sin que se lo pidieran o respondió "¿con quién tengo el gusto?": se agradece sin pedir más.
  if (pureData) {
    if (greeted && userTurn.captured.includes('name') && userTurn.replaced.length === 0) {
      // "Hola, ¿cómo estás? Soy Luisa": se le devuelve el saludo.
      return reply(joinText(`¡Hola, ${first}!`, howAreYou ? 'Muy bien, gracias; mucho gusto.' : 'Mucho gusto.',
        userTurn.captured.includes('document') ? 'Ya tengo tu número de documento.' : '', '¿En qué te puedo ayudar?'));
    }
    return reply(joinText(opener, '¿En qué te puedo ayudar?'));
  }
  // "Gracias, me sirvió mucho", "muy clara la información, gracias", "gracias, voy a revisar": agradece y cierra,
  // aunque no use una frase de cierre conocida (si no pregunta ni cuenta algo de su caso o del servicio).
  if (THANKS_WORD.test(n) && !question && !asksForInfo(n) && !NOT_ONLY_THANKS.test(n) && !COMMERCIAL_RE.test(n) && intent === 'other') {
    return reply(vary(thanksTexts(you)), { kind: 'closing' });
  }

  const r = await ask();
  if (r.type === 'answer' && r.reason === 'offtopic') {
    await clearSubjectIf(db, company.id, conv.id, body.message);
    return reply(vary(offTopicTexts(company).map((t) => joinText(ack, t))));
  }
  if (r.type === 'answer') {
    if (r.reason) return reply(withOpener(r.message), { link: r.link });
    // "¿Cuál es el teléfono para hablar con un asesor?": se da el dato y se ofrece seguir por aquí.
    if (asksContact(body.message) && NAMES_ADVISOR.test(body.message) && !negated) {
      return reply(joinText(withOpener(r.message), 'Si prefieres, también te comunico por aquí con un asesor. ¿Quieres?'), { kind: 'offer', link: r.link });
    }
    return answer(withOpener(r.message), r.link);
  }
  if (r.reason === 'human' || r.reason === 'sensitive') return collect('start', r.message, ack);
  // Dijo que no quiere un asesor: no se le ofrece uno, aunque el sitio no tenga lo que pregunta.
  if (negated) {
    if (!question && !asksForInfo(body.message)) {
      return reply(fresh([joinText(opener, `Está bien${you}, no hay problema. Si necesitas algo más, aquí estoy.`), joinText(opener, `De acuerdo${you}. Aquí estoy si te surge otra pregunta.`)]));
    }
    const lead = r.reason === 'not_found' && r.message && !NAMES_ADVISOR.test(r.message) ? r.message : 'Ese dato no aparece publicado en el sitio.';
    return reply(fresh([joinText(opener, lead, '¿Te ayudo con algo más?'), joinText(opener, 'Esa información no la tengo disponible. ¿Te ayudo con algo más?')]));
  }
  // Una queja ("el asesor no me ha contestado", "la línea no contesta"): se lamenta y se ofrece un asesor, aunque traiga
  // una pregunta ("el asesor no me ha escrito, ¿qué pasó?").
  if (isComplaint(body.message) && (r.reason === 'unavailable' || r.reason === 'not_found')) {
    return reply(fresh(COMPLAINT_LEADS.map((l) => joinText(opener, offerAdvisor(l)))), { kind: 'offer' });
  }
  // Sin modelo y sin una pregunta: algo que cuenta recibe la oferta de un asesor (sin hablar de "esa respuesta"); algo
  // corto que no se entiende ("asdfgh", "conciliación"), que cuente más. Una empresa que quiere contratar, también.
  if (r.reason === 'unavailable' && (!question || COMMERCIAL_RE.test(n))) {
    if (rest.split(' ').length >= 4 || COMMERCIAL_RE.test(n)) return reply(fresh(STATEMENT_LEADS.map((l) => joinText(opener, offerAdvisor(l)))), { kind: 'offer' });
    return reply(vary(UNCLEAR.map((t) => joinText(opener, t))));
  }
  // La página no tiene la respuesta o el modelo no está disponible: se ofrece un asesor; el visitante decide.
  const leads = r.reason === 'unavailable' ? UNAVAILABLE : [r.message || 'No tengo esa información publicada en el sitio.', ...UNAVAILABLE.slice(2)];
  return reply(fresh(leads.map((l) => joinText(opener, offerAdvisor(l)))), { kind: 'offer' });
}
