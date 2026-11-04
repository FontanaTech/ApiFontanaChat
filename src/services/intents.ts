import { normalize } from '../utils/text';

/**
 * ÚNICA fuente de las reglas de intención del chat (chat clásico y chat en vivo usan las mismas).
 *
 * Se evalúan sobre el texto normalizado (minúsculas, sin tildes ni signos). Primero se separa lo que va al inicio
 * y no es el tema ("hola, …", "gracias, …", "una pregunta, …"): "hola, ¿cuál es el teléfono?" es una pregunta, no
 * un saludo. Luego, en este orden de prioridad:
 *   1. human     → pide hablar con un asesor o una persona (no si lo niega, si busca empleo como asesor ni si solo
 *                  pregunta si habla con una persona: "¿eres una persona real?" es identidad)
 *   2. identity  → "¿quién eres?", "¿eres un bot / una persona?"             (se responde, nunca escala)
 *   3. thanks    → "gracias", "ok", "muy amable", "chao", "que tenga buen día" (se responde, nunca escala)
 *   4. sensitive → SU pago, SU deuda, SU proceso jurídico (asunto personal)  (reúne datos y pasa a la cola)
 *   5. greeting  → "hola", "buenas tardes", "¿hay alguien ahí?"              (saludo corto)
 *   6. help      → "necesito ayuda", "tengo una pregunta", "¿alguien me puede ayudar?" (pregunta qué necesita)
 *   7. other     → cualquier otra cosa: la responde el sitio o el modelo
 *
 * Preguntar POR un servicio ("¿qué es la asesoría legal?", "¿cuánto cobran por la asesoría legal?", "quiero
 * contratarlos para mi empresa") no es un asunto personal: lo responde el bot con el sitio. Solo es sensible cuando
 * habla de su propio caso.
 */
export type Intent = 'identity' | 'thanks' | 'human' | 'sensitive' | 'greeting' | 'help' | 'other';

export interface Analysis {
  intent: Intent;
  /** El mensaje empezó con un saludo ("hola, …"). */
  greeted: boolean;
  /** El saludo preguntaba cómo está ("¿cómo estás?", "¿qué más?", "¿cómo le va?"): se le contesta. */
  howAreYou?: boolean;
  /** El mensaje sin el saludo, el agradecimiento ni la muletilla del inicio (normalizado): el tema. */
  rest: string;
}

/* ---------- lo que va al inicio y no es el tema ---------- */

/** "¿Cómo estás?", "¿qué más?", "¿cómo le va?", "¿cómo amaneció?", "¿todo bien?": saludo que pregunta cómo está. */
const HOW_ARE_YOU = '(?:(?:y )?(?:tu|usted) (?:como estas|como esta|que tal)|que tal|que mas|que hubo|quiubo|como (?:estas|esta|estan|vas|va|te va|le va|les va|amaneciste|amanecio|amanecieron|ha estado|has estado|han estado)|todo bien)';
const HOW_RE = new RegExp(`^${HOW_ARE_YOU}\\b`);
// Es saludo solo si no sigue con el tema: "¿cómo está conformada la empresa?" o "¿qué tal es el servicio?" no lo son.
const GREETING_TAIL = '(?=$|\\s(?:usted|ustedes|todo|tu|como|amig[oa]|buenas|buenos|hola|muy|bien|que|quiero|quisiera|necesito|tengo|una|me|mi|soy|le|les|te|habla|con|yo|y|espero|aqui|buen|buena|cual|donde|cuanto|por favor|porfa|gracias|senor|senora|senorita|joven|doctor|doctora|por alla|por aca)\\b)';
const GREETING_LEAD = new RegExp(
  `^(buenas tardes|buenas noches|buenos dias|buen dia|${HOW_ARE_YOU}(?: (?:usted|ustedes|tu|todo|por alla|por aca))?${GREETING_TAIL}|buenas|hola+|holi|ola|hey|saludos|hi|hello|alo)\\b\\s*`,
);
const ACK_LEAD = /^(muchas gracias|mil gracias|muchisimas gracias|gracias|ok|okey|okay|oki|vale|perfecto|excelente|genial|listo|bueno|entendido|de acuerdo|super|chevere|ah ok|ahh|ah|aja|ya veo|entiendo|comprendo)\b\s*/;
const HELP_LEAD = /^(una pregunta|una consulta|una duda|tengo una (duda|pregunta|consulta|inquietud)|tengo (dudas|preguntas|una pregunta)|quisiera (preguntar|saber|consultar)|quiero (preguntar|saber|consultar)|me (puedes|puede|pueden|podrias|podria|podrian) (ayudar|colaborar|decir|informar|indicar)|necesito (ayuda|informacion|info)|quisiera informacion|quiero informacion|consulta|pregunta)\b\s*/;
/** Llamar la atención ("disculpe", "oiga", "señorita"): no es pedir ayuda; "gracias, señorita" es un cierre. */
const VOCATIVE_LEAD = /^(disculpa|disculpe|perdon|oye|oiga|mire|vea|senor|senora|senorita|joven|amigo|amiga|doctor|doctora|por favor|porfa|porfavor)\b\s*/;
/**
 * "Gracias linda", "ok mi reina", "hola bella", "gracias mi amor": un apelativo de cariño después del saludo o del
 * agradecimiento le habla al bot; no es el tema ni el nombre del visitante.
 */
const ENDEARMENT_LEAD = /^(mi |mis )?(linda|lindo|bella|bello|hermosa|hermoso|preciosa|precioso|princesa|reina|rey|cielo|cielito|corazon|carino|querida|querido|mami|papi|mamita|papito|mamacita|mija|mijo|mijita|mijito|nena|amor|vida|vecina|vecino|veci|parce|parcero|parcera|hermano|hermana|mana|mano|manito|sumerce|patron|patrona|bebe)\b\s*/;

function leads(n: string): { rest: string; greeted: boolean; acked: boolean; helped: boolean; called: boolean; howAreYou: boolean } {
  let rest = n;
  let greeted = false;
  let acked = false;
  let helped = false;
  let called = false;
  let howAreYou = false;
  for (let i = 0; i < 6; i++) {
    const before = rest;
    if (GREETING_LEAD.test(rest)) {
      if (HOW_RE.test(rest)) howAreYou = true;
      rest = rest.replace(GREETING_LEAD, '');
      greeted = true;
    }
    if (ACK_LEAD.test(rest)) { rest = rest.replace(ACK_LEAD, ''); acked = true; }
    if (HELP_LEAD.test(rest)) { rest = rest.replace(HELP_LEAD, ''); helped = true; }
    if (VOCATIVE_LEAD.test(rest)) { rest = rest.replace(VOCATIVE_LEAD, ''); called = true; }
    if ((acked || greeted) && ENDEARMENT_LEAD.test(rest)) { rest = rest.replace(ENDEARMENT_LEAD, ''); called = true; }
    if (rest === before) break;
  }
  return { rest: rest.trim(), greeted, acked, helped, called, howAreYou };
}

/* ---------- pedir un asesor ---------- */

/** Quién atiende: "asesor", "agente", "una persona", "alguien", "el gerente", "el encargado". */
const HUMAN_NOUNS = new Set(`asesor asesora asesores asesoras agente agentes operador operadora operadores humano humana persona
  alguien funcionario funcionaria representante ejecutivo ejecutiva gerente encargado encargada jefe jefa supervisor supervisora
  coordinador coordinadora director directora`.split(/\s+/));
/** El verbo del pedido ("quiero", "me pueden", "pásame", "que me llame…"). */
const REQUEST_TOKENS = new Set(`quiero quisiera necesito necesitaria deseo gustaria prefiero requiero exijo puedo podria podrian pueden
  puede puedes podrias posible dame deme denme regalame pasame pasenme paseme pasas pasan pasa pases pasarias comunicame comuniqueme
  comuniquenme comunicas comunican comunica comunicaran comunicaras comunicara comunicarias conectame conecteme conectenme conectas conectan
  conecta conectarias transfiereme transfierame transfieranme transfieres transfieren transfiere remiteme remitame remites remiten hablar
  hablarle comunicarme contactar contactarme chatear conversar atienda atiendan atendiera atendieran llame llamen llamara llamaran escriba
  escriban contacte contacten ayude ayuden oriente explique revise asesore dejan dejas deje`.split(/\s+/));
/** Lo que puede ir entre el verbo y quien atiende: "quiero hablar de nuevo con un asesor", "deseo ser atendido por otro asesor". */
const BETWEEN = new Set(`hablar comunicarme comunicar comunicarnos contactar contactarme chatear conversar pasar pasarme ser atendido atendida
  por con un una el la al a algun alguno alguna de sus los las nuevo nuevamente otra otro vez ya mismo directamente urgente urgentemente favor
  porfa porfavor ahora ahorita hoy que me nos tener contacto escribirle hablarle real verdad en vivo pronto rapido lo mas mi tu su este esta
  ese esa`.split(/\s+/));
const requestBefore = (tokens: string[], i: number) => {
  for (let j = i - 1, steps = 0; j >= 0 && steps < 8; j--, steps++) {
    if (REQUEST_TOKENS.has(tokens[j])) return true;
    if (!BETWEEN.has(tokens[j])) return false;
  }
  return false;
};
const HUMAN_PATTERNS = [
  /\b(me|nos) (pueden|puede|podrian|podria|podrias|puedes) (llamar|contactar|atender)\b/,
  /\b(pueden|puede|podrian|podria|podrias|puedes) (llamarme|contactarme|atenderme)\b/,
  // "Quiero que me llamen" sí; "¿es legal que me llamen tanto?" no (no lo pide).
  /\b(quiero|necesito|me gustaria|prefiero|quisiera|pueden|podrian|puede|podria|seria posible|por favor|porfa|favor|solicito|pido) (que )?(me|nos) (llamen|contacten|llame|contacte|llamaran|contactaran|llamara)\b|\b(llamenme|llameme|contactenme|contacteme)\b/,
  // "No quiero hablar con un bot": quiere una persona.
  /\bno (quiero|deseo|me gusta) (hablar|chatear|que me atienda|ser atendid[oa]) (con|por) (un |una |el |la |este |esta )?(bot|robot|maquina|contestadora|ia|inteligencia artificial|programa|chatbot|asistente virtual)\b/,
  /\b(hay|habra|tienen|tendran|esta|estan) (algun |alguna |un |una )?(asesor|asesora|agente|persona|humano|alguien) (disponible|disponibles|que me (atienda|ayude|pueda atender|pueda ayudar)|para (hablar|atenderme))\b/,
  /\b(asesor|asesora|agente|operador|operadora|humano|persona|funcionario|funcionaria|ejecutivo|ejecutiva) (que )?(me|nos) (puede|podria|pueda|pudiera|puedan|podrian) (atender|llamar|contactar|escribir|ayudar|explicar|orientar|asesorar)\b/,
  /\balguien (que )?(me|nos) (puede|podria|pueda|pudiera) (atender|llamar|contactar|escribir)\b|\balguien me (atiende|llama|contacta)\b/,
  /\b(atencion humana|atencion personalizada)\b/,
  // "Prefiero que me escriban por aquí", "quiero que me atiendan por el chat": quiere que lo atienda una persona por aquí.
  /\b(quiero|prefiero|preferiria|necesito|me gustaria|quisiera) que (me|nos) (escriban|escriba|atiendan|atienda|respondan|responda|contesten|conteste) (por aqui|por aca|por este (medio|chat)|por el chat|por chat|aqui|en este chat|en el chat)\b/,
  // "Me atiende un asesor, por favor": lo pide (sin el "por favor", "¿me atiende un asesor?" pregunta quién atiende).
  /\bme (atiende|atienda|puede atender) (un |una |el |la )?(asesor|asesora|agente|persona|humano)\b.*\b(por favor|porfa|porfavor|plis|porfis)\b/,
  // "El asesor me colgó, quiero hablar con otro", "otro asesor por favor, el anterior no me ayudó": pide otro asesor.
  /\b(quiero|necesito|quisiera|deseo|prefiero|me gustaria|pueden|puede|podrian) (hablar|que me atienda|ser atendid[oa]|que me pasen|pasarme) (con|por) otr[oa]\b(?! (cosa|tema|dia|momento|vez|pregunta|duda)\b)/,
  /^(otro asesor|otra asesora|otro agente|otra agente)\b(?! (me|nos|le|les)\b)/,
];
/**
 * Solo el pedido, sin más tema: "un asesor por favor", "otro asesor", "asesor de Offcorss", "asesor offcorss", "servicio
 * al cliente", "un asesor, no un robot".
 */
const HUMAN_ONLY = /^(?:(?:un|una|el|la|otro|otra|mi|con un|con una|con el|con la|con otro|con otra|con mi)\s+)?(?:(?:asesor|asesora|agente)(?: (?:de |para )?(?!(?:fue|es|era|esta|estuvo|muy|me|nos|no|nunca|tan|super|re|mal|malo|mala|pesimo|pesima|horrible|terrible|groser[oa]s?|grosera|maleducad[oa]s?|irrespetuos[oa]s?|grosero)\b)[a-z]{3,20}(?: (?!(?:groser[oa]s?|mal|malo|mala|pesimo|pesima|horrible|terrible|maleducad[oa]s?|irrespetuos[oa]s?)\b)[a-z]{3,20})?)?|(?:humano|persona|operador|operadora|representante|alguien|ejecutivo|ejecutiva|servicio al cliente|hablar con alguien)(?: (?:de|para) [a-z ]{2,30})?)(?: (?:por favor|porfa|porfavor|ya|urgente|ahora|ahora mismo|gracias|no (?:con )?(?:un |una |el |la |este |esta )?(?:robot|bot|maquina|chatbot|ia|contestadora|programa|asistente virtual)))*$/;
/**
 * "No quiero / no necesito un asesor", "no me pases con nadie", "sin asesor", "un asesor no, gracias". "El asesor no me
 * contestó" o "quiero un asesor humano, no un robot" no niegan al asesor: se quejan de uno o lo piden.
 */
export const ADVISOR_NEGATED =
  /\bno (quiero|necesito|deseo|requiero|me interesa|me gustaria|quisiera|hace falta|es necesario)\b(?:\s+\S+){0,3}?\s+(asesor|asesora|agente|persona|humano|alguien)\b|\bno (me )?(pases|pase|pasen|comuniques|comunique|comuniquen|transfieras|transfiera|conectes|conecte)\b|\b(sin|ningun|ninguna|ni) (un |una )?(asesor|asesora|agente|persona|humano)\b|\b(asesor|asesora|agente|humano) no(?=$| (gracias|por ahora|por el momento|todavia|aun|quiero|necesito|deseo|requiero|hace falta|es necesario|me interesa|solo|solamente|mejor|pero|entonces|tranquil[oa]|ahora|ahorita|por favor|porfa|porfavor|porfis|plis)\b)|\bno (quiero|necesito|deseo)( hablar| comunicarme)?( con)? nadie\b/;
/** "No quiero que me llamen", "no me llamen más": no quiere llamadas (puede igual querer que lo atiendan por aquí). */
const CALLS_NEGATED = /\bno (quiero|deseo|necesito|me gusta|me gustaria) que me (llamen|contacten|escriban|molesten)\b|\bno me (llamen|contacten|escriban|molesten) mas\b/;
const CALLS_NEGATED_G = new RegExp(CALLS_NEGATED.source, 'g');
/** No quiere un asesor o no quiere que lo llamen: no se le ofrece uno. */
export const HUMAN_NEGATED = new RegExp(`${ADVISOR_NEGATED.source}|${CALLS_NEGATED.source}`);
/** Pide un canal para comunicarse por su cuenta ("¿cuál es el teléfono para hablar con un asesor?"): se le da el dato. */
const CHANNEL_ASK = /\b(telefono|telefonos|numero|linea|correo|email|whatsapp|celular)\b[^?]{0,40}\bpara (hablar|comunicarme|contactar|llamar|escribir)|\ba que (numero|telefono|linea|correo) (llamo|marco|escribo)\b/;
/** Busca empleo COMO asesor o agente, o quiere a recursos humanos: no es pedir que lo atiendan. */
export const JOB_SENSE =
  /\b(trabajar (como|de|con ustedes|en)|trabajo (como|de) (asesor|asesora|agente|operador|operadora)|busco (trabajo|empleo)|buscando (trabajo|empleo)|empleo|vacante|vacantes|cargo de|puesto de|aplicar (a|al|para|como)|postular\w*|hoja de vida|oferta laboral|ofertas laborales|convocatoria)\b.*\b(asesor|asesora|asesores|agente|agentes|operador|operadora)\b|\b(asesor|asesora|asesores|agente|agentes|operador|operadora)\b.*\b(vacante|vacantes|empleo|cargo|puesto|hoja de vida|convocatoria)\b|\bser (un |una )?(asesor|asesora|agente|operador|operadora)\b|\b(recursos humanos|rrhh|talento humano)\b/;

export function wantsHuman(n: string, rest = n): boolean {
  if (ADVISOR_NEGATED.test(n) || JOB_SENSE.test(n) || CHANNEL_ASK.test(n)) return false;
  // "No quiero que me llamen" no es pedir que lo llamen; "no quiero que me llamen, quiero un asesor por aquí" sí pide uno.
  const t = n.replace(CALLS_NEGATED_G, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (HUMAN_ONLY.test(t === n ? rest : t) || HUMAN_PATTERNS.some((re) => re.test(t))) return true;
  const tokens = t.split(' ');
  return tokens.some((w, i) => HUMAN_NOUNS.has(w) && requestBefore(tokens, i));
}

/* ---------- identidad, cierre, saludo y ayuda ---------- */

/** "¿Me atiende un asesor? ¿Cuál es el correo?": con el signo, pregunta quién atiende aunque siga otra pregunta. */
const IDENTITY_ASKED = /(?:^|[¿?.!,;]\s*)¿?\s*me\s+(?:atiende|est[aá]\s+atendiendo)\s+(?:un\s+|una\s+)?(?:asesor|asesora|agente|operador|operadora|persona|humano)(?:\s+(?:real|de verdad|humano))?\s*\?/iu;
export const IDENTITY_RE =
  /\b(hablo|estoy hablando|estoy chateando) con alguien( real| de verdad)?\b|\bme (atiende|esta atendiendo) (un |una )?(asesor|asesora|agente|operador|operadora)( real| de verdad| humano)?$|\b(que|quien) (eres|sos|es este chat|me atiende|me esta atendiendo)\b|\bquien eres tu\b|\b(eres|es usted|usted es|sos|eres tu) (un |una )?(bot|robot|ia|inteligencia artificial|humano|humana|persona|ser humano|asistente|real|maquina|chatbot|programa)\b|\b(tu |usted )?(eres|es usted|usted es|sos) (un |una |el |la )?(asesor|asesora|agente|operador|operadora)\b|\bhay (una |alguna )?(persona|humano)( real)? (ahi|alli|al otro lado|del otro lado|atendiendo)\b|\bcomo te llamas\b|\bcon quien (hablo|estoy hablando)\b(?! (para|sobre|de))|\bque haces\b|\b(hablo|estoy hablando|estoy chateando|estoy) con (un |una )?(bot|robot|maquina|persona|humano|humana|ia|inteligencia artificial|asistente|programa|asesor|asesora)\b|\bme (atiende|esta atendiendo) (un |una )?(persona|humano|humana|robot|bot|maquina|asistente)\b|\bes un (bot|robot|chatbot)\b/;
/** Despedidas y agradecimientos: si el mensaje solo trae esto, es un cierre. Las frases largas van primero. */
const CLOSING = /\b(con eso (me basta|basta|es suficiente|tengo|quedo|estoy|me sirve)|(te|le|les) (escribo|escribire|aviso|avisare|cuento) (luego|despues|mas tarde|manana|en un rato|otro dia)|(luego|despues|mas tarde|manana|en un rato|otro dia) (te |le |les )?(escribo|escribire|aviso|avisare|cuento|hablamos|vuelvo|volvere|regreso)|ya tengo (lo que necesitaba|lo que necesito|lo que buscaba|lo que queria|la informacion|la info|todo|el dato|los datos)|eso me sirve|me fue (muy )?util|feliz fin de semana|buen fin de semana|feliz navidad|feliz ano nuevo|feliz ano|feliz domingo|buen resto de dia|feliz resto de dia|buena jornada|que tengas? (un |una )?(buen|buena|lindo|linda|excelente|feliz|bonito|bonita|gran) (dia|tarde|noche|fin de semana|jornada)|(que )?dios (lo|la|le|te|los|las|les) (bendiga|acompane|guarde)|disculpe la molestia|disculpa la molestia|perdon la molestia|perdone la molestia|que pena la molestia|que pena con usted|por la molestia|la molestia|entonces|por (su|tu|la|el|toda la|todo el|tanta) (tiempo|paciencia|atencion|ayuda|informacion|info|colaboracion|amabilidad|respuesta|respuestas|gestion|servicio|orientacion)|por atenderme|por ayudarme|por responder|por responderme|por contestar|por contestarme|por la paciencia|eres muy amable|es muy amable|muy atent[oa]s?|muy gentil|ya me quedo (todo )?claro( todo)?|me quedo (todo )?claro( todo)?|ya quedo (todo )?claro|quedo todo claro|ya entendi todo|entendido todo|lo tendre en cuenta|lo tengo en cuenta|lo voy a tener en cuenta|tendre en cuenta|ya (les|le|los|la|lo) (escribo|llamo|marco|contacto)|(les|le|los|la|lo) (escribo|llamo|marco|contacto) (luego|despues|ahora|ya|mas tarde)|(ya )?voy a (llamar|escribir|marcar)|ya (llamo|escribo|marco)|ya no necesito (nada )?mas|no necesito (nada )?mas|perfecto entonces|listo entonces|bueno entonces|ok entonces|hasta la proxima|nos hablamos|hablamos luego|luego hablamos|muy amables? de (su|tu) parte|muy amables?|que amables?|eso era todo|eso es todo por ahora|eso es todo|es todo por ahora|es todo|seria todo|eso seria todo|por ahora es todo|nada mas por ahora|hasta luego|hasta pronto|hasta manana|nos vemos|chao|chau|adios|bye|bendiciones|dios le pague|dios te pague|dios le bendiga|dios te bendiga|que este bien|que estes bien|que tengas? (un )?(buen|lindo|excelente|feliz|bonito) (dia|tarde|noche|fin de semana)|que le vaya bien|que te vaya bien|feliz dia|feliz tarde|feliz noche|buen dia|buena tarde|buena noche|igualmente|a usted|a ti|con gusto|de nada|no gracias|no mas|nada mas|todo bien|todo claro|muy bien|que bien|excelente servicio|buen servicio|muchisimas gracias|muchas gracias|mil gracias|gracias|le agradezco|te agradezco|les agradezco|agradezco|agradecid[oa]|ya entendi|entendi|ya quedo claro|quedo claro|ya no necesito nada mas|ya no necesito nada|no necesito nada mas|estoy de acuerdo|de acuerdo|ya me acorde|ya me acuerdo|quedo atent[oa]|quedo pendiente|quedamos asi|quedo a la espera|estare atent[oa]|aqui espero|espero|listo|ok|okey|vale|perfecto|bueno|entendido|mucho|por todo|por la informacion|por la info|por la ayuda|por su ayuda|por tu ayuda|su ayuda|tu ayuda|la ayuda|por la atencion|por su atencion)\b/g;
const isClosing = (rest: string) => !!rest && rest.replace(CLOSING, ' ').trim() === '' && rest.replace(/\s/g, '') !== '';
const PRESENCE_RE = /^(hay alguien|alguien|estas ahi|esta ahi|estan ahi|sigues ahi|sigue ahi|me escuchas|me lees|me copias|hola)( ahi| alli| por ahi)?( que me (atienda|ayude))?$/;
const HELP_ONLY = /^(hablemos|ayuda|ayudame|ayudeme|ayudenme|informacion|info|necesito ayuda|quiero informacion|quiero hablar|quisiera hablar|me ayudas|me ayudan|me puedes ayudar|me pueden ayudar|tengo una pregunta|una pregunta|una duda|una consulta|alguien (me|nos) (puede|podria|pueda) ayudar|alguien me ayuda|alguien que me ayude|me puede ayudar alguien)( por favor| porfa)?$/;
/** "Quiero preguntar algo", "¿te puedo hacer una pregunta?", "tengo otra duda": anuncia una pregunta que aún no hace. */
const ANNOUNCE_RE = /^(?:(?:hola|buenas|buenos dias|buenas tardes|buenas noches|disculpa|disculpe|perdon|oye|oiga|mira|mire|senor|senora|senorita|ok|listo|bueno|gracias|muchas gracias|mil gracias|gracias por atenderme|gracias por la atencion|gracias por responder|gracias por responderme|antes|antes de eso|antes de todo|primero|pero|y)\s+)*(?:(?:quiero|quisiera|queria|necesito|me gustaria|deseo|puedo|te puedo|le puedo|les puedo|podria|te podria|le podria)\s+(?:preguntar(?:te|le|les)?|consultar(?:te|le|les)?)|(?:quiero|quisiera|queria|necesito|me gustaria|deseo)\s+saber|(?:quiero|quisiera|queria|me gustaria|deseo|necesito|puedo|te puedo|le puedo|les puedo|podria|te podria|le podria)\s+hacer(?:te|le|les)?\s+(?:una|otra|unas|dos)\s+(?:pregunta|preguntas|consulta|consultas)|(?:tengo|tenia)\s+(?:una|otra|unas|dos|mas)\s+(?:pregunta|preguntas|duda|dudas|consulta|consultas|inquietud|inquietudes)|(?:una|otra)\s+(?:pregunta|consulta|duda|cosa|cosita))(?:\s+(?:algo|otra cosa|una cosa|una cosita|algo mas|algo rapido|rapido|rapidito|mas))?(?:\s+(?:primero|antes|rapido|rapidito|un momento))?(?:\s+(?:por favor|porfa|porfis|plis))?$/;
export const announcesQuestion = (message: string) => ANNOUNCE_RE.test(normalize(message));

/* ---------- asunto personal ---------- */

/** Siempre es un asunto personal del visitante. */
const PERSONAL_RE =
  /\b(paz y salvo|acuerdos? de pago|hacer un acuerdo|llegar a un acuerdo|negociar (mi|la|una|el) (deuda|obligacion|credito|saldo)|cuanto debo|lo que debo|mi deuda|mis deudas|mi saldo|mi credito|mis creditos|mi obligacion|mis obligaciones|mi cuenta|mi caso|mi proceso|mi pago|mis pagos|mi cobro|mi factura|mis facturas|mi cuota|mis cuotas|mi mora|me (estan )?(cobrando|llamando|escribiendo|acosando|molestando)|me cobran|me llaman|me llamaron|me escriben|me escribieron|me escribio|me contactaron|me contacto (un|una|el|la|alguien|de|desde)|me contactan|me mandaron|me enviaron|me notificaron|me (llego|llegaron)|me demandaron|me embargaron|estoy reportad[oa]|me reportaron|reportado en|datacredito|centrales de riesgo|refinanciar|refinanciacion|abonar|quiero pagar|necesito pagar|puedo pagar|como pago|donde pago|link de pago|medios de pago|formas de pago|pagar (mi|la|el|lo)|ya pague|ya cancele|ya pagamos|no he podido pagar|no puedo pagar|estoy en mora|tengo mora|quien me (llamo|escribio|contacto|esta llamando|esta escribiendo)|por que me (llaman|llamaron|escriben|escribieron|contactan|contactaron|cobran|estan cobrando|estan llamando|buscan))\b/;
/** Temas que solo son personales si el visitante habla de sí mismo ("tengo una deuda", "necesito un abogado"). */
const TOPIC_RE =
  /\b(pago|pagos|pagar|abono|deuda|deudas|saldo|saldos|negociar|negociacion|juridic[oa]s?|demanda|demandas|embargo|embargos|abogado|abogados|legal|legales|cobro|cobros|credito|creditos|obligacion|obligaciones|mora|cuota|cuotas|intereses|cobraron|descuentan|descontaron)\b/;
const SELF_RE = /\b(mi|mis|me|tengo|tenia|debo|debia|quiero|quisiera|necesito|requiero|estoy)\b/;
/**
 * Lo que cuenta de su caso aunque no nombre la deuda ("me cobraron dos veces", "no tengo la plata", "soy pensionada y me
 * descuentan de la mesada", "soy codeudor de mi hermano", "es para mi mamá"): para el asesor es el tema de la consulta.
 */
const CASE_RE = /\b(cobraron|cobran|cobrando|plata|dinero|cuota|cuotas|interes|intereses|descuento|descuentos|descuentan|descontaron|mesada|pension|pensionad[oa]|desplazad[oa]|victima|desemplead[oa]|no tengo (trabajo|empleo|plata|dinero|como pagar|con que pagar)|sin (trabajo|empleo)|cabeza de hogar|codeudor[a]?|deudor[a]? solidari[oa]|fiador[a]?|a nombre de|para mi (mama|papa|hijo|hija|esposo|esposa|hermano|hermana|familiar)|de mi (mama|papa|hijo|hija|esposo|esposa|hermano|hermana)|reportad[oa]|embargad[oa]|libranza|factura|facturas|me (llego|llegaron) (un|una|el|la|unos|unas)|llamadas)\b/;
/** "Me llamo Pedro, ¿tienen abogados?": la presentación no hace que la pregunta hable de él. */
const SELF_INTRO_RE = /\b(?:me llamo|mi nombre (?:completo )?es)(?: (?!(?:y|e|tengo|tenia|quiero|quisiera|necesito|debo|mi|mis|me|para|con|de|del|que|pero|porque|estoy|soy|tienen|tiene|hay|cual|como|donde|cuanto|cuando|la|el|los|las|un|una)\b)[a-z]+){1,4}/g;
/** "¿Cuál es el teléfono para hacer un acuerdo de pago?": pide un canal, no cuenta su caso. */
const CONTACT_FOR = /(?<!\bmi )\b(telefono|telefonos|linea|lineas|correo|email|mail|whatsapp|celular|direccion|numero(?! de (la |mi |su |el )?(obligacion|cuenta|factura|referencia|credito|cedula|documento|radicado|contrato|pedido|guia|deuda|deudas|prestamo|tarjeta|pago|saldo)))\b(?: \S+){0,3}? para\b|\ba (que|cual) (numero|telefono|linea|correo|whatsapp) (llamo|marco|escribo|me comunico)\b/;
/** Pedir información de la empresa o contratar un servicio: no es un asunto personal aunque nombre el tema. */
const INFO_RE =
  /\b(informacion|info|que es|que son|en que consiste|como funciona|ofrecen|ofrece|brindan|prestan|manejan|hacen|servicio|servicios|que hacen|saber (mas|sobre|de|si)|contratar|contratarlos|cotizar|cotizacion|mi empresa|nuestra empresa|para empresas|mi negocio|nuestros clientes|mis clientes|duda sobre|pregunta sobre|consulta sobre)\b/;
/** "¿Cuánto cobran / cuánto cuesta la asesoría legal?": pregunta el precio de un servicio, no por su deuda. */
const PRICE_INQUIRY =
  /\bcuanto (me |nos |les |le )?(cobran|cobrarian|cobraria|cobra|cuesta|cuestan|vale|valen|sale|saldria|seria)\b(?=.*\b(servicio|servicios|asesoria|asesorias|consulta|call center|cobranza|recuperacion|plan|paquete|gestion|tramite|honorarios|abogado|abogados|proceso juridico|contratar|contratarlos|empresa)\b)/;
/** Habla de un caso de cobranza (una deuda, un pago, un proceso), aunque no diga que es suyo ("es por una deuda con Flamingo"). `n` normalizado. */
export const mentionsCase = (n: string): boolean => PERSONAL_RE.test(n) || TOPIC_RE.test(n) || CASE_RE.test(n);
/** `n` ya normalizado. */
export const isSensitive = (n: string): boolean => {
  const t = n.replace(PRICE_INQUIRY, ' ').replace(SELF_INTRO_RE, ' ');
  // Pide el teléfono o el correo para algo ("…para hacer un acuerdo de pago"): se le da el canal (y se le ofrece un asesor).
  if (CONTACT_FOR.test(t) && /\b(cual|cuales|que|dame|deme|me das|me da|me regalas|me regala|me pasas|necesito|quisiera|a que|donde)\b/.test(t)) return false;
  return PERSONAL_RE.test(t) || (TOPIC_RE.test(t) && SELF_RE.test(t) && !INFO_RE.test(t));
};

/* ---------- clasificación ---------- */

export function analyze(message: string): Analysis {
  const n = normalize(message);
  // Sin letras ni números: "👍" es un acuse; "?" o "??" es que no entendió o espera respuesta.
  if (!n) return { intent: /[?¿]/.test(message) ? 'help' : 'thanks', greeted: false, rest: '' };
  const { rest, greeted, acked, helped, called, howAreYou } = leads(n);
  // "Quiero preguntar algo": todavía no pregunta; se le invita a hacerlo.
  if (ANNOUNCE_RE.test(n)) return { intent: 'help', greeted, howAreYou, rest: '' };
  // "Gracias, buenas noches" o "gracias, señorita" es un cierre; "hola" solo, un saludo; "disculpe" solo, que necesita algo.
  if (!rest) return { intent: helped ? 'help' : acked ? 'thanks' : greeted ? 'greeting' : called ? 'help' : 'other', greeted, howAreYou, rest };
  const intent: Intent = wantsHuman(n, rest) ? 'human'
    : IDENTITY_RE.test(n) || IDENTITY_ASKED.test(message) ? 'identity'
      : isClosing(rest) ? 'thanks'
        : isSensitive(n) ? 'sensitive'
          : PRESENCE_RE.test(rest) ? 'greeting'
            : HELP_ONLY.test(rest) ? 'help'
              : 'other';
  return { intent, greeted, howAreYou, rest };
}

export function classify(message: string): Intent {
  return analyze(message).intent;
}

/**
 * Texto para buscar en el sitio: sin saludo, sin muletillas y sin la negación de un asesor
 * ("no necesito asesor, solo una pregunta: ¿qué es la asesoría legal?" → "que es la asesoria legal").
 * "No me acuerdo" no es "acuerdos de pago".
 */
export function topicText(message: string): string {
  return analyze(message).rest
    .replace(/\bno (quiero|necesito|deseo|requiero|me interesa)( hablar)?( con)?( un| una| el| la| ningun)? (asesor|asesora|agente|persona|humano)\b/g, ' ')
    .replace(/\bno me (pases|pase|pasen|comuniques|comunique) con (ningun |un |el |nadie)?(asesor|asesora|agente|humano)?\b/g, ' ')
    .replace(/\bno (quiero|necesito|deseo)( hablar| comunicarme)?( con)? nadie\b|\bno (quiero|deseo|necesito) que me (llamen|contacten|escriban)( mas)?\b/g, ' ')
    .replace(/\b(ya )?(no )?me (acuerdo|acorde)( de| del)?\b|\bno recuerdo\b|\bse me olvido\b/g, ' ')
    .replace(/\b(sin asesor|solo|solamente|nada mas|una pregunta|una duda|una consulta)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- respuestas a lo que preguntó el bot ---------- */

const COURTESY_RE = /\b(muchas gracias|mil gracias|gracias|por favor|porfa|porfavor|porfis|pues|entonces|senor|senora|senorita|amigo|amiga|de verdad|la verdad|en realidad|igual|pero|mira|mire|oye|oiga|vea)\b/g;
// Las frases de varias palabras van primero: en una alternancia gana la primera que coincide, no la más larga.
const YES_RE = /\b(claro que si|me parece perfecto|me parece bien|me parece|esta bien|me gustaria|seria bueno|seria genial|me encantaria|por supuesto|estoy de acuerdo|de acuerdo|de una|con mucho gusto|con gusto|con uno|con una|con el|con ella|si|sii+|sip|sisas|simon|claro|dale|dele|ok|okey|okay|oki|vale|bueno|listo|perfecto|obvio|hagale|hagamosle|afirmativo|quiero|correcto|exacto|venga|pasame|pasenme|paseme|comunicame|comuniqueme|comuniquenme|conectame|conecteme|conectenme|transfiereme|transfierame)\b/g;
/** Un "ok" o un "listo" seguidos de "gracias" cierran la conversación; un "sí" o un "dale" aceptan. */
const WEAK_YES_RE = /\b(ok|okey|okay|oki|vale|bueno|listo|perfecto|esta bien)\b/g;
const NO_RE = /\b(no por ahora|por ahora no|no por el momento|por el momento no|ahora no puedo|ahorita no puedo|no puedo ahora|no puedo ahorita|ahora no|ahorita no|todavia no|aun no|tal vez despues|tal vez luego|en otro momento|otro dia|mas tarde|mejor despues|mejor luego|no es necesario|no hace falta|asi esta bien|estoy bien|mejor no|no quiero|no puedo|nada mas|no mas|eso era todo|eso es todo|nada|despues|luego|tranquilo|tranquila|no+|nop|nope|nel)\b/g;
const ENOUGH_RE = /\b(eso era todo|eso es todo|nada mas|no mas|es todo|nada)\b/;
const PLEASE_ONLY = /^(si )?(por favor|porfa|porfavor|porfis|please|plis)( si)?$/;
const only = (s: string, re: RegExp) => s.replace(re, ' ').trim() === '';
/** El mensaje es solo un sí o un no con cortesías ("nel, gracias", "sí señor", "no, muchas gracias"): no trae otro dato. */
export function isPureYesNo(message: string): boolean {
  const bare = normalize(message).replace(COURTESY_RE, ' ').replace(/\s+/g, ' ').trim();
  return !!bare && (only(bare, NO_RE) || only(bare, YES_RE));
}

/** Además de negar al asesor, el mensaje trae otro tema ("no quiero asesor, ¿qué servicios ofrecen?"). */
function hasOtherTopic(message: string): boolean {
  const t = topicText(message).replace(COURTESY_RE, ' ').replace(NO_RE, ' ').replace(/\s+/g, ' ').trim();
  return t.split(' ').filter((w) => w.length >= 3).length > 0;
}

/**
 * Respuesta a una pregunta de sí o no del bot ("¿Quieres que te comunique con un asesor?").
 * Solo cuenta si el mensaje es la respuesta: "ok, ¿y el teléfono?" o "no entiendo, ¿qué es…?" son otra pregunta (null).
 */
export function yesNo(message: string): 'yes' | 'no' | 'closing' | null {
  const n = normalize(message);
  if (!n) return null;
  // "No quiero asesor, gracias" es un no; "no quiero asesor, ¿qué servicios tienen?" trae otra pregunta.
  if (HUMAN_NEGATED.test(n)) return hasOtherTopic(message) ? null : 'no';
  if (PLEASE_ONLY.test(n)) return 'yes'; // "por favor", "porfa": sí, por favor
  // "Estoy de acuerdo" acepta (no es un cierre).
  if (/^(si )?(estoy de acuerdo|de acuerdo)( (con eso|entonces|gracias|por favor))?$/.test(n)) return 'yes';
  const thanked = /\b(gracias|agradezco)\b/.test(n);
  const bare = n.replace(COURTESY_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!bare) return 'closing'; // "gracias", "muchas gracias"
  if (only(bare, NO_RE)) return ENOUGH_RE.test(bare) ? 'closing' : 'no';
  if (only(bare, YES_RE)) return thanked && only(bare, WEAK_YES_RE) ? 'closing' : 'yes';
  // Un "sí" explícito seguido de algo más ("sí, soy Juan Pérez", "sí, ¿cuánto se demora?") sigue siendo un sí.
  if (/^(si|sii+|sip|sisas|claro que si|por supuesto|obvio que si)\b/.test(n) && !/\bno\b/.test(n)) return 'yes';
  if (isClosing(bare)) return 'closing';
  return null;
}

/** "No quiero asesor, gracias": niega el asesor y no pregunta nada más. */
export const negatesAdvisorOnly = (message: string) => HUMAN_NEGATED.test(normalize(message)) && !hasOtherTopic(message);

/** El sí del inicio aunque siga con sus datos ("claro, me llamo Pedro", "dale, Pedro Gómez", "listo, con los de Flamingo"). */
const ACCEPT_LEAD = /^(si+|sip|sisas|simon(?=$| (gracias|pues|claro|por favor|porfa|hagale|de una))|claro|dale|dele|listo|ok|okey|okay|bueno|de una|hagale|hagamosle|perfecto|de acuerdo|por favor|porfa|porfavor|vale|venga|obvio|por supuesto|me parece bien|esta bien|con gusto|con mucho gusto|correcto|exacto)\b/;
/** El sí del final ("Pedro, sí", "me llamo Pedro y sí quiero", "Juan Pérez, por favor"). */
const ACCEPT_TAIL = /\b(si|sii+|si quiero|si por favor|si claro|claro que si|si senor|si senora|por favor|porfa|porfavor)$/;
/**
 * Acepta la oferta de un asesor, aunque el mensaje siga con su nombre o sus datos: "claro, me llamo Pedro Pérez", "dale,
 * soy Pedro Gómez", "Pedro, sí", "sí, Juan Pérez 1020304050". Un "ok, gracias" cierra; "no gracias, soy Pedro" no acepta.
 */
export function acceptsOffer(message: string): boolean {
  const n = normalize(message);
  if (!n || /\bno\b/.test(n) || HUMAN_NEGATED.test(n)) return false;
  const answer = yesNo(message);
  if (answer === 'closing' || answer === 'no') return false;
  return answer === 'yes' || ACCEPT_LEAD.test(n) || ACCEPT_TAIL.test(n);
}

/** Lo que sigue a un "sí" ("sí, ¿cuál es el correo?", "sí, pero antes dime dónde quedan"): otra pregunta. */
export function afterYes(message: string): string {
  // "Ok, estoy de acuerdo", "sí, de acuerdo con eso", "listo, me parece bien": todo eso es el sí.
  let t = normalize(message);
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/^(claro que si|por supuesto|de una|estoy de acuerdo|de acuerdo|me parece (bien|perfecto|excelente|genial)|esta bien|si|sii+|sip|sisas|simon|dele|claro|dale|ok|okey|listo|bueno|perfecto|vale|obvio)\b\s*/, '')
      .replace(/^(con eso|con mucho gusto|con gusto|entonces|gracias|muchas gracias|por favor|porfa)\b\s*/, '');
    if (t === before) break;
  }
  return t
    .replace(COURTESY_RE, ' ')
    .replace(/^\s*(pero|y|entonces|antes|primero|tambien|ademas)\b/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- ¿es una pregunta? ---------- */

/** Empieza como pregunta ("cuál es…", "tienen…", "¿es posible…?"); "qué pena" o "qué bien" no lo son. */
const ASK_START = /^(que(?! (pena|bien|chevere|bueno|buena|amable|lindo|linda|rico|mal|horror|tristeza|susto|alegria|gusto|pesar|vaina|bacano|bonito|bonita|maravilla|dicha|bendicion|lastima|verguenza|rabia|miedo|nota|chimba|tengas|tenga|tengan|este|estes|esten|le vaya|te vaya|les vaya|dios|pase|pases|pasen|descanse|descanses)\b)|cual|cuales|como(?! ((te|le|les) )?(dije|decia|comente|conte|explique|he dicho|habia dicho|mencione)\b| (usted|tu|ustedes) (diga|digas|digan|quiera|quieras|quieran|prefiera|prefieras)\b| (quiera|quieras|quieran|guste|gustes|prefiera|prefieras|sea)\b)|donde(?! (me|usted|tu) (digas|diga|indiques|indique)\b)|adonde|cuando(?! (puedan|pueda|puedas|quiera|quieras|quieran|gusten|guste|gustes|usted|tu|me digas|me diga|sea|antes|tenga|tengan)\b)|cuanto(?! antes\b)|cuantos|cuanta|cuantas|quien|quienes|por que|porque|para que|a que|en que|de que|con quien|desde cuando|hasta cuando|tienen|tiene|hay|hacen|atienden|atiende|trabajan|manejan|ofrecen|cobran|aceptan|reciben|venden|prestan|puedo|pueden|puede|podria|podrian|se puede|me pueden|me puede|me podria|me podrian|me puedes|me podrias|saben|sabe|sabes|ustedes|es posible|es seguro|es legal|es cierto|es verdad|es necesario|es obligatorio|son seguros|sera que)\b/;
/** Pide un dato aunque no lleve signo ("dime el teléfono", "me das el correo", "quiero saber dónde quedan"); "dime" solo no. */
const ASK_REQUEST = /\b(dime|digame|cuentame|cuenteme|explicame|expliqueme|informame|informeme|indicame|indiqueme|me (dices|dice|dicen|regalas|regala|regalan|das|da|dan|indicas|indica|informas|informa|pasas|pasa|envias|envia|explicas|explica|cuentas|cuenta|confirmas|confirma)|quisiera saber|quiero saber|necesito saber|me gustaria saber|quiero preguntar|quisiera preguntar|quiero consultar|quisiera consultar|(saber|preguntar|consultar|conocer) (donde|que|cual|cuales|como|cuando|cuanto|si))\s+\S|\b(necesito|quisiera|quiero) (el|la|los|las|su|sus) (telefono|telefonos|numero|correo|correos|email|direccion|direcciones|horario|horarios|whatsapp|link|pagina|informacion|ubicacion|sedes)\b/;

/**
 * Es una pregunta o un pedido de información: lleva signo, pide un dato ("dime el teléfono") o alguna parte de la
 * frase empieza como pregunta ("1020304050 y cuál es el correo", "no, mejor dime el teléfono"). "La línea no contesta",
 * "es de Dupree", "quiero poner una queja" o "Juan Pérez" no lo son.
 */
/** "Dame el correo", "regálame el teléfono", "pásame la dirección": pide un dato en imperativo ("pásame con un asesor" no). */
const ASK_IMPERATIVE = /\b(dame|deme|denme|regalame|regaleme|regalenme|pasame|paseme|pasenme|mandame|mandeme|enviame|envieme|facilitame|facliteme|comparteme|compartame|indicame|indiqueme|escribeme|anotame) (el|la|los|las|un|una|su|sus|tu|tus) (telefono|telefonos|numero|correo|correos|email|mail|direccion|direcciones|horario|horarios|whatsapp|link|enlace|pagina|informacion|info|ubicacion|sede|sedes|nit|celular|linea|lineas|contacto|precio|precios|tarifa|tarifas|costo|costos|valor|requisitos|servicios)\b/;
/** Un número o la palabra del documento al inicio de una parte ("1020304050 dónde quedan"): no cambia lo que pregunta. */
const LEADING_DATA = /^(?:(?:\d+|cc|c c|cedula|documento|nit|pasaporte)\s+)+/;

/**
 * Es una pregunta o un pedido de información: lleva signo, pide un dato ("dime el teléfono", "dame el correo") o alguna
 * parte de la frase empieza como pregunta: tras una coma ("Juan Pérez, cuál es el horario"), tras un conector
 * ("1020304050 y cuál es el correo", "no, mejor dime el teléfono") o tras los datos ("1020304050 dónde quedan").
 * "La línea no contesta", "es de Dupree", "quiero poner una queja" o "Juan Pérez" no lo son.
 */
export function looksLikeQuestion(message: string, rest = analyze(message).rest): boolean {
  if (/[?¿]/.test(message)) return true;
  const n = normalize(message);
  if (ASK_REQUEST.test(n) || ASK_IMPERATIVE.test(n)) return true;
  const parts = [rest, ...message.split(/[,;:.!\n]+/).map(normalize), ...n.split(/\s(?:y|e|pero|mejor|entonces|o sea|osea|ademas|tambien)\s/)];
  return parts.some((c) => ASK_START.test(c.trim().replace(LEADING_DATA, '')));
}

/* ---------- cancelar, negarse, esperar ---------- */

/** "Ya me atendieron", "ya me ayudaron": ya no necesita al asesor ("¿ya me atendieron?" pregunta por la espera). */
const ALREADY_HELPED = /\bya (me|lo|la) (atendieron|resolvieron|solucionaron|ayudaron)\b/;
/** Ya no quiere pasar con un asesor. */
const CANCEL_ANY = [
  /\b(ya no|no) (quiero|necesito|deseo|requiero)( hablar| esperar| ser atendid[oa]| que me atiendan)?( con)?( el| un| al| la| una| ningun| otro)? (asesor|asesora|agente|persona|humano)\b/,
  /\b(ya no|no) (quiero|necesito|deseo)( hablar| comunicarme)?( con)? nadie\b/,
  /\bcancel\w* (la |mi |esta |esa )?(solicitud|espera|atencion|chat|conversacion|transferencia)\b/,
  ALREADY_HELPED,
  // "Asesor no, por favor", "un asesor no, gracias": no lo quiere.
  /\b(asesor|asesora|agente|humano) no(?=$| (gracias|por ahora|por el momento|todavia|aun|por favor|porfa|porfavor|porfis|plis|mejor|tranquil[oa]|ahora|ahorita)\b)/,
  /\bya (lo |la )?(resolvi|solucione)\b/,
  /\bya no (es necesario|hace falta|lo necesito|la necesito|quiero esperar|voy a esperar|puedo esperar|tengo tiempo)\b/,
  /\bno (quiero|puedo|voy a) esperar\b/,
  // "Ya no me interesa"; "no me interesa dar mis datos" es negarse a darlos, no cancelar.
  /\bya no me interesa\b(?! (dar|darte|darle|compartir|decir|decirte|darlos))/,
  // "Me voy, gracias", "ya me voy": se despide. "Me voy un momento, ya vuelvo", "me voy de viaje" o "me voy a almorzar" no.
  /\b(ya )?me voy\b(?! (a|al|un|una|de|del|por|para|en|y|pero|mientras|rapido|rapidito)\b)/,
];
/**
 * Desistir sin nombrar al asesor ("no me interesa", "no quiero nada"): en la cola, si el bot acaba de preguntar "¿te
 * ayudo con algo más?", le responde a esa pregunta. "No quiero nada más" nunca cancela: no quiere nada más DEL BOT.
 */
const CANCEL_SOFT_ANY = [
  /\bno me interesa\b(?! (dar|darte|darle|compartir|decir|decirte|darlos))/,
  /\b(ya no|no) (quiero|necesito) nada\b(?! (mas|de mas|que)\b)/,
];
/** Dice que sigue esperando ("aquí espero", "ya vuelvo"): no cancela aunque diga "no quiero nada" o "me voy". */
const STAYING = /\b(aqui (espero|sigo|estoy)|espero (al|el|a la|la|a el) (asesor|asesora)|sigo esperando|yo espero|ya vuelvo|ya regreso|ya vengo|vuelvo (ya|en|ahorita|mas tarde|luego))\b/;
/** "Cancelar", "cancela": la orden de cancelar. "Ya cancelé" en cobranza es "ya pagué" (no cancela nada). */
const CANCEL_HARD = /\b(cancela|cancelar|cancelalo|cancelala|cancelen|anula|anular|anulalo)\b/g;
/** Desistir sin nombrar la solicitud: en la cola cuenta solo si el bot no acaba de preguntar algo ("¿te ayudo con algo más?"). */
const CANCEL_SOFT = /\b(ya no quiero|ya no necesito|ya no es necesario|ya no hace falta|ya no lo necesito|ya no|mejor no|olvidalo|olvidelo|olvida eso|olvidate|dejalo asi|dejemoslo asi|dejelo asi|dejalo|dejelo|no importa)\b/g;
/** Despedirse mientras se le piden los datos. */
const CANCEL_FAREWELL = /\b(ya me ayudaste|ya me ayudo|ya me resolviste|ya me resolvio|chao|chau|adios|bye|hasta luego|hasta pronto|nos vemos)\b/g;
const CANCEL_WORDS_COLLECTING = /\b(no pero gracias|no gracias igual|no gracias|no quiero|no te preocupes|no se preocupe|mejor despues|mejor luego|mejor otro dia|en otro momento|otro dia|despues|luego|mas tarde)\b/g;
/** Desistir al inicio y preguntar otra cosa: "olvídalo, ¿cuál es el correo?", "ya no necesito el asesor, ¿me das el correo?". */
const CANCEL_LEAD = /^\s*(?<phrase>olv[ií]d[ae]lo|olvida eso|d[eé]j[ae]lo(?: as[ií])?|mejor no|no gracias|ya no(?: lo)? (?:quiero|necesito)(?: el| un| al)?(?: asesor| asesora)?|ya no|cancela(?:r|lo)?(?: la solicitud)?|ya no es necesario|ya no hace falta|no (?:quiero|necesito)(?: el| un| al)? (?:asesor|asesora))(?:\s*[,.;:!¡¿-]+\s*|\s+(?:y|e|pero|mejor|solo|solamente)\s+)(?<rest>\S.*)$/iu;
/** "No, mejor dime el teléfono": no quiere seguir con el asesor y pide otra cosa. */
const NO_BETTER = /^\s*no\s*[,.!]*\s*(?:gracias\s*[,.!]*\s*)?mejor\s+(?<rest>\S.*)$/iu;
/** "Después te escribo", "mañana escribo", "luego miro": lo deja para otro momento. */
export const POSTPONE_WHEN = /\b(despues|luego|manana|mas tarde|otro dia|en otro momento|en un rato|ahora no puedo|ahorita no puedo|no puedo ahora)\b/;
const POSTPONE_ACT = /\b(escribo|escribire|escribimos|miro|mirare|reviso|revisare|vuelvo|volvere|regreso|contacto|llamo|aviso|hablamos|seguimos|continuamos)\b/;
const LEFTOVER = /\b(entonces|mejor|asi|bueno|ok|listo|ya|no|si|pues|y)\b/g;

export interface CancelResult {
  cancel: boolean;
  /** Además preguntó otra cosa en el mismo mensaje: se cancela y se responde. */
  question: boolean;
}

/** Lo que queda junto al desistimiento pregunta algo ("ya no me interesa, ¿cuál es el correo?"). */
const asksToo = (message: string, rest: string) => {
  const r = normalize(rest).replace(COURTESY_RE, ' ').replace(LEFTOVER, ' ').replace(/\s+/g, ' ').trim();
  if (!r) return false;
  return /[?¿]/.test(message) ? r.split(' ').some((w) => w.length >= 3) : looksLikeQuestion(rest, r) && r.split(' ').length >= 2;
};

/**
 * Ya no quiere pasar con un asesor. `waiting`: está en la cola; `answering`: el último mensaje del bot fue una pregunta
 * ("¿te ayudo con algo más?"), así que un "mejor no" o "déjalo" responde a ella y no suelta la solicitud. `question`:
 * además preguntó otra cosa ("no quiero esperar, ¿cuál es el correo?"), que se responde al cancelar.
 */
export function cancelOf(message: string, opts: { waiting?: boolean; answering?: boolean; hasData?: boolean } = {}): CancelResult {
  const n = normalize(message);
  if (!n) return { cancel: false, question: false };
  const staying = STAYING.test(n);
  // Mientras se le piden los datos, "no quiero nada más" sí deja la solicitud (no va a darlos).
  const collectingOnly = opts.waiting ? [] : [/\b(ya no|no) (quiero|necesito) nada mas\b/];
  for (const re of [...CANCEL_ANY, ...(opts.waiting && opts.answering ? [] : CANCEL_SOFT_ANY), ...collectingOnly]) {
    const m = n.match(re);
    if (!m) continue;
    if (staying && (CANCEL_SOFT_ANY.includes(re) || /me voy/.test(m[0]))) continue;
    // "¿Ya me atendieron?", "no sé si ya me atendieron": pregunta por la espera, no cancela.
    if (re === ALREADY_HELPED && (/[?¿]/.test(message) || /\bno se si\b|\bo no$/.test(n))) continue;
    return { cancel: true, question: asksToo(message, `${n.slice(0, m.index)} ${n.slice(m.index! + m[0].length)}`) };
  }
  const lead = message.match(CANCEL_LEAD)?.groups;
  if (lead && (/[?¿]/.test(lead.rest) || normalize(lead.rest).split(' ').length >= 3)) {
    const phrase = normalize(lead.phrase);
    const strong = /^(cancela|ya no (lo )?(quiero|necesito)|no (quiero|necesito))/.test(phrase);
    // En la cola, "no gracias" responde a "¿te ayudo con algo más?"; "olvídalo" solo cancela si el bot no acaba de preguntar.
    const soft = phrase !== 'no gracias' && !opts.answering;
    // "No gracias, ya me ayudaste" u "olvídalo, ya pagué la deuda" no preguntan nada: solo cancelan.
    if (strong || !opts.waiting || soft) return { cancel: true, question: asksToo(message, lead.rest) };
  }
  const better = message.match(NO_BETTER)?.groups;
  if (better && !(opts.waiting && opts.answering) && asksToo(message, better.rest)) return { cancel: true, question: true };
  // Mientras se le piden los datos, "después te escribo", "no gracias, luego escribo" o "déjalo así, después miro"
  // aplazan: se suelta la solicitud (cuando vuelva, se le pasa con un asesor). Si nombra un dato ("luego te paso la
  // cédula"), si ya los entregó ("Ana Ruiz 43123456, mañana vuelvo") o si pide un momento ("espera, luego miro y te
  // digo") va a darlos: es una espera, no una cancelación.
  if (!opts.waiting && !opts.hasData && POSTPONE_WHEN.test(n) && POSTPONE_ACT.test(n) && !/\b(cedula|documento|numero|nombre|datos|cartera)\b/.test(n)
    && !STAYING.test(n) && !HOLD_LEAD.test(n) && !isHold(message)) {
    return { cancel: true, question: false };
  }
  let bare = n;
  if (!opts.waiting) bare = bare.replace(CANCEL_FAREWELL, ' ').replace(CANCEL_WORDS_COLLECTING, ' ');
  bare = bare.replace(CANCEL_HARD, ' ');
  if (!opts.waiting || !opts.answering) bare = bare.replace(CANCEL_SOFT, ' ');
  if (bare === n) return { cancel: false, question: false }; // no dijo nada de cancelar
  return { cancel: bare.replace(COURTESY_RE, ' ').replace(LEFTOVER, ' ').trim() === '', question: false };
}
export const isCancel = (message: string, opts: { waiting?: boolean; answering?: boolean; hasData?: boolean } = {}) => cancelOf(message, opts).cancel;

/** No quiere, no puede o no sabe dar sus datos: se le pasa igual con el asesor. */
const REFUSE_ONLY =
  /^(no+|nop|nel|no quiero|no deseo|no puedo|no puedo ahora|ahorita no puedo|ahora no puedo|no se|no lo se|no la se|no se cual|no se cual es|no se cual sera|no se cuales|no me acuerdo|no me acuerdo cual es|no recuerdo|no recuerdo cual es|no lo recuerdo|no la recuerdo|ni idea|ni idea cual|ni idea cual es|no tengo idea|no estoy segur[oa]|ninguna|ninguno|ninguna de esas|ninguna de las anteriores|ninguno de esos|no es ninguna|no es ninguna de esas|no la conozco|no la tengo|no lo tengo|no los tengo|no tengo|prefiero no|prefiero no decirlo|prefiero no darlo|prefiero no darlos|preferiria no|prefiero reservarlo|prefiero reservarmelo|no confio|no doy datos|anonimo|anonima|confidencial|es confidencial|es secreto|no te lo voy a decir|no te lo digo|no lo digo|no se lo voy a decir|no te voy a decir|no te digo)$/;
const REFUSE_ANY =
  /\b(no (quiero|deseo|puedo|voy a) (dar|darte|darle|darles|compartir|decir|decirte|decirle|suministrar|entregar|enviar|mandar)|no me interesa (dar|darte|darle|compartir|decir|decirte|darlos)|prefiero no (dar|darlo|darla|darlos|decir|decirlo|compartir|compartirlo)|preferiria no (dar|decir|compartir)|no (te |le |les |se )?(doy|dare) (mis |mi |el |la |esos |esa )?(datos|dato|cedula|documento|numero|nombre)|no (te |le |les |se )(la|lo|los|las) (doy|dare|digo|paso|voy a dar|voy a decir|voy a pasar)|no (la|lo|los|las) voy a (dar|decir|pasar|compartir)|no te voy a (decir|dar)|no (la|lo|los) tengo( a la mano| aqui| ahora| conmigo)?|no me (la|lo) se( de memoria)?|no me se (la|el|mi) (cedula|documento|numero)( de memoria)?|no (me )?(acuerdo|recuerdo)( de| del)?( mi| el| la)? (numero|cedula|documento|cartera|nombre)|no (se|recuerdo) (cual|que) (es )?(mi |la |el )?(cartera|numero|documento|cedula)|no tengo (el |la |mi )?(numero|documento|cedula|cartera)( a la mano| aqui| ahora| conmigo)?|no confio|por seguridad no|no (es|me parece) seguro|ya no me acuerdo|no tengo (por que|porque) (decir|decirte|decirle|darte|darle|dar)|no es (tu|su) (asunto|problema))\b|\bno (se|recuerdo|tengo idea|estoy segur[oa]) (cual|de cual|que|de que)( es| sera| seria| son)?$|\bno estoy segur[oa]\b(?! de (que|querer))|^(?:y )?(?:a ti|a usted) que\b|^(?:eso )?es (personal|privado)$|^(cualquiera|la que sea|el que sea|cualquiera de (las|los) dos|cualquiera de esas|cualquiera sirve)$/;
/**
 * "¿Y a ti qué te importa?", "eso no te incumbe", "no le interesa": se niega a darle el dato al bot. "A ustedes no les
 * importa el cliente" es una queja, no una negativa.
 */
const REFUSE_RUDE = /^(?:(?:y|pero|pues|eso|a ti|a usted|y a ti|y a usted|mi nombre|mi cedula|mi documento|mi numero|mis datos)\s+)*(?:que|no) (?:te|le) (?:importa|incumbe)\b|^(?:(?:y|pero|pues|eso|mi nombre|mi cedula|mi documento|mis datos)\s+)*no (?:te|le) (?:interesa|incumbe)\b/;
/** "Flamingo u Offcorss, no sé", "Juan Pérez, no recuerdo": no sabe (el dato que le piden). Contar su caso ("me cobran y no sé") no lo es. */
const DONT_KNOW_END = /^(?:\S+\s+){0,5}(?:no se|no lo se|eso no lo se|no recuerdo|no lo recuerdo|no me acuerdo|ni idea|no tengo idea)$/;
export function isRefuse(message: string): boolean {
  const n = normalize(message);
  return REFUSE_ANY.test(n) || REFUSE_ONLY.test(n.replace(COURTESY_RE, ' ').replace(/\s+/g, ' ').trim())
    || (REFUSE_RUDE.test(n) && n.split(' ').length <= 8) || (DONT_KNOW_END.test(n) && !mentionsCase(n));
}
/**
 * Qué dato se niega a dar o no tiene ("la cédula no te la doy" → el documento; "no sé cuál es" → la cartera); 'all' si
 * no dice cuál ("no quiero dar mis datos"). null si no se niega.
 */
export function refusedFields(message: string): Array<'name' | 'document' | 'portfolio'> | 'all' | null {
  if (!isRefuse(message)) return null;
  const n = normalize(message);
  const out: Array<'name' | 'document' | 'portfolio'> = [];
  if (/\b(cedula|documento|numero|identificacion|cc|pasaporte)\b/.test(n)) out.push('document');
  if (/\bnombre\b/.test(n)) out.push('name');
  if (/\b(cartera|entidad)\b/.test(n)) out.push('portfolio');
  return out.length > 0 ? out : 'all';
}
/** Se negó y en el mismo mensaje pregunta otra cosa ("no quiero dar mi cédula, solo dime el correo"). */
export function refuseQuestion(message: string): boolean {
  const n = normalize(message);
  const m = n.match(REFUSE_ANY);
  if (!m) return false;
  const after = n.slice(m.index! + m[0].length).replace(/^\s*(pero|solo|y|mejor|entonces)\b/, ' ').trim();
  return after.split(' ').filter((w) => w.length >= 3).length >= 2;
}

/** "Un momento", "ya te los paso", "permítame un momento", "déjame buscarla": va a dar los datos, solo pide tiempo. */
const HOLD_RE =
  /^(un momento|un momentico|un momentito|un segundo|un segundito|un minuto|un minutico|un ratico|momento|momentico|momentito|segundo|espera|espere|esperame|espereme|esperen|aguarda|aguarde|aguardame|ahorita|permitame|permiteme|dame un (momento|segundo|minuto|momentico)|deme un (momento|segundo|minuto)|ya te (lo|la|los|las) (paso|doy|envio|mando|escribo|busco)|ya se (lo|la|los|las) (paso|doy|envio|mando)|ahorita te (lo|la|los|las) (paso|doy|envio|mando)|ya (lo|la|los) (busco|reviso)|(la|lo) busco|dejame (buscar|ver|revisar|mirar)(lo|la)?|dejeme (buscar|ver|revisar|mirar)(lo|la)?|(lo |la )?estoy buscando|ya va|ya voy|voy)( ya)?$/;
const HOLD_ANY =
  /\b((dame|deme|un|espera|espere|esperame|espereme|regalame|regaleme|permiteme|permitame|aguarda|aguarde) (un )?(momento|momentico|momentito|segundo|segundito|minuto|minutico|ratico)\b|(dejame|dejeme|permiteme|permitame) (la |lo |los )?(busco|buscar|buscarla|buscarlo|buscarlos|reviso|revisar|miro|mirar|consulto)|(estoy|ando) buscando (la|el|mi|los|mis)|(ya )?voy a buscar(la|lo|los)?|(el )?(lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|luego|ahorita|ya|despues|mas tarde|en un momento|en un rato|el fin de semana|esta tarde|esta noche) (te|se|le) (lo|la|los|las) (doy|paso|envio|mando|escribo)|(te|se|le) (lo|la|los|las) (doy|paso|envio|mando|escribo) (el |la |en la |en el |en un |mas |esta |este )?(lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana|luego|despues|tarde|noche|rato|ratico|momento|ahorita|semana|fin de semana)|ya (regreso|vuelvo|vengo)|(la|lo|los) (estoy buscando|voy a buscar|busco y te (la|lo|los) (paso|doy|envio)))\b/;
/** "Espera, luego miro y te digo", "espérame, luego reviso": pide un momento antes de seguir. */
const HOLD_LEAD = /^(espera|espere|esperame|espereme|esperen|aguarda|aguarde|aguardame|dejame|dejeme|permiteme|permitame|un momento|un momentico|un segundo|un minuto|un ratico|momento)\b/;
const HOLD_ACT = /\b(miro|reviso|busco|te digo|le digo|les digo|escribo|vuelvo|regreso|aviso|paso|confirmo|verifico)\b/;
/** "Luego te paso la cédula", "más tarde te escribo con los datos", "ya te escribo los datos": va a darlos después. */
const HOLD_LATER = /\b(luego|despues|ahorita|ya|mas tarde|en un rato|en un momento|manana|en la tarde|en la noche) (te |le |les |se )?(lo |la |los |las )?(paso|doy|envio|mando|escribo|digo|comparto)\b(?=.*\b(cedula|documento|numero|nombre|datos|dato)\b)|\b(te|le|les|se) (paso|doy|envio|mando|escribo|comparto) (la|el|mi|mis|los|las) (cedula|documento|numero|nombre|datos|dato)\b|\b(escribo|paso|envio|vuelvo|regreso) con (la|el|mi|mis|los|las) (cedula|documento|numero|nombre|datos)\b/;
export const isHold = (message: string) => {
  const n = normalize(message).replace(COURTESY_RE, ' ').replace(/\s+/g, ' ').trim();
  return HOLD_RE.test(n) || HOLD_ANY.test(n) || HOLD_LATER.test(n) || (HOLD_LEAD.test(n) && HOLD_ACT.test(n));
};

/** "¿Para qué necesitan mis datos?", "¿por qué?", "¿y eso para qué?", "¿es seguro?": se explica antes de volver a pedirlos. */
const WHY_DATA_RE =
  /\b(para que|por que|pa que) (necesitan|necesitas|necesita|quieren|quieres|quiere|piden|pides|pide|me piden|me pides|preguntan|preguntas|pregunta)\b|\b(para que|pa que) (sirven|sirve)( (mis|mi|los|el|esos|eso) (datos|cedula|documento|nombre|numero))?$|^(es|sera) (obligatorio|necesario|necesario darlos|obligatorio darlos)$|\b(tengo que|debo|hay que) (dar|darlos|darte|darles|compartir) (mis )?(datos|cedula|documento|nombre)\b|\b(para que|por que) (es|son) (eso|esos|mis datos|mi cedula|mi documento|el documento|la cedula|mi nombre)\b|\bes seguro (dar|darte|darles|compartir)\b|\b(que|quien) (hacen|hace|van a hacer|va a hacer) con (mis|mi) (datos|cedula|documento|informacion)\b|^(y )?(eso )?(para que|por que|pa que|porque)( es| son)?( eso| esos| lo| la| los| las)?( necesitas| necesitan| necesita| quieres| quiere| quieren| piden| pides| pide| preguntas| pregunta)?( eso)?$|^(y )?(es|sera) (seguro|confiable)( dar(los|lo|la)?| darte| compartir(los)?)?$/;
export const isWhyData = (message: string) => WHY_DATA_RE.test(normalize(message));

/**
 * Pregunta por la espera cuando ya está en la cola de un asesor (o va a estarlo). "¿Cuánto se demora el paz y salvo?"
 * o "¿cuánto más tengo que pagar?" no son preguntas por la espera.
 */
const WAIT_TAIL = '(?=$| (el asesor|la asesora|los asesores|un asesor|la atencion|en atender|en atenderme|en contestar|en responder|en contestarme|en responderme|en llegar|ustedes|eso|esto|mucho|tanto|todavia|aun|mas|para atenderme))';
export const WAIT_RE = new RegExp(
  `\\b(cuanto (tiempo )?(mas )?(se )?(demora|demoran|tarda|tardan)${WAIT_TAIL}|cuanto (tiempo )?(mas )?(falta|me falta|hay que esperar|debo esperar|tengo que esperar)|cuanto (mas )?(tengo|debo|hay) que esperar|(cuanto|que tanto) (me|nos) (toca|tocaria|toca a mi) esperar|(se )?(demoran|tardan|demora|tarda) mucho|a que hora (me )?(atienden|van a atender|contestan|escriben|responden|me atienden)|^(y )?(el|la) (asesor|asesora)$|cuando (llega|viene|me escribe|me contesta|me atiende) (el|la) (asesor|asesora)|en cuanto tiempo|para cuando|ya casi|falta mucho|falta poco|todavia falta|(ya )?(me )?(van a|vienen a|viene a) (atender|contestar|responder)|cuando (me )?(atienden|atenderan|contestan|responden|van a|me toca)|sigo esperando|sigo en (la )?(fila|espera|cola)|estoy esperando|llevo (mucho|rato|tiempo|horas|minutos)|nadie (me )?(ha |han )?(responde|contesta|atiende|respondido|contestado|atendido|escrito)|(el|la|mi|ningun|ninguna|un|una) (asesor|asesora|agente) (no|aun no|todavia no|nunca) (me )?(ha |han |me ha |me han )?(contesta|contestado|contesto|responde|respondido|respondio|escribe|escrito|escribio|atiende|atendido|atendio|aparece|llega|llego)|hay alguien|estan ahi|alguien (ahi|me atiende|me va a atender)|todavia no (me )?(atienden|contestan|responden)|aun no (me )?(atienden|contestan|responden)|ya viene|ya llega|(?:ya|aun|todavia) (?:me|nos) (?:atendieron|atendio)|no se si (?:ya )?(?:me |nos )?(?:atendieron|atendio|van a atender)|por que (se )?(demora|demoran|tarda|tardan)${WAIT_TAIL}|tanto tiempo|tan demorad[oa]s?|muy demorad[oa]s?|que demora|se demoran mucho|se demora mucho|en que (puesto|turno|lugar) voy|mi turno|cuantos (hay|faltan|van) (antes|delante)|ya me toca|apurad[oa]|de afan|es urgente)\\b`,
);
export const isWaitQuestion = (message: string) => WAIT_RE.test(normalize(message));

/** "No entiendo", "no le entendí", "¿cómo así?": no entendió lo último que dijo el bot (no es un "no"). */
const CONFUSED_RE = /^(?:(?:no|nop|aun no|todavia no|sigo sin)\s+(?:te |le |les |lo |la )?(?:entiendo|entendi|entender|comprendo|comprendi|comprender|capto|cache)(?:\s+(?:bien|nada|muy bien|eso|esa parte|lo que (?:dices|dice|me dices|me dice|me dijiste|me dijo|quieres decir)))?|no (?:me )?(?:queda|quedo) claro|no se a que te refieres|como asi|a que te refieres|que significa eso|que quieres decir|no te sigo|no le sigo|me perdi)$/;
export const isConfused = (message: string) => CONFUSED_RE.test(normalize(message).replace(COURTESY_RE, ' ').replace(/\s+/g, ' ').trim());

/**
 * "¿Y si no tengo cédula?", "no tengo cédula, ¿sirve la tarjeta de identidad?", "¿cuál documento?": pregunta qué
 * documento sirve. Se le explica y se sigue (no es negarse a darlo).
 */
const DOC_QUESTION = /\b(y )?si no (tengo|tiene|tenemos|cuento con) (la |mi |el |un |una |ningun |ninguna )?(cedula|documento|identificacion|cc)\b|\b(sirve|vale|puedo dar|puedo usar|aceptan|acepta|se puede con|recibe|reciben|cuenta|funciona) (la |el |mi |un |una |con la |con el |con mi )?(tarjeta de identidad|ti|pasaporte|cedula de extranjeria|ppt|pep|registro civil|contrasena|licencia|denuncio|otro documento|nit)\b|\b(cual|que|que tipo de) documento\b/;
export const asksWhichDocument = (message: string) => {
  const n = normalize(message);
  return (/[?¿]/.test(message) || /\b(sirve|vale|puedo|aceptan|que hago)\b/.test(n)) && DOC_QUESTION.test(n);
};

/** Una empresa que quiere contratar el servicio ("¿pueden trabajar para mi empresa en la cobranza?"): no busca empleo. */
export const COMMERCIAL_RE = /\b(mi|nuestra|nuestro|nuestras|mis) (empresa|empresas|compania|negocio|organizacion|entidad|firma|marca|cooperativa|tienda|almacen)\b|\b(nuestros|mis) clientes\b|\bcomo (empresa|compania|aliad[oa]s?|socios?|proveedor(es)?)\b|\b(empresa|empresas) aliadas?\b|\b(ser|volvernos|hacernos|convertirnos en) (sus )?(aliad[oa]s?|socios|proveedores)\b|\b(aliarnos|aliarme|alianza|alianzas)\b|(?<!\b(?:me|nos) (?:pueden |puede |podrian |podria |van a |quieren |quisieran )?)\bcontratar\b|\b(contratarlos|contratarles|cotizar|cotizacion|tercerizar|outsourcing|propuesta comercial|alianza comercial)\b|\b(recuperar|recuperacion de|gestionar|gestion de|cobrar) (la |nuestra |mi |su )?cartera\b|\bbuscamos (una )?empresa\b/;
