import type { Db } from '../db';
import type { Company } from '../models/companies';
import type { PublicSession } from '../models/public';
import { listPortfolios } from '../models/portfolios';
import { HttpError } from '../utils/errors';
import { createHandoff } from './handoff';
import { joinText, normalize, tidy } from '../utils/text';
import {
  answerChat, asksContact, companyFacts, companyName, companyNumberText, helpTexts, identityAgainText, identityText, isComplaint, NAMES_ADVISOR, offerAdvisor,
  offTopicTexts, type ChatDeps, type ChatMoment, type ChatReply,
} from './chat';
import {
  acceptsOffer, afterYes, analyze, announcesQuestion, asksWhichDocument, cancelOf, COMMERCIAL_RE, HUMAN_NEGATED, isConfused, isHold, isSensitive,
  isWaitQuestion, isWhyData, looksLikeQuestion, mentionsCase, negatesAdvisorOnly, POSTPONE_WHEN, refusedFields, refuseQuestion, withoutQuestionTag, yesNo,
} from './intents';
import type { LiveNotify } from './liveEvents';
import {
  botState, cancelWaiting, clearSubjectIf, dataList, finishBotTurn, MAX_HANDOFF_DATA_REQUESTS, MAX_HANDOFF_DATA_REQUESTS_HARD, missingData,
  recentTurns, startUserTurn, subjectText, type DataField, type LiveChatSession, type UserTurn,
} from './liveChat';
import { COMMON, EVERYDAY, FIRST_NAMES, PLACES, SURNAMES } from './lexicon';
import { asksForInfo, namedPortfolios, offeredPortfolios, onlyData } from './visitorData';

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
  /** Enlace de WhatsApp del asesor al que se remite al visitante (ya con el mensaje armado). */
  waUrl?: string;
  handoffId?: string;
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
  const upper = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : text);
  // "¡Hola, María del Pilar! …", "¡Hola, doña Gloria! …", "¡Hola Andrea, qué gusto saludarte! …", "¡Hola, Mauricio, gracias
  // por escribirnos, con gusto te cuento lo que hacemos! …": entre "¡" y "!" todo es el saludo (con el nombre que el
  // modelo haya puesto): se quita entero. Nunca queda un "!" sin su "¡". Si trae la respuesta ("¡Hola, sí atendemos en
  // Bogotá!"), se deja.
  if (/^¡/.test(text.trimStart())) {
    const close = rest.indexOf('!');
    if (close >= 0 && close <= 160 && !/[¡?¿]/.test(rest.slice(0, close)) && !GREETING_CONTENT.test(normalize(rest.slice(0, close)))) {
      return upper(rest.slice(close + 1).trim());
    }
  }
  // "Hola Pedro, …": el nombre que sigue al saludo es el del visitante o, si no se sabe, uno de pila conocido (con su
  // tratamiento: "Hola, señora Ruiz.").
  const who = rest.match(/^,?\s*((?:(?:[Ss]e[ñn]or(?:a|ita)?|[Dd]o[ñn]a|[Dd]on|[Dd]octor(?:a)?|[Dd]ra?\.?)\s+)?[A-ZÁÉÍÓÚÑ][\p{L}]+(?:\s+(?:(?:de|del|de la|de los)\s+)?[A-ZÁÉÍÓÚÑ][\p{L}]+){0,3})(?=\s*[!,.])/u);
  if (who) {
    const words = normalize(who[1]).split(' ').filter((w) => !/^(senor|senora|senorita|dona|don|doctor|doctora|dr|dra)$/.test(w));
    const first = words[0] ?? '';
    const visitor = name ? normalize(name).split(' ') : [];
    const titled = /^(se[ñn]or|do[ñn]a|don|doctor|dra?\b)/iu.test(who[1]);
    if ((visitor.length > 0 && (visitor.includes(first) || titled)) || (visitor.length === 0 && FIRST_NAMES.has(first))) rest = rest.slice(who[0].length);
  }
  const pause = rest.match(/^\s*[!,.]+\s*/);
  if (!pause) return text; // "Hola" pegado a la frase: no era un saludo aparte
  return upper(rest.slice(pause[0].length));
}
/** Lo que hace que un "¡Hola, …!" del modelo traiga la respuesta y no sea solo el saludo. */
const GREETING_CONTENT = /\b(si|no|atendemos|trabajamos|tenemos|ofrecemos|estamos en|contamos con|manejamos|prestamos|brindamos|somos|integramos|claro que si|quedamos|puedes|puede)\b|\d/;
/**
 * "Mucho gusto.", "¡Qué gusto saludarte!", "¿Qué tal, Hernán?" al inicio de la respuesta del modelo (ya sin su saludo):
 * repetirían la cortesía con que abre el bot ("¡Hola, Julián! Mucho gusto."). Se quitan; si nombran a otra persona, no.
 */
const COURTESY_LEAD = /^\s*(?:¡\s*)?(?:[Mm]ucho gusto|[Uu]n gusto|[Uu]n placer|[Ee]ncantad[oa]|[Qq]u[eé] gusto(?: (?:saludarte|saludarlo|saludarla|conocerte))?|[Qq]u[eé] bueno saludarte|¿\s*[Qq]u[eé] tal|¿\s*[Cc][oó]mo (?:est[aá]s|est[aá]|te va|le va))(?:,?\s+(?<who>\p{Lu}[\p{L}]+))?\s*[.!?]+\s*/u;
function withoutCourtesy(text: string, name?: string | null): string {
  const first = name ? normalize(name).split(' ')[0] : '';
  let t = text;
  for (let i = 0; i < 3; i++) {
    const m = t.match(COURTESY_LEAD);
    if (!m || (m.groups?.who && first && normalize(m.groups.who) !== first)) break;
    t = t.slice(m[0].length);
  }
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : text;
}
/** "Quiero un asesor, pero primero dime el correo": la parte que pregunta otra cosa (o null). */
function otherQuestion(message: string): string | null {
  // Cada parte con su signo: "¿Eres un bot? ¿La asesoría legal tiene costo?" → la segunda es una pregunta.
  const parts = [...message.matchAll(/([^,;.!?¿¡]+?)(?:\s(?:pero|y|e|antes)\s|([,;.!?¡¿]+)|$)/gi)]
    .map((m) => ({ text: m[1].trim(), asked: /\?/.test(m[2] ?? '') }))
    .filter((p) => !!p.text);
  const asks = parts.filter((p) => !['human', 'identity'].includes(analyze(p.text).intent) && normalize(p.text).split(' ').length >= 2
    && (p.asked || looksLikeQuestion(p.text)));
  return asks.length > 0 ? asks.map((p) => p.text).join(', ') : null;
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
/** Pasa a la cola sin haber dicho su cartera: lo atiende un asesor de una cartera elegida al azar. */
/** Se remite a un asesor por WhatsApp (el panel puede tomar el chat, pero el visitante no cuenta con eso). */
const WA_REFERRAL = 'Te remito con un asesor por WhatsApp: toca el botón para escribirle.';
/** Remite sin haber dicho su cartera: lo atiende un asesor de una cartera elegida al azar. */
const RANDOM_QUEUE = 'Te remito con un asesor de forma aleatoria por WhatsApp: toca el botón para escribirle.';
/** "Tengo una deuda atrasada y quiero hablar con un asesor" → "Tengo una deuda atrasada": el pedido del asesor no es la consulta. */
const withoutAdvisorRequest = (subject: string) => subject
  .replace(/\s*(?:[,;]|\by\b|\bpero\b)?\s*(?:quiero|necesito|quisiera|deseo|requiero|me gustar[ií]a)\s+(?:hablar|comunicarme|que me (?:pasen|comuniquen|atiendan?)|un asesor|una asesora|pasar|contactar)[^.?!]*$/iu, '')
  .replace(/[\s,;]+$/, '').trim();
const NO_ADVISOR_WA = 'En este momento no hay un asesor disponible por WhatsApp. Inténtalo de nuevo más tarde o consulta los canales de atención del sitio.';
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
const complaintLeads = (you: string) => [`Lamento el inconveniente${you}. Un asesor puede revisarlo contigo.`, `Lamento lo ocurrido${you}; un asesor puede ayudarte a revisarlo.`];
/** "Gracias, pero no me sirvió", "gracias por nada", "eso no fue lo que pregunté": no quedó satisfecho. */
const DISSATISFIED = /\b(no me (sirvio|sirve|ayudo|ayudaste|ayudaron|respondio|respondiste|respondieron|resolvio|resolviste|soluciono|solucionaste|aclaro|aclaraste|contesto|contestaste)( de nada| nada)?|no fue lo que (pregunte|pedi|necesitaba|queria|buscaba)|eso no (era|es) lo que (pregunte|pedi|necesitaba|queria|buscaba)|gracias por nada|no sirve de nada|no sirvio de nada|igual no (me )?(sirve|sirvio)|sigo (con la duda|sin entender))\b/;
/** "Es de Falabella", "por Finandina", "ninguna de esas, es de Movistar": respondió la cartera con una que no es de la empresa. */
const PORTFOLIO_HINT = /^(es )?(de|con|del|por|la de|el de|cartera|es la|es el)\b|^(ninguna|ninguno|no es ninguna|otra|es otra)\b/;
/** "Después te escribo", "luego miro", "mañana te aviso": lo deja para otro momento. */
const LATER = /\b(?:(?:te|le|les) (?:escribo|escribire|aviso|avisare|llamo|marco|contacto|cuento) (?:luego|despues|mas tarde|manana|en un rato|otro dia)|(?:luego|despues|mas tarde|manana|en un rato|otro dia) (?:te |le |les )?(?:escribo|escribire|aviso|avisare|llamo|marco|contacto|cuento|hablamos|vuelvo|volvere|regreso|miro|reviso))\b/;
/** Se despide ("no gracias, chao", "no, muchas gracias, adiós", "no, ya me voy", "después te escribo"). */
const FAREWELL = new RegExp(`\\b(chao|chau|adios|bye|hasta luego|hasta pronto|hasta manana|nos vemos|que (este|estes|esten) bien|buen dia|buena tarde|buena noche|buenas noches|buenas tardes|feliz (dia|tarde|noche)|ya me voy|me voy|bendiciones|que le vaya bien|que te vaya bien)\\b|${LATER.source}`);
/** Despedidas del bot; a quien lo deja para después, que lo espera. */
const farewellTexts = (you: string, later = false) => (later
  ? [`Está bien${you}. Aquí estaré cuando quieras escribirme.`, `Claro${you}, aquí estoy cuando quieras.`]
  : [`¡Hasta pronto${you}! Aquí estaré si necesitas algo más.`, `¡Que te vaya bien${you}! Si te surge otra duda, escríbeme.`]);
/** "Gracias, me sirvió mucho", "muy clara la información, gracias", "gracias, voy a revisar": agradece y cierra. */
const THANKS_WORD = /\b(gracias|agradezco|agradecid[oa]|muy amables?)\b/;
/** Lo que hace que un mensaje con "gracias" no sea solo un cierre (pide o cuenta algo de su caso o del servicio). */
const NOT_ONLY_THANKS = /\b(contratar|cotizar|cotizacion|empresa|negocio|deuda|deudas|pago|pagar|saldo|credito|cuenta|proceso|caso|asesor|asesora|ayuda|ayudar|ayudame|pregunta|duda|consulta|necesito|quiero|quisiera|tengo|como|cuando|donde|cual|cuanto)\b/;
/** "Es la cédula de mi esposa", "es para mi mamá": habla de sus datos, no nombra una entidad. */
const ABOUT_DATA = /\b(cedula|documento|numero|nombre|mama|papa|esposa|esposo|hijo|hija|hermano|hermana|familiar)\b/;
/** Respuestas a quien pregunta por la espera mientras se le piden los datos. */
const WAIT_COLLECTING = 'En cuanto me indiques tu cartera pasas a la fila de atención, y el asesor te escribirá por este mismo chat apenas esté disponible.';
/** Lo mismo cuando ese mensaje completó los datos (pasa a la cola ahora). */
const WAIT_DONE = 'Ya pasas a la fila de atención: el asesor te escribirá por este mismo chat apenas esté disponible.';
/** "General, Claro u Offcorss", "Offcorss o Flamingo". */
const orList = (parts: string[]) => {
  if (parts.length < 2) return parts[0] ?? '';
  const last = parts.at(-1)!;
  return `${parts.slice(0, -1).join(', ')} ${/^h?o/i.test(normalize(last)) ? 'u' : 'o'} ${last}`;
};
/** "Flamingo ni Offcorss", "General, Claro ni Flamingo". */
const niList = (parts: string[]) => (parts.length < 2 ? parts[0] ?? '' : `${parts.slice(0, -1).join(', ')} ni ${parts.at(-1)}`);
/** "Las dos", "ambas", "de las dos": responde que su consulta es de todas las que se nombraron. */
const BOTH_RE = /^(?:(?:es|son|seria|creo que)\s+)?(?:de |con )?(?:las dos|los dos|las 2|los 2|ambas|ambos|todas|todos|las tres|las 3|todas las anteriores)(?: (?:por favor|gracias|tengo deudas?|tengo deuda con las dos))?$/;
/** "Ninguna", "ninguna de esas", "es otra": la cartera no es de la empresa. */
const NONE_OF_THEM = /^(ninguna|ninguno|no es ninguna|otra|es otra|otra cartera|otra empresa)\b/;
/** "Transfiéreme", "pásame ya", "que me comuniquen": quiere que lo pasen ya, sin dar la cartera. */
const TRANSFER_NOW = /\b(transfier\w*|transfer\w*|pasame|paseme|pasenme|pasen|pasarme|comunic\w*|comuniqu\w*|remit\w*|conect\w*)\b/;
/** "Con cualquiera", "me da igual", "el que sea": le da lo mismo cuál asesor. */
const ANY_ADVISOR = /\b(cualquier(?:a)?|me da igual|da lo mismo|no importa|el que sea|la que sea|al azar|aleatori\w*|asesor en general|asesor general)\b/;
/** Una palabra con pinta de entidad: una marca conocida ("Movistar") o un nombre propio con mayúscula que no es de uso diario. */
const entityIn = (raw: string, leftover: string, capitalizedOk: boolean) => {
  const words = leftover.split(' ').filter((w) => w.length >= 3);
  if (words.some((w) => COMMON.has(w) && !EVERYDAY.has(w))) return true;
  if (!capitalizedOk) return false;
  return raw.split(/\s+/).some((piece) => {
    const w = piece.replace(/^[¿¡"'(]+|[,.;:!?)"']+$/g, '');
    const nw = normalize(w);
    return /^[A-ZÁÉÍÓÚÑ]/.test(w) && nw.length >= 3 && words.includes(nw) && !EVERYDAY.has(nw) && !FIRST_NAMES.has(nw) && !SURNAMES.has(nw)
      && !PLACES.has(nw) && !/^(ja|je|ji|jo|ha|he|xd)+$/.test(nw);
  });
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
  // Con varias, si el visitante no dijo la suya, una al azar de la lista (así lo atiende algún asesor).
  const queuePortfolio = portfolios.length === 0 ? null : portfolios[Math.floor(Math.random() * portfolios.length)];
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
  const negated = HUMAN_NEGATED.test(normalize(withoutQuestionTag(body.message)));
  const pureData = onlyData(userTurn.extracted);
  /** El mensaje solo dejaba un número de contacto ("mi wsp 3104567890"). */
  const phoneOnly = pureData && !!userTurn.extracted.phone && userTurn.captured.length === 0;
  /** El visitante está colaborando: entregó un dato o un número de contacto. */
  const progressed = userTurn.captured.length > 0 || phoneOnly;
  /** El último mensaje del bot preguntó algo: un "no" o un "mejor no" le responde a esa pregunta. */
  const answering = /\?/.test(bot.lastText ?? '');
  // "1020304050 dónde quedan", "Juan Pérez cuál es el horario", "Juan Pérez qué servicios ofrecen": sin los datos, lo que
  // queda pregunta algo.
  const question = looksLikeQuestion(body.message, rest)
    || (userTurn.captured.length > 0 && !!userTurn.extracted.rest && looksLikeQuestion(userTurn.extracted.rest))
    || (userTurn.captured.length > 0 && !!userTurn.extracted.said && looksLikeQuestion(userTurn.extracted.said));
  /**
   * Solo dejaba datos, o corrigió uno sin preguntar nada ("lo escribí mal, es 1020304051", "no es de Flamingo, es de los
   * de Claro"): basta el acuse de la corrección.
   */
  const dataOnly = pureData || (userTurn.replaced.length > 0 && !question && intent !== 'human' && intent !== 'sensitive');
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
      link?: ChatReply['link']; waived?: DataField[]; offerPending?: boolean;
    } = {},
  ): Promise<LiveResponse> => {
    // `progress`: este pedido de datos responde a un mensaje que sí trajo datos (el visitante está colaborando).
    // `waived`: datos que el bot deja de pedir en esta toma (el asesor los confirma). `offer`: la oferta de un asesor
    // sigue pendiente mientras se le pregunta el nombre ("no me llamo Pedro" tras la oferta).
    const metadata = opts.kind
      ? {
        kind: opts.kind, ...(opts.field ? { field: opts.field } : {}), ...(opts.field === 'handoff' && progressed ? { progress: true } : {}),
        ...(opts.waived?.length ? { waived: opts.waived.join(',') } : {}), ...(opts.offerPending ? { offer: 'pending' } : {}),
      }
      : {};
    if (opts.escalate) return referToWhatsapp(text);
    const saved = await finishBotTurn(db, company.id, conv.id, text, false, metadata);
    if (saved.message) notify(company.id, 'chat_message', { conversationId: conv.id, messageId: saved.message.id, sender: saved.message.sender_type });
    const status = saved.conversation.status;
    if (status !== conv.status) notify(company.id, 'chat_status', { conversationId: conv.id, status });
    // Un asesor tomó el chat mientras el bot pensaba: su respuesta no se envía.
    if (status === 'TOMADO_POR_ASESOR') return { type: 'live', message: 'Tu mensaje fue enviado al asesor.', conversation: { id: conv.id, status } };
    return { type: 'answer', message: text, link: opts.link, conversation: { id: conv.id, status } };
  };

  /** Texto con que se remite a WhatsApp: si el visitante ya contó su consulta, el mensaje la lleva. */
  const waReason = withoutAdvisorRequest(conv.subject ?? '');
  const waText = () => (waReason ? `${WA_REFERRAL} El mensaje ya lleva tu consulta.` : WA_REFERRAL);
  /**
   * Remite al visitante con un asesor por WhatsApp (el número es el de un asesor de su cartera; sin cartera, de una al
   * azar). El mensaje del enlace lleva lo que preguntó y, si no preguntó nada, uno base que pide la información. La
   * conversación sigue abierta: quien administra el panel puede tomarla en cualquier momento, aunque el visitante no
   * cuente con eso.
   */
  const referToWhatsapp = async (text: string): Promise<LiveResponse> => {
    const chosen = active && !conv.portfolio_auto ? active : queuePortfolio;
    let waUrl: string | undefined;
    let handoffId: string | undefined;
    // "Te comunico con un asesor. Te remito con un asesor por WhatsApp" diría lo mismo dos veces.
    let said = text.replace(/Te comunico con (?:un asesor|otro asesor|uno)\.\s+(?=Te remito)/, '');
    try {
      const r = await createHandoff(db, company, session, {
        idempotencyKey: `chat-live-${chosen?.key ?? 'any'}`, portfolioKeyHint: chosen?.key,
        name: conv.visitor_name ?? '', reason: waReason,
      }, notify);
      waUrl = r.handoff.wa_url;
      handoffId = r.handoff.id;
    } catch (e) {
      if (!(e instanceof HttpError && e.code === 'no_advisor_available')) throw e;
      said = NO_ADVISOR_WA;
    }
    // Sin cartera, queda en la que se eligió (marcada como del sistema) para que la vean los asesores de esa cartera.
    if (!conv.portfolio_id && chosen) {
      await db.query('UPDATE chat_sessions SET portfolio_id = $3, portfolio_auto = true WHERE id = $1 AND company_id = $2 AND portfolio_id IS NULL', [conv.id, company.id, chosen.id]);
    }
    const saved = await finishBotTurn(db, company.id, conv.id, said, false, { kind: 'whatsapp', ...(waUrl ? { waUrl, handoffId } : {}) });
    if (saved.message) notify(company.id, 'chat_message', { conversationId: conv.id, messageId: saved.message.id, sender: 'BOT' });
    const status = saved.conversation.status;
    if (status === 'TOMADO_POR_ASESOR') return { type: 'live', message: 'Tu mensaje fue enviado al asesor.', conversation: { id: conv.id, status } };
    return { type: 'answer', message: said, ...(waUrl ? { waUrl, handoffId } : {}), conversation: { id: conv.id, status } };
  };

  /**
   * Lo que se busca en el sitio: el mensaje sin el nombre ni el documento ("Ana Ruiz, ¿qué servicios tienen?" → "¿qué
   * servicios tienen?"), para que el atajo del sitio lo reconozca.
   */
  const asked = userTurn.extracted.name || userTurn.extracted.document ? subjectText(body.message, userTurn.extracted) || body.message : body.message;
  /** Respuesta del sitio o del modelo, con el hilo de la conversación (desde la base, no desde el navegador) y el estado. */
  const ask = async (text = asked): Promise<ChatReply> => answerChat(
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
    // "No es Flamingo" con Flamingo elegida: la conversación volvió a la cartera por defecto; se le pregunta cuál es.
    if (userTurn.cleared.includes('portfolio')) {
      const negatedNames = namedPortfolios(body.message, portfolios).list;
      const others = portfolios.filter((p) => !negatedNames.some((x) => x.key === p.key));
      return reply(joinText(
        `Entendido${you}, no es ${niList(negatedNames.map((p) => p.name))}.`,
        others.length > 0 ? `¿Es de ${orList(others.map((p) => p.name))}? Si no estás seguro, el asesor lo confirma contigo.` : 'El asesor confirma la cartera contigo.',
      ));
    }
    if (dataOnly) {
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
    // "Sí" a "¿Es de General o Claro?": no dice cuál; se le pide que precise (o el asesor lo confirma).
    const askedPortfolios = offeredPortfolios(bot.lastText ?? '', portfolios).list;
    if (plainYes && askedPortfolios.length >= 2) {
      return reply(`¿De cuál de ellas: ${orList(askedPortfolios.map((p) => p.name))}? Si no estás seguro, el asesor lo confirma contigo.`);
    }
    if (plainYes && answering) return reply(fresh(['¡Claro! ¿En qué te ayudo mientras tanto?', 'Cuéntame, ¿qué necesitas saber?']));
    if (plainYes) return reply(fresh([`¡Listo${you}! El asesor te escribirá por aquí en cuanto esté disponible.`, `Perfecto${you}. El asesor continuará contigo por este chat.`]));
    // "Después te escribo", "mañana vuelvo": no agradece nada; sigue en la fila.
    if (LATER.test(n) && !question) {
      return reply(fresh([
        joinText(ack, `Está bien${you2}. Tu solicitud sigue en la fila y el asesor te escribirá por este mismo chat.`),
        joinText(ack, `Listo${you2}, cuando vuelvas el asesor podrá continuar contigo por este mismo chat.`),
      ]));
    }
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
    // Sin la cartera (la empresa tiene varias) pasa con un asesor de una cartera elegida al azar.
    const queued = missing.includes('portfolio') && noteMissing ? RANDOM_QUEUE : waText();
    const thanks = !opening && progressed ? `Gracias${you}.` : '';
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
    return reply(
      missing.includes('portfolio') && noteMissing ? RANDOM_QUEUE : waText(),
      { escalate: true },
    );
  };

  const handoffAck = ackText(userTurn, conv, portfolioName, true, phoneOnly);
  /**
   * Las carteras entre las que el bot preguntó por última vez en esta toma ("¿Tu consulta es de Flamingo o de Offcorss?",
   * "Entendido, no es Flamingo ni Offcorss. ¿Es de General?"), si no eran todas. Solo cuentan sus preguntas por la
   * cartera: una respuesta del sitio que nombra aliados no.
   */
  const remembered = (() => {
    if (portfolios.length < 3) return null;
    for (const t of [...bot.collectTexts].reverse()) {
      if (!/\bcartera\b|¿(?:tu consulta )?es de\b/i.test(t)) continue;
      const offered = offeredPortfolios(t, portfolios).list;
      if (offered.length === 0) continue;
      return offered.length < portfolios.length ? offered.map((p) => p.name) : null;
    }
    return null;
  })();

  /**
   * Para pasar con un asesor solo se pregunta la cartera (si la empresa tiene varias): con ella pasa directo a un asesor
   * de esa cartera. Si no la da, se le avisa que pasará con uno al azar; si insiste (tras MAX_HANDOFF_DATA_REQUESTS
   * pedidos sin respuesta), pasa a la cola en una cartera elegida al azar. `opening`: lo que se responde antes (el motivo
   * o la respuesta a una pregunta); `ack`: el agradecimiento por lo que trajo este mensaje.
   */
  const collect = (mode: 'start' | 'continue' | 'remind', opening = '', ack = handoffAck, opts: { waive?: DataField[]; options?: string[] } = {}) => {
    const need = missing.filter((f) => !opts.waive?.includes(f));
    const stalled = !progressed && bot.stalledAsks >= MAX_HANDOFF_DATA_REQUESTS;
    if (need.length === 0 || stalled || bot.handoffAsks >= MAX_HANDOFF_DATA_REQUESTS_HARD) {
      // Lo que se le acababa de responder va aparte del aviso de la cola.
      if (mode === 'remind' && opening) return answerThenQueue(joinText(ack, opening));
      return escalate(joinText(ack, opening));
    }
    // Si ya nombró entre cuáles carteras duda ("tengo deuda con Claro y con Flamingo"), se le pregunta entre esas.
    const names = orList(opts.options ?? remembered ?? portfolioNames);
    const lead = joinText(ack, opening);
    const text = mode === 'start'
      ? joinText(lead, `¿De qué cartera es tu consulta: ${names}? Si me la indicas, te paso directamente con un asesor de esa cartera; si no, te paso con un asesor en general.`)
      : mode === 'continue'
        ? joinText(lead, `Para pasarte directamente con un asesor de tu cartera, dime cuál es: ${names}.`)
        : joinText(lead, `Si me indicas la cartera de tu consulta (${names}), te paso directamente con un asesor de esa cartera; si no, te paso con un asesor de forma aleatoria.`);
    return reply(text, { kind: 'data_request', field: 'handoff', waived: opts.waive });
  };

  // R3: el bot ofreció un asesor en su último mensaje.
  if (bot.lastKind === 'offer') {
    // "No me llamo Pedro": se borró el nombre; no es un "no" a la oferta, que sigue en pie cuando diga cómo se llama.
    if (userTurn.cleared.includes('name')) return reply('Disculpa la confusión. ¿Cómo te llamas?', { kind: 'data_request', field: 'name', offerPending: true });
    if (pureData) {
      // "Claro, me llamo Pedro", "dale, Pedro Gómez", "Pedro, sí", "sí, Juan Pérez 1020304050": acepta y da sus datos.
      const accepts = acceptsOffer(body.message);
      // "Me llamo Carlos, y no gracias", "no gracias, soy Pedro": da su nombre y no quiere el asesor.
      const declines = !accepts && (/(?:^|\s)(?:no|nop|nel)(?: gracias| por ahora| todavia| por el momento)?$/.test(n)
        || (/^(?:no|nop|nel)(?: gracias)?\b/.test(n) && !/\b(no me llamo|no soy|mi nombre no es)\b/.test(n)));
      if (declines) return reply(fresh([`Está bien${you}. ¿Hay algo más en lo que te pueda ayudar?`, `De acuerdo${you}. ¿Te ayudo con algo más?`]));
      if (accepts) return collect('start', joinText(`¡Listo${you}! Te comunico con un asesor.`, missing.length > 0 ? dataNotes(userTurn, portfolioName) : ''), '');
      // Solo dijo, repitió o completó su nombre (o lo corrigió: "no me llamo Pedro, me llamo Juan"): todavía no aceptó;
      // la oferta sigue en pie.
      if (userTurn.captured.every((f) => f === 'name')) {
        return reply(offerAdvisor(userTurn.captured.length > 0 ? ackText(userTurn, conv, portfolioName, false) : `Gracias${you}.`), { kind: 'offer' });
      }
      return collect('start');
    }
    // "No entiendo", "¿cómo así?": no dijo que no; se le explica la oferta.
    if (isConfused(body.message)) {
      return reply(fresh([
        'Te explico: puedo remitirte con un asesor por WhatsApp para que revise tu consulta contigo. ¿Quieres que lo haga?',
        'Me refiero a que un asesor puede atenderte por WhatsApp. ¿Te remito con uno?',
      ]), { kind: 'offer' });
    }
    // "Sí, no hay problema", "sí, pero no tengo la cédula a la mano": también aceptan.
    if (answerTo === 'yes' || intent === 'human' || (answerTo === null && !question && acceptsOffer(body.message))) {
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
    // "No gracias, igual no me sirvió", "no, gracias por nada": no quiere el asesor, pero no quedó satisfecho.
    if (declined && DISSATISFIED.test(n)) return reply(`Lamento que no te haya servido${you}. ¿Me cuentas qué necesitas y lo intento de nuevo?`);
    if (declined && FAREWELL.test(n)) return reply(vary(thanksTexts(you)), { kind: 'closing' });
    if (declined) return reply(fresh([`Está bien${you}. ¿Hay algo más en lo que te pueda ayudar?`, `De acuerdo${you}. ¿Te ayudo con algo más?`]));
    // "Después te escribo", "chao": se despide; "gracias": agradece.
    if (answerTo === 'closing') return reply(FAREWELL.test(n) && !THANKS_WORD.test(n) ? fresh(farewellTexts(you, LATER.test(n))) : vary(thanksTexts(you)), { kind: 'closing' });
    // Otra pregunta: se atiende normalmente.
  }

  // R4: reuniendo los datos para el asesor.
  if (collecting) {
    const moment: ChatMoment = 'collecting';
    // "Ana Ruiz 43123456, mañana vuelvo": entregó datos; aplazar no suelta la solicitud.
    const cancel = cancelOf(body.message, { hasData: progressed });
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
    if (asksWhichDocument(body.message) && missing.includes('document') && !userTurn.captured.includes('document')) return collect('remind', WHICH_DOCUMENT);
    // "Un momento, ya te la paso: 43123456" trajo el dato: se toma en vez de esperar. "Luego te paso la cédula", "mañana te
    // escribo con los datos": se le espera.
    if (isHold(body.message) && !progressed) {
      return reply(fresh(POSTPONE_WHEN.test(n)
        ? ['Claro. Cuando los tengas, escríbeme por aquí y te paso con el asesor.', 'Listo, aquí te espero; cuando los tengas, escríbeme por aquí.']
        : ['Claro, aquí te espero.', 'Tranquilo, tómate tu tiempo; aquí te espero.']), { kind: 'hold', field: 'handoff' });
    }
    // "No entiendo": se le explica para qué son los datos (o qué es la cartera) y se le vuelven a pedir.
    if (isConfused(body.message) && !progressed) {
      const onlyPortfolio = missing.length === 1 && missing[0] === 'portfolio';
      return collect('remind', onlyPortfolio
        ? 'La cartera es la empresa o marca con la que tienes tu consulta. Si no estás seguro, dímelo y el asesor la confirma contigo.'
        : 'La cartera es la empresa o marca con la que tienes tu consulta.');
    }
    // "Ninguna de las dos" a "¿Tu consulta es de Flamingo o de Offcorss?": niega las que el bot ofreció (no dice que su
    // cartera no sea de la empresa).
    const offeredNow = missing.includes('portfolio') ? offeredPortfolios(bot.lastText ?? '', portfolios).list : [];
    const noneOffered = offeredNow.length > 0 && offeredNow.length < portfolios.length
      && /^(?:ninguna|ninguno)(?: de (?:las|los) (?:dos|tres|2|3)| de esas| de esos| de las anteriores| de los anteriores)?$/.test(userTurn.captured.length > 0 ? userTurn.extracted.rest : n);
    const mentioned = noneOffered ? { list: offeredNow, negated: true }
      : missing.includes('portfolio') ? namedPortfolios(body.message, portfolios) : { list: [], negated: false };
    const named = mentioned.list;
    // "Las dos", "ambas" (a "¿Tu consulta es de Flamingo o de Offcorss?" o tras nombrar dos, también con sus datos:
    // "Juan Pérez 1020304050, las dos"): no se adivina; el asesor las revisa con él.
    if (missing.includes('portfolio') && (BOTH_RE.test(n)
      || (userTurn.captured.length > 0 && (BOTH_RE.test(userTurn.extracted.rest) || BOTH_RE.test(userTurn.extracted.said ?? ''))))) {
      const both = 'Entendido, el asesor las revisa contigo.';
      if (missing.length === 1) return escalate(joinText(handoffAck, both), false);
      return collect('remind', both, handoffAck, { waive: ['portfolio'] });
    }
    // "Pásame con cualquiera", "transfiéreme ya", "me da igual": no da la cartera y pide que lo pasen; se le asigna un asesor al azar.
    if (missing.includes('portfolio') && named.length === 0 && !userTurn.captured.includes('portfolio') && n.split(' ').length <= 10
      && ((!question && TRANSFER_NOW.test(n)) || ANY_ADVISOR.test(n))) {
      return escalate(joinText(handoffAck, 'Entendido.'));
    }
    let refused = noneOffered ? null : refusedFields(body.message);
    // "No sé si es de Claro o de Flamingo", "no recuerdo si es Claro": no sabe la cartera (el asesor la confirma).
    if (!refused && missing.includes('portfolio') && named.length > 0 && !userTurn.captured.includes('portfolio')
      && /^(?:no se|no lo se|no recuerdo|no me acuerdo|no estoy segur[oa]|ni idea)(?: bien)? si\b/.test(n)) refused = ['portfolio'];
    // "Juan Pérez 1020304050, no sé": con este mensaje ya completó los datos; no es una negativa.
    if (refused && progressed && missing.length === 0) return escalate();
    // "Flamingo u Offcorss, no estoy seguro": lo que no sabe es la cartera.
    if (refused === 'all' && named.length > 0) refused = ['portfolio'];
    // No sabe la cartera pero faltan otros datos: el asesor la confirma y se sigue con lo demás.
    if (refused && refused !== 'all' && refused.length === 1 && refused[0] === 'portfolio' && missing.some((f) => f !== 'portfolio')) {
      return collect('remind', 'Entiendo, no hay problema: el asesor confirma la cartera contigo.', handoffAck, { waive: ['portfolio'] });
    }
    // "No tengo cédula, tengo pasaporte AB123456": negó un dato que igual entregó; se sigue con lo que falta.
    // "No sé", "cualquiera", "no te la digo" sin haberle avisado aún: se le explica que con su cartera pasa directo y que,
    // si no, lo pasará con un asesor al azar. Si vuelve a insistir, pasa al azar.
    // (Ya se le avisó desde la primera pregunta que sin cartera pasa con un asesor en general: pasa directo.)
    if (refused && !(progressed && missing.length > 0 && refused !== 'all' && !refused.some((f) => missing.includes(f)))) {
      // "No quiero dar mi cédula, solo dime el correo": pasa sin los datos y se responde la pregunta.
      const answer = refuseQuestion(body.message) ? await answerText() : null;
      if (answer) return answerThenQueue(joinText(handoffAck, 'Entiendo, no hay problema.', answer));
      return escalate(joinText(handoffAck, 'Entiendo, no hay problema.'));
    }
    if (isWhyData(body.message)) {
      return collect('remind', 'Te pregunto la cartera para pasarte directamente con un asesor que lleve tu caso.');
    }
    // Con los datos de este mensaje ya completos pasa a la cola: no se le dice "en cuanto me compartas los datos".
    if (isWaitQuestion(body.message)) return collect('remind', missing.length === 0 ? WAIT_DONE : WAIT_COLLECTING);
    // "Quiero preguntar otra cosa": se le invita a preguntar, sin contarlo como otro pedido de datos.
    if (announcesQuestion(body.message)) {
      return reply(`Claro, dime qué quieres preguntar. Cuando quieras, me indicas la cartera de tu consulta (${orList(remembered ?? portfolioNames)}) para pasarte con el asesor.`, { kind: 'hold', field: 'handoff' });
    }
    // Nombró carteras de la empresa pero no cuál es la suya ("Offcorss y Flamingo", "tengo deudas con Flamingo y
    // Offcorss", "no es Flamingo", "ni Flamingo ni Offcorss"): se le pregunta entre esas (o entre las demás), sin decir
    // que no las encuentra.
    if ((named.length >= 2 || (named.length >= 1 && mentioned.negated)) && !userTurn.captured.includes('portfolio') && (!question || noneOffered)) {
      const options = mentioned.negated ? portfolios.filter((p) => !named.some((x) => x.key === p.key)) : named;
      const others = missing.filter((f) => f !== 'portfolio');
      if (options.length > 0) {
        const which = mentioned.negated
          ? `Entendido, no es ${niList(named.map((p) => p.name))}. ¿Es de ${orList(options.map((p) => p.name))}? Si no estás seguro, el asesor lo confirma contigo.`
          : `¿Tu consulta es ${orList(options.map((p) => `de ${p.name}`))}?`;
        const also = others.length > 0 ? `Para pasarte con el asesor también necesito ${dataList(others, portfolioNames)}.` : '';
        return reply(joinText(handoffAck, which, also), { kind: 'data_request', field: 'handoff' });
      }
      // Negó todas las carteras de la empresa: el asesor confirma con él cuál es.
      const none = `Entendido, no es ${niList(named.map((p) => p.name))}; el asesor confirma la cartera contigo.`;
      if (others.length === 0) return escalate(joinText(handoffAck, none), false);
      return collect('remind', none, handoffAck, { waive: ['portfolio'] });
    }
    // Respondió la cartera con una que no es de la empresa ("es de Falabella", "Finandina", "ninguna, es de Movistar",
    // "Juan Pérez 1020304050, es de Movistar"): el asesor la confirma. Una respuesta cualquiera ("jajaja") no lo es.
    const leftover = userTurn.captured.length > 0 ? userTurn.extracted.rest : rest;
    const foreign = missing.includes('portfolio') && named.length === 0 && !question && !ABOUT_DATA.test(n)
      && (leftover.split(' ').length <= 4 || NONE_OF_THEM.test(leftover))
      && (PORTFOLIO_HINT.test(leftover) || NONE_OF_THEM.test(leftover)
        || leftover.split(' ').some((w) => facts.words.has(w) && !EVERYDAY.has(w) && !PLACES.has(w))
        || entityIn(body.message, leftover, missing.length === 1));
    if (foreign) {
      const note = `No encuentro esa cartera entre las nuestras (${portfolioNames.join(', ')})`;
      if (missing.length === 1) return escalate(joinText(handoffAck, `${note}, pero no hay problema: el asesor lo confirma contigo.`), false);
      // No se le vuelve a pedir la cartera que acaba de decir: el asesor la confirma.
      return collect('remind', `${note}, pero no hay problema: el asesor la confirma contigo.`, handoffAck, { waive: ['portfolio'] });
    }
    if (dataOnly) return collect('continue');
    // "Sí", "claro", "dale": va a darlos.
    if (plainYes) return collect('continue', 'Perfecto.');
    // "Gracias", "ok": se le recuerda con amabilidad, sin contarlo como un pedido más.
    if ((intent === 'thanks' || answerTo === 'closing') && missing.length > 0) {
      return reply(fresh([
        `Con gusto${you}. Cuando quieras, dime la cartera de tu consulta (${orList(remembered ?? portfolioNames)}) para pasarte con el asesor.`,
        `Aquí sigo${you}. Para pasarte con el asesor solo necesito la cartera de tu consulta: ${orList(remembered ?? portfolioNames)}.`,
      ]), { kind: 'hold', field: 'handoff' });
    }
    if (intent === 'other') {
      // No es una pregunta ("jajaja", "busco la cédula"): solo se recuerda lo que falta (si trajo un dato, se agradece). Si
      // cuenta algo de su caso ("la cuota está mal, es de 250000"), se le dice que se entendió.
      if (!question) return collect(progressed ? 'continue' : 'remind', mentionsCase(n) ? 'Entiendo.' : '');
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
  // "Tengo deuda con Claro y con Flamingo": la cartera se le pregunta entre esas dos.
  const startNamed = missing.includes('portfolio') ? namedPortfolios(body.message, portfolios) : { list: [], negated: false };
  const startOptions = !startNamed.negated && startNamed.list.length >= 2 && startNamed.list.length < portfolios.length
    ? startNamed.list.map((p) => p.name) : undefined;
  // "¿Eres humano? Quiero pagar mi deuda": se presenta y, como trae su caso, empieza la toma de datos.
  const identityCase = intent === 'identity' && body.message.split(/[?¿.!]+/).some((p) => !!p.trim() && isSensitive(normalize(p)));
  if (identityCase) {
    return collect('start', joinText(identityText(company, 'collecting'), 'Para revisar tu caso te comunico con un asesor.', notes), '', { options: startOptions });
  }
  if (intent === 'human') {
    // "Quiero un asesor, pero primero dime el correo": se responde y se sigue con los datos. Si no está publicado, se
    // dice ("El horario no aparece publicado…"), en vez de ignorar la pregunta.
    const extra = refersAdvisor ? null : otherQuestion(body.message);
    const waitAsk = !!extra && isWaitQuestion(extra);
    const answer = extra && !waitAsk ? await answerText(extra) : null;
    const pending = extra && !waitAsk && !answer ? await unanswered({ advisorOk: true }) : '';
    // Con los datos completos, la respuesta va como mensaje del bot y el aviso de la cola aparte.
    if (answer && missing.length === 0) return answerThenQueue(withoutTrailingQuestion(answer));
    // "El asesor me colgó, quiero hablar con otro", "la asesora fue grosera, quiero otro asesor": primero la disculpa.
    const another = /\botr[oa] (asesor|asesora|agente|persona)\b|\b(con|atienda|atiendan|por) otr[oa]\b/.test(n) ? 'otro' : 'un';
    // "Otro asesor por favor, el anterior no me ayudó": también se disculpa.
    const sorry = isComplaint(body.message) || DISSATISFIED.test(n) ? `Lamento el inconveniente${you}.` : '';
    const opening = answer ? joinText(withoutTrailingQuestion(answer), 'Te comunico con un asesor.')
      : pending ? joinText(pending, NAMES_ADVISOR.test(pending) ? 'Te comunico con uno.' : 'Te comunico con un asesor, que te lo confirma.')
        : waitAsk ? `¡Claro${you}! Te remito con un asesor por WhatsApp.`
          : sorry ? joinText(sorry, `Te comunico con ${another} asesor.`)
            : `¡Claro${you}! Te comunico con ${another} asesor.`;
    return collect('start', joinText(opening, notes), '', { options: startOptions });
  }
  if (intent === 'sensitive') {
    // "Me llamaron del 604 607 4101, ¿es de ustedes?": se confirma el número antes de pedir los datos.
    const ours = await companyNumberText(db, company, body.message);
    // "No quiero que me llamen más, ya pagué": no pide un asesor; se le ofrece revisar su caso sin pedirle los datos.
    if (negated) return reply(joinText(ours ?? '', offerAdvisor('Entiendo. Un asesor puede revisar tu caso por WhatsApp.')), { kind: 'offer' });
    const named = userTurn.captured.includes('name') && !userTurn.replaced.includes('name') ? `Gracias, ${first}.` : '';
    return collect('start', joinText(ours, named, pick(SENSITIVE_START), notes), '', { options: startOptions });
  }

  // R6: conversación normal.
  const ack = ackText(userTurn, conv, portfolioName, false, phoneOnly);
  const hello = greeted ? (first ? `¡Hola, ${first}!` : '¡Hola!') : '';
  /** Saludo y acuse sin repetir el nombre: "¡Hola, Juan! Mucho gusto." o "¡Hola, Juan! Gracias, ya anoté tus datos.". */
  const ackAfterHello = hello && first
    ? ack.replace(`Mucho gusto, ${first}.`, 'Mucho gusto.').replace(`Gracias, ${first}, `, 'Gracias, ').replace(`Gracias, ${first}.`, 'Gracias.').replace(`Listo, ${first}, `, 'Listo, ')
    : ack;
  const opener = joinText(hello, ackAfterHello);
  /**
   * Si el bot ya saluda o se presenta, la respuesta del modelo va sin su propio saludo (no "¡Hola! ¡Hola! …") ni las
   * cortesías que repetirían la del bot ("¡Hola, Julián! Mucho gusto. Mucho gusto. …", "… ¿Qué tal, Hernán? …").
   */
  const withOpener = (text: string) => joinText(opener, opener ? withoutCourtesy(withoutGreeting(text, conv.visitor_name), conv.visitor_name) : text);
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
  // "Gracias, pero no me sirvió", "gracias por nada", "eso no fue lo que pregunté": no es un cierre; se lamenta y se
  // ofrece un asesor (o, si no quiere uno, que cuente qué necesita).
  if (DISSATISFIED.test(n) && !isComplaint(body.message)) {
    if (negated) return reply('Lamento que no te haya servido. ¿Me cuentas qué necesitas y lo intento de nuevo?');
    return reply(fresh([
      offerAdvisor(`Lamento que no te haya servido${you}. Un asesor puede revisarlo contigo.`),
      offerAdvisor(`Disculpa que no haya podido ayudarte${you}. Un asesor puede revisarlo contigo.`),
    ]), { kind: 'offer' });
  }
  // Responde "sí" o "no" a "¿Hay algo más en lo que te pueda ayudar?" o "¿Te ayudo con algo de eso?".
  // Un "ok" ahí es un acuse (se agradece); solo un "sí" explícito y sin más dice que tiene otra consulta.
  if (!pureData && ANYTHING_ELSE.test(bot.lastText ?? '')) {
    if (plainYes && /^(si|sii+|sip|sisas|claro|por supuesto|obvio)\b/.test(rest || n)) {
      return reply(fresh(['¡Claro! Cuéntame, ¿en qué te puedo ayudar?', '¡Listo! ¿Qué necesitas saber?']));
    }
    // "Después te escribo": se despide sin agradecer lo que no le dijeron.
    if ((answerTo === 'no' || answerTo === 'closing') && LATER.test(n) && !THANKS_WORD.test(n)) return reply(fresh(farewellTexts(you, true)), { kind: 'closing' });
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
    // "¿Eres un bot? ¿Cuál es el teléfono?", "¿eres un asesor? necesito el correo": se presenta y responde lo otro. Si lo
    // otro no está publicado, lo dice y ofrece un asesor (no lo ignora).
    const extra = otherQuestion(body.message);
    const extraAnswer = extra ? await answerText(extra) : null;
    if (extraAnswer) return reply(joinText(identityText(company, 'collecting'), withoutGreeting(extraAnswer, conv.visitor_name)));
    if (extra) {
      const said = await unanswered({ advisorOk: true });
      return reply(offerAdvisor(joinText(identityText(company, 'collecting'), said)), { kind: 'offer' });
    }
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
    if (farewell && !THANKS_WORD.test(n)) return reply(fresh(farewellTexts(you, LATER.test(n))), { kind: 'closing' });
    return reply(vary(thanksTexts(you)), { kind: 'closing' });
  }
  // "Quiero preguntar algo", "tengo otra pregunta": se le invita a preguntar.
  if (announcesQuestion(body.message)) {
    return reply(fresh([joinText(opener, opener ? 'Claro, dime: ¿qué quieres preguntar?' : '¡Claro! Dime, ¿qué quieres preguntar?'), joinText(opener, 'Claro, cuéntame. ¿Qué necesitas saber?')]));
  }
  // "No entiendo", "¿cómo así?": se ofrece explicar mejor.
  if (isConfused(body.message)) {
    return reply(fresh(['Disculpa si no fui claro. ¿Qué parte quieres que te explique mejor?', 'Perdona, me expliqué mal. ¿Qué te gustaría que te aclare?']));
  }
  if (intent === 'help') return reply(vary(helpTexts().map((t) => joinText(ack, t))));
  // Tras la oferta dijo "no me llamo Pedro" y ahora su nombre: la oferta sigue en pie. Si además la acepta ("me llamo Juan y
  // sí quiero", "Juan, sí") o da el documento, se le pasa con el asesor.
  if (bot.offerPending && userTurn.captured.includes('name') && dataOnly) {
    if (acceptsOffer(body.message) || userTurn.captured.includes('document')) {
      return collect('start', joinText(`¡Listo${you}! Te comunico con un asesor.`, missing.length > 0 ? dataNotes(userTurn, portfolioName) : ''), '');
    }
    return reply(offerAdvisor(ack), { kind: 'offer' });
  }
  // Dio un dato sin que se lo pidieran o respondió "¿con quién tengo el gusto?": se agradece sin pedir más.
  if (dataOnly) {
    if (greeted && userTurn.captured.includes('name') && userTurn.replaced.length === 0) {
      // "Hola, ¿cómo estás? Soy Luisa", "hola, ¿cómo estás? Luisa": se le devuelve el saludo.
      const asksHow = howAreYou || /\b(como (estas|esta|vas|va|te va|le va|amaneciste|amanecio)|que tal|que mas)\b/.test(n);
      return reply(joinText(`¡Hola, ${first}!`, asksHow ? 'Muy bien, gracias; mucho gusto.' : 'Mucho gusto.',
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
    // "¿Cuál es el teléfono para hablar con un asesor?", "…para hacer un acuerdo de pago?": se da el dato y se ofrece seguir
    // por aquí.
    if (asksContact(body.message) && (NAMES_ADVISOR.test(body.message) || mentionsCase(n)) && !negated) {
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
    // Primero la disculpa; lo que anotó del mensaje va después ("…Ya anoté la cartera Flamingo. ¿Quieres…?"). Si el saludo
    // ya dice el nombre ("¡Hola, Ana!"), la disculpa no lo repite.
    const named = userTurn.captured.includes('name') && first && !hello ? `, ${first}` : '';
    const noted = dataNotes(userTurn, portfolioName);
    return reply(fresh(complaintLeads(named).map((l) => joinText(hello, offerAdvisor(joinText(l, noted))))), { kind: 'offer' });
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
