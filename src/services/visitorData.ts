import { normalize } from '../utils/text';
import { analyze, isPureYesNo, JOB_SENSE, yesNo } from './intents';
import { COMMON, DESCRIPTIVE_NAMES, ENDEARMENTS, EVERYDAY, FIRST_NAMES, isCommonWord, PLACES, ROLE_TITLES, SURNAMES, TITLES, WORD_NAMES } from './lexicon';

/** Una marca o entidad ("Claro", "Bancolombia"): está entre las palabras comunes pero no es de uso diario. */
const COMMON_BRAND = (w: string) => COMMON.has(w) && !EVERYDAY.has(w);

/**
 * Captura de datos del visitante (nombre, documento y cartera) a partir de lo que escribe. Es determinística: no
 * depende del modelo, así que funciona aunque la IA no esté disponible.
 *
 * Regla general: ante la duda NO se guarda. Un dato mal guardado ("Mucho gusto, Teléfono", un monto como cédula)
 * se ve en la conversación y en el panel; uno que falta solo hace que el bot lo pida.
 */

export type DataField = 'name' | 'document' | 'portfolio';
export interface PortfolioTerms { key: string; name: string; aliases?: string[] | null }
export interface Extracted {
  /** Número de contacto que dejó el visitante (no se guarda como documento). */
  phone?: string;
  document?: string;
  /** El número vino con su palabra ("mi cédula es…", "CC …") o como corrección: puede reemplazar uno anterior. */
  documentExplicit?: boolean;
  portfolioKey?: string;
  /** La cartera vino con una marca clara ("mi cartera es…", "es con Flamingo"): puede corregir una anterior. */
  portfolioExplicit?: boolean;
  name?: string;
  /** El visitante dijo su nombre de forma explícita ("me llamo…", "mi nombre es…") o lo corrigió: reemplaza uno anterior. */
  nameExplicit?: boolean;
  /** El mensaje corrige un dato ("perdón, es…", "me equivoqué", "no es X, es Y"). */
  correction?: boolean;
  /** El mensaje trae un signo de pregunta ("Andrés, ¿y el correo?"). */
  asks?: boolean;
  /** Lo que queda del mensaje sin los datos: si está vacío, el mensaje solo traía datos. */
  rest: string;
  /**
   * Lo que dijo además de los datos, sin quitar las palabras que suelen acompañarlos ("Juan Pérez qué horario tienen" →
   * "que horario tienen"): sirve para ver si además pregunta algo.
   */
  said?: string;
}

/** Qué estaba pidiendo el bot cuando llegó el mensaje. */
export interface CaptureContext {
  /**
   * 'name': preguntó solo el nombre ("¿Con quién tengo el gusto?") · 'handoff': pidió los datos para pasar con un
   * asesor (ver `missing`) · 'offer': ofreció un asesor · 'queue': ya espera a un asesor y faltan datos (solo se toma
   * un nombre claro: nombre de pila conocido, nombre con apellido o con mayúscula).
   */
  asked?: 'name' | 'handoff' | 'offer' | 'queue' | null;
  /** Datos que el bot está pidiendo cuando `asked` es 'handoff' o 'queue'. */
  missing?: DataField[];
  /** Números que publica la empresa (línea, NIT): nunca son el documento del visitante. */
  companyNumbers?: Set<string>;
  /** Palabras del sitio de la empresa (marcas aliadas, servicios, su nombre): no son el nombre del visitante. */
  siteWords?: Set<string>;
  /** El nombre guardado es una sola palabra poco común ("Comfandi"): se lee igual el nombre, por si llega uno completo. */
  nameLoose?: boolean;
  /** El nombre que ya está guardado: "Pedro no, Juan Gómez" o "no, Juan Gómez" lo corrigen. */
  savedName?: string | null;
}

const toContext = (ctx: CaptureContext | boolean | 'weak' | undefined): CaptureContext =>
  ctx === true ? { asked: 'name' } : ctx === 'weak' ? { asked: 'offer' } : !ctx ? { asked: null } : ctx;

/**
 * "Perdón, es…", "me equivoqué", "no es X, es Y", "mejor dicho", "el número correcto es…", "1020304051 es el correcto",
 * "lo escribí mal", "me faltó un número", "la nueva es…", "en realidad es de Offcorss", "no era…": corrige un dato que
 * ya dio.
 */
const CORRECTION_RE = /\b(perdon|perdona|perdone|disculpa|disculpe|me equivoque|me confundi|corrijo|correccion|el correcto es|la correcta es|el bueno es|la buena es|mejor dicho|quise decir|no es|no era|en realidad (es|era)|(el|mi|ese|este|la|esa|esta) (numero|documento|cedula|dato) (correcto|correcta|real|bueno|buena|verdadero|verdadera|nuevo|nueva) es|(es|era) (el|la) (correcto|correcta|bueno|buena|real)|(esta|estaba|quedo) mal( escrito| escrita)?|(lo|la) (escribi|puse|digite|di|anote) mal|me falto (un|una) (numero|digito|cifra)|(el|la) (nuevo|nueva) es|error es)\b/;
/** "No, es Offcorss", "no señor, es Flamingo", "ah no, la de Offcorss": el "no" con pausa corrige lo dicho antes. */
const NO_THEN_SOURCE = String.raw`(^|[^\p{L}])no(?:\s+(?:se[ñn]or(?:a|ita)?|joven|doctor(?:a)?|mij[oa]|amig[oa]|veci))?\s*[,;:.!]+\s*(?=(?:es|era|ser[ií]a|sino|la|el|de|del|con|mi|para)(?![\p{L}]))`;
const correctsWithPause = (message: string) => new RegExp(NO_THEN_SOURCE, 'iu').test(message);
export const isCorrection = (message: string) => CORRECTION_RE.test(normalize(message)) || correctsWithPause(message);

/* ---------- documento ---------- */

const DOC_WORD = /\b(cedula|cedula de ciudadania|cedula de extranjeria|documento|documento de identidad|identificacion|identificado|identificada|cc|c c|ce|nit|pasaporte|ppt|pep|nuip|tarjeta de identidad)\b/;
/** La palabra justo después del número: "1020304050 es mi cédula", "1021803088 número de documento". */
const DOC_AFTER = /^(es )?(mi |el |la |su )?(numero de )?(cedula|documento|cc|c c|nit|identificacion)\b/;
const PHONE_WORD = /\b(celular|cel|telefono|tel|whatsapp|wsp|wasap|movil|contacto|llamar|llamen|llamenme|llamame|llamarme|llamando|llamaron|llama|llaman|marcar|marquen|marcame|linea|fijo|escribeme|escribanme|numero de contacto|del numero|desde el|este numero|ese numero)\b/;
const MONEY_WORD = /\b(debo|deuda|debe|deben|debia|saldo|valor|monto|pagar|pague|pago|pagos|abono|abonar|abone|cuota|cuotas|cobran|cobrando|cobro|cobraron|cobrar|cuesta|cuestan|precio|total|interes|intereses|plata|consigne|consignar|consignacion|transferi|transferencia|prestamo|suma|capital|me deben)\b/;
const REF_WORD = /\b(obligacion|obligaciones|referencia|ref|factura|radicado|pagare|contrato|orden|pedido|guia|ticket|expediente|proceso|codigo|cuenta|convenio|producto|credito|tarjeta)\b/;
/** Letras pegadas a un número que no son parte del pasaporte ("PPT1234567", "CC1020304050"). */
const DOC_LETTERS_STOP = new Set(['ppt', 'pep', 'cc', 'ce', 'ti', 'no', 'nro', 'num', 'nit', 'c', 'n']);

interface NumberCandidate { start: number; end: number; raw: string; digits: string }

/**
 * Números del mensaje con su posición. Los grupos cortos separados por un espacio son un solo número
 * ("1 020 304 050", "604 607 4101"); dos números largos seguidos son dos ("1020304050 3001234567").
 */
function numberCandidates(message: string): NumberCandidate[] {
  const groups: { start: number; end: number; raw: string }[] = [];
  for (const m of message.matchAll(/\+?\d[\d.,'’-]*\d|\d/g)) {
    const t = { start: m.index!, end: m.index! + m[0].length, raw: m[0] };
    const last = groups.at(-1);
    const longLast = !!last && last.raw.split(' ').at(-1)!.replace(/\D/g, '').length >= 5;
    const longThis = t.raw.replace(/\D/g, '').length >= 5;
    if (last && message.slice(last.end, t.start) === ' ' && !(longLast && longThis)) {
      last.raw += ` ${t.raw}`;
      last.end = t.end;
    } else groups.push({ ...t });
  }
  const out: NumberCandidate[] = [];
  for (const g of groups) {
    // "1020304050-3001234567": dos números pegados con guion (un NIT con dígito de verificación sigue siendo uno).
    const pieces = g.raw.split('-');
    if (pieces.length === 2 && pieces.every((p) => p.replace(/\D/g, '').length >= 5)) {
      let at = g.start;
      for (const p of pieces) {
        out.push({ start: at, end: at + p.length, raw: p, digits: p.replace(/\D/g, '') });
        at += p.length + 1;
      }
    } else out.push({ ...g, digits: g.raw.replace(/\D/g, '') });
  }
  return out;
}

const wordsBefore = (message: string, i: number, n: number) => normalize(message.slice(0, i)).split(' ').slice(-n).join(' ');
const wordsAfter = (message: string, i: number, n: number) => normalize(message.slice(i)).split(' ').slice(0, n).join(' ');
const isDate = (raw: string) => /^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/.test(raw) || /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(raw);

/**
 * Las palabras antes del número, sin los apellidos que siguen a un nombre ("Martha Cuesta 43123456", "Luz Dary Cuesta
 * 52111222" o "Marina Linda Cuesta …" no hablan de un precio).
 */
function moneyContext(message: string, i: number): string {
  const raw = message.slice(0, i).replace(/[,;:]+/g, ' ').trim().split(/\s+/).slice(-3);
  const ws = raw.map((w) => normalize(w));
  const nameBefore = (k: number) => FIRST_NAMES.has(ws[k - 1]) || SURNAMES.has(ws[k - 1]) || (/^[A-ZÁÉÍÓÚÑ]/.test(raw[k - 1]) && /^[A-ZÁÉÍÓÚÑ]/.test(raw[k]));
  return ws.filter((w, k) => !(SURNAMES.has(w) && k > 0 && nameBefore(k))).join(' ');
}

/**
 * Un monto, no un documento. "850.000" o "debo 1.500.000" lo son; "mi saldo 1020304050" (forma de cédula: 10 dígitos
 * que empiezan por 10 u 11, sin separadores) o "¿cuánto debo? 43567890" (pregunta el monto y da su número) no.
 * Si el bot está pidiendo el documento, "43.120.000" junto al nombre es la cédula.
 */
function isMoney(c: NumberCandidate, message: string, opts: { askedDocument?: boolean }): boolean {
  if (/['’]/.test(c.raw)) return true; // 1'200.000
  if (/\$\s*$/.test(message.slice(Math.max(0, c.start - 3), c.start))) return true;
  if (/^(pesos|mil|millones|cop|usd|dolares|de pesos|mcte|m cte|mensuales|al mes|de deuda)\b/.test(wordsAfter(message, c.end, 2))) return true;
  const asksAmount = /\bcuanto (debo|es mi deuda|tengo que pagar|me falta|me queda|debo pagar)\b/.test(wordsBefore(message, c.start, 5)) && c.digits.length >= 7;
  const moneyBefore = MONEY_WORD.test(moneyContext(message, c.start)) && !asksAmount;
  if (/^\d{1,3}([.,]\d{3})+$/.test(c.raw) && /[.,]000$/.test(c.raw)) return moneyBefore || !opts.askedDocument; // 850.000, 2.300.000
  if (!moneyBefore) return false;
  return !/^1[01]\d{8}$/.test(c.digits) || /[.,]/.test(c.raw);
}

/** "¿El NIT 900123456-1 es de ustedes?", "me llamaron del 3001234567": el número es de otro (la empresa, quien llamó). */
const ASKED_ABOUT_AFTER = /^(es|son|sera|seria|era) (de |el de |la de )?(ustedes|suyo|suya|la empresa)\b|^(de )?quien es\b|^(le |les )?pertenece\b|^es (real|oficial|valido|confiable)\b/;
const ASKED_ABOUT_BEFORE = /\bme (llamaron|llaman|llamo|escribieron|escriben|escribio|contactaron|marcaron|timbraron) (del|desde|de este|de ese|al|el)( numero| telefono| celular| fijo)?$/;
const askedAbout = (message: string, c: NumberCandidate) =>
  ASKED_ABOUT_AFTER.test(wordsAfter(message, c.end, 5)) || ASKED_ABOUT_BEFORE.test(wordsBefore(message, c.start, 7));

function isPhone(c: NumberCandidate, message: string): boolean {
  const d = c.digits;
  if (c.raw.startsWith('+') || (d.length === 12 && d.startsWith('57'))) return true;
  // Celular colombiano (3xx) o fijo nacional (60x) de 10 dígitos; las cédulas de 10 dígitos empiezan por 1.
  if (d.length === 10 && (d.startsWith('3') || d.startsWith('60'))) return true;
  return PHONE_WORD.test(wordsBefore(message, c.start, 4));
}

/**
 * Documento del visitante: 5 a 12 dígitos, con o sin separadores ("1.021.803.088", "1 021 803 088"), o un
 * pasaporte con letras pegadas ("AB123456"). Con la palabra ("cédula", "CC", "NIT", "documento") cerca, se toma aunque
 * se parezca a otra cosa. Sin ella NO se toman montos ("850.000", "debo 1.500.000"), teléfonos (celulares,
 * "llámame al…"), fechas, números de obligación o factura, ni los números que publica la empresa. En una corrección
 * ("no es 1020304050, es 1020304051") vale el último número.
 */
export function findDocument(
  message: string, companyNumbers?: Set<string>, opts: { askedDocument?: boolean; correcting?: boolean } = {},
): { value: string; explicit: boolean } | undefined {
  const n = normalize(message);
  if (/\b(pasaporte|ppt|pep)\b/.test(n)) {
    for (const m of message.matchAll(/(?<![\p{L}\d])([A-Za-z]{1,3})-?(\d{5,9})(?!\d)/gu)) {
      if (!DOC_LETTERS_STOP.has(m[1].toLowerCase())) return { value: `${m[1]}${m[2]}`.toUpperCase(), explicit: true };
    }
  }
  // El PEP (permiso especial de permanencia) tiene 15 dígitos; los demás documentos, de 5 a 12.
  const size = (c: NumberCandidate) => (c.digits.length >= 5 && c.digits.length <= 12) || (c.digits.length === 15 && /\bpep\b/.test(wordsBefore(message, c.start, 4)));
  const candidates = numberCandidates(message).filter((c) => size(c) && !isDate(c.raw) && !companyNumbers?.has(c.digits) && !askedAbout(message, c));
  const withWord = (c: NumberCandidate) => DOC_WORD.test(wordsBefore(message, c.start, 4)) || DOC_AFTER.test(wordsAfter(message, c.end, 4));
  const loose = (c: NumberCandidate) => c.digits.length >= 6 && !isMoney(c, message, opts) && !isPhone(c, message) && !REF_WORD.test(wordsBefore(message, c.start, 4));
  if (opts.correcting ?? CORRECTION_RE.test(n)) {
    const last = [...candidates].reverse().find((c) => withWord(c) || loose(c));
    if (last) return { value: last.digits, explicit: true };
  }
  // 1) "mi cédula es N", "CC N"; 2) "N es mi cédula", "N número de documento"; 3) un número suelto que no es otra cosa.
  const before = candidates.find((c) => DOC_WORD.test(wordsBefore(message, c.start, 4)));
  if (before) return { value: before.digits, explicit: true };
  const after = candidates.find((c) => DOC_AFTER.test(wordsAfter(message, c.end, 4)));
  if (after) return { value: after.digits, explicit: true };
  const found = candidates.find(loose);
  return found ? { value: found.digits, explicit: false } : undefined;
}

export const extractDocument = (message: string, companyNumbers?: Set<string>): string | undefined => findDocument(message, companyNumbers)?.value;

/** "¿El 604 607 4101 es de ustedes?", "me llamaron del 3001234567": el número es de otro, no el del visitante. */
const PHONE_QUESTION = /\b(es|son|sera|seria) (de |el de |la de )?(ustedes|suyo|suya|la empresa)\b|\bde quien es\b|\bpertenece\b|\bes (real|oficial|confiable|seguro)\b|\bme (llamaron|llaman|escribieron|escriben|contactaron|marcaron|timbraron) (del|desde|de este|de ese|al)\b/;

/**
 * Celular o teléfono que el visitante deja para que lo contacten ("mi wsp 3104567890", "llámame al 300 123 4567").
 * No se guarda como documento; el asesor lo ve en la conversación.
 */
export function findPhone(message: string, companyNumbers?: Set<string>): string | undefined {
  if (PHONE_QUESTION.test(normalize(message))) return undefined;
  return numberCandidates(message).find((c) => c.digits.length >= 7 && c.digits.length <= 12 && !companyNumbers?.has(c.digits)
    && !DOC_WORD.test(wordsBefore(message, c.start, 4)) && isPhone(c, message))?.digits;
}
/** Las palabras con que se deja un número de contacto: no son una pregunta ni un tema. */
const PHONE_PHRASE =
  /\b(si (quieres|quieren|gusta|gustan|prefieren|prefiere) )?((me|nos) (pueden|puede|puedes|podrian) (llamar|marcar|escribir|contactar)|llamame|llamenme|llameme|llamarme|marcame|marquenme|escribeme|escribanme|mi (numero de )?(celular|cel|telefono|whatsapp|wsp|wasap|numero)( de contacto)?( es)?|(al|a mi) (celular|whatsapp|wsp|numero|telefono)|mi contacto( es)?|numero de contacto|al)\b/g;

/* ---------- cartera ---------- */

const FILLER = new Set(['cartera', 'carteras', 'area', 'areas', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'mi', 'es', 'en', 'con', 'por', 'para']);
/** Palabras que acompañan la respuesta y no son la cartera ("Juan Pérez, cc 1020304050, General", "perdón, es Offcorss"). */
const BARE_FILLER = new Set(['si', 'pues', 'gracias', 'es', 'esa', 'ese', 'cc', 'c', 'cedula', 'documento', 'numero', 'nombre', 'soy', 'llamo', 'me', 'mi',
  'ah', 'ahh', 'ya', 'acorde', 'acuerdo', 'listo', 'ok', 'bueno', 'dale', 'por', 'favor', 'porfa', 'perdon', 'perdona', 'perdone', 'disculpa', 'disculpe',
  'equivoque', 'confundi', 'corrijo', 'correccion', 'correcto', 'correcta', 'mejor', 'dicho', 'quise', 'decir', 'era', 'sino', 'seria', 'creo', 'que', 'entonces',
  // "Es una consulta general", "es un tema de Flamingo": lo que acompaña a la cartera sin ser otra.
  'un', 'una', 'consulta', 'tema', 'caso', 'asunto', 'pregunta', 'sobre']);
/** "Claro", "listo" o "bueno" al inicio de la respuesta son un sí, no la cartera Claro. */
const YES_WORDS = new Set(['claro', 'listo', 'bueno', 'dale', 'ok', 'vale', 'perfecto', 'correcto', 'exacto']);
/** Raíz simple: "pruebas" y "prueba" cuentan igual; "creditos" y "credito" también. */
const stem = (w: string) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const stems = (s: string) => normalize(s).split(' ').filter((w) => w && !FILLER.has(w)).map(stem);
const termsOf = (p: PortfolioTerms) => [p.key.replace(/[-_]/g, ' '), p.name, ...(p.aliases ?? [])];

/**
 * Cartera mencionada en el mensaje por su clave, nombre o alias. Tolera plurales y palabras de relleno
 * ("mi cartera es cartera de prueba" encuentra "Cartera de pruebas"). Si varias coinciden, gana la más específica.
 * Solo dice que se nombra, no que sea la del visitante (ver statedPortfolio).
 */
export function matchPortfolio<P extends PortfolioTerms>(message: string, portfolios: P[]): P | undefined {
  const words = new Set(stems(message));
  let best: { p: P; size: number } | undefined;
  for (const p of portfolios) {
    for (const term of termsOf(p)) {
      const t = stems(term);
      if (t.length === 0 || !t.every((w) => words.has(w))) continue;
      if (!best || t.length > best.size) best = { p, size: t.length };
    }
  }
  return best?.p;
}

interface Mention<P> { p: P; at: number; size: number; words: string[] }
/**
 * Carteras nombradas en el mensaje, en orden: una por cada vez que se nombran ("claro que sí, … cartera Claro": la del
 * inicio es un sí y la otra la cartera). Si una está dentro de otra más específica, cuenta la específica.
 */
function mentionsOf<P extends PortfolioTerms>(message: string, portfolios: P[]): Mention<P>[] {
  const wordStems = normalize(message).split(' ').map(stem);
  const present = new Set(stems(message));
  const out: Mention<P>[] = [];
  for (const p of portfolios) {
    let best: { size: number; words: string[] } | undefined;
    for (const term of termsOf(p)) {
      const t = stems(term);
      if (t.length === 0 || !t.every((w) => present.has(w))) continue;
      if (!best || t.length > best.size) best = { size: t.length, words: t };
    }
    if (!best) continue;
    const { size, words } = best;
    wordStems.forEach((w, i) => { if (w === words[0]) out.push({ p, at: i, size, words }); });
  }
  return out
    .filter((m) => !out.some((o) => o !== m && o.size > m.size && m.words.every((w) => o.words.includes(w))))
    .sort((a, b) => a.at - b.at);
}

/** Palabras que acompañan al "sí" del inicio ("ok claro", "sí claro", "claro que sí, …"). */
const ACK_WORDS = new Set(['si', 'pues', 'ah', 'ya', 'bueno', 'ok', 'okey', 'listo', 'vale', 'dale', 'perfecto', 'bien', 'muy', 'gracias', 'que']);
const NEGATORS = new Set(['no', 'ni', 'tampoco', 'sin']);
/** "No, es Offcorss", "ah no, la de Flamingo", "no señor, es Flamingo": el "no" con pausa corrige lo dicho antes (no niega lo que sigue). */
const NO_THEN = new RegExp(NO_THEN_SOURCE, 'giu');
/** "Flamingo no, Offcorss": el "no" con pausa niega lo de antes ("Offcorss, no Flamingo" niega lo de después). */
const NO_PAUSE = /(^|[^\p{L}])no(\s*[,;:.!]+|\s*$)/giu;
const NO_AFTER = 'nopausa';
/** El "sí" del inicio de la respuesta: hasta dónde llega y si es todo el mensaje. */
function ackPrefix(words: string[]) {
  let end = 0;
  while (end < words.length && (YES_WORDS.has(words[end]) || ACK_WORDS.has(words[end]))) end++;
  return { end, whole: end === words.length, claroQueSi: /^(si )?claro que si\b/.test(words.join(' ')) };
}
/** Lo que une dos carteras nombradas seguidas ("Claro y Flamingo", "Claro o Offcorss"). */
const JOINERS = new Set(['y', 'e', 'o', 'u', 'ni', 'con', 'y con', 'o con']);
/** "Claro y Flamingo": el "claro" del inicio va unido a otra cartera, así que es la cartera Claro (no un sí). */
const joinedToNext = <P>(words: string[], found: Mention<P>[], i: number) =>
  found.some((m) => m.at > i + 1 && m.at <= i + 3 && JOINERS.has(words.slice(i + 1, m.at).join(' ')));

/** Una cartera negada ("no es Flamingo", "Flamingo no, …", "ni Claro"): lo que va antes o el "no" con pausa después. */
const NEGATED_LEAD = /\b(no|ni|tampoco|sin)( es| era| son| fue)?( de| con| por| para| la de| el de| del)?( la| el)?$/;

/**
 * Las carteras de la empresa que nombra el mensaje, sin el "claro" del inicio que es un sí, y si las niega todas
 * ("no es Flamingo"). Sirve para no decir "no encuentro esa cartera" cuando nombró una de las nuestras.
 */
export function namedPortfolios<P extends PortfolioTerms>(message: string, portfolios: P[]): { list: P[]; negated: boolean } {
  const text = message.replace(NO_THEN, '$1perdon ').replace(NO_PAUSE, `$1${NO_AFTER}$2`);
  const words = normalize(text).split(' ');
  const ack = ackPrefix(words);
  const seen = new Set<string>();
  const all = mentionsOf(text, portfolios);
  const found = all.filter((m) => !(m.at < ack.end && YES_WORDS.has(words[m.at]) && !joinedToNext(words, all, m.at)));
  const isNegated = (m: Mention<P>) => NEGATED_LEAD.test(words.slice(Math.max(0, m.at - 4), m.at).join(' ')) || words[m.at + m.size] === NO_AFTER;
  return {
    list: found.map((m) => m.p).filter((p) => !seen.has(p.key) && !!seen.add(p.key)),
    negated: found.length > 0 && found.every(isNegated),
  };
}

/** "mi cartera es X", "es con X", "tengo una deuda con X", "quiero un asesor de X", "me están cobrando de X": X es SU cartera. */
const PORTFOLIO_MARK = /\b(cartera|carteras|cartera de|de la cartera|cartera es|area es|la de|lo de|es de|es con|es por|es para|soy de|vengo de|vengo por|llamo por|cliente de|deuda con|deuda de|deuda en|deudas con|credito con|credito de|credito en|cuenta con|cuenta de|cuenta en|obligacion con|obligacion de|debo a|debo en|le debo a|compre en|me cobran de|me llaman de|me llamaron de|me escribieron de|me escriben de|de parte de|por parte de|tengo con|es la de|es el de|area de|asesor|asesora|agente|asesor de|asesora de|asesor para|asesora para|agente de|alguien de|alguien para|persona de|cobrando de|cobran de|cobrando por|llamando de|escribiendo de|pago con|pagos con|pago de|pago a|acuerdo con|negociar con|negociacion con|paz y salvo de|paz y salvo con|pagarle a|pagar a|pagarles a|abonar a|abono a|saldo con|saldo de|saldo en|mora con|mora en|cuota con|cuota de|cuotas con|cuotas de|cuotas en|factura de|facturas de|con los de|los de|las de|con las de)( la| el| los| las)?$/;
const ADVISOR_MARK = /\b(asesor|asesora|agente)( de| para)?( la| el| los| las)?$/;
/** "Quiero hablar con los asesores de Flamingo": en un pedido de asesor también marca la cartera. */
const ADVISORS_MARK = /\b(asesores|asesoras|agentes)( de| para)?( la| el| los| las)?$/;
/**
 * Lo que puede ir entre dos carteras nombradas a la vez ("con Claro y con Flamingo", "Offcorss o Flamingo", "una deuda
 * con Flamingo y otra con Offcorss").
 */
const COORDINATION = new Set(['y', 'e', 'o', 'u', 'ni', 'con', 'de', 'del', 'en', 'la', 'el', 'tambien', 'ademas', 'otra', 'otro', 'una', 'un',
  'deuda', 'deudas', 'credito', 'creditos', 'cuenta', 'cuentas', 'obligacion', 'obligaciones']);

/**
 * La cartera del visitante. Nombrar una marca no basta ("¿trabajan con Offcorss?" pregunta por un aliado): cuenta
 * si el visitante la marca como suya, o si el bot está pidiendo la cartera (`asked`). En la cola (`asked` = 'bare')
 * solo cuenta la marcada o la respuesta que es solo el nombre ("ah ya, es Flamingo").
 * - La negada no cuenta: "no es Flamingo, es Offcorss", "Offcorss, no Flamingo", "Flamingo no, Offcorss". "No, es
 *   Offcorss" (con pausa) corrige: es Offcorss.
 * - "Claro, me llamo Pedro", "ok claro", "claro que sí, general": el "claro" del inicio es un sí, no la cartera Claro
 *   (salvo que sea toda la respuesta cuando el bot pidió solo la cartera, `onlyPortfolio`). En la cola (`asked` =
 *   'bare') el bot no pregunta la cartera: una que también es un "sí" solo cuenta marcada ("es con Claro").
 * - Una cartera que es también una palabra común ("General", "Claro") solo cuenta marcada o como respuesta sola (sin
 *   el nombre y el documento que trae, `consumed`).
 * - Si nombra dos como suyas ("tengo deuda con Claro y con Flamingo") y no corrige, no se adivina (se le pregunta).
 * - "Quiero ser asesor de Offcorss" busca empleo: no dice su cartera. En un pedido de asesor (`human`), "los asesores
 *   de Flamingo" sí la dice.
 * - Una corrección que es solo la cartera ("perdón, Offcorss") es explícita.
 */
export function statedPortfolio<P extends PortfolioTerms>(
  message: string, portfolios: P[], asked: boolean | 'bare', consumed: Set<string> = new Set(),
  opts: { onlyPortfolio?: boolean; human?: boolean } = {},
): { portfolio: P; explicit: boolean; corrected?: boolean } | undefined {
  const text = message.replace(NO_THEN, '$1perdon ').replace(NO_PAUSE, `$1${NO_AFTER}$2`);
  const found = mentionsOf(text, portfolios);
  if (found.length === 0) return undefined;
  const n = normalize(text);
  const words = n.split(' ');
  const job = JOB_SENSE.test(n);
  const leadOf = (m: Mention<P>) => (m.at > 0 ? words.slice(Math.max(0, m.at - 4), m.at).join(' ') : '');
  const distinctOf = (m: Mention<P>) => new Set(termsOf(m.p).flatMap(stems));
  const ambiguous = (m: Mention<P>) => [...distinctOf(m)].every((w) => EVERYDAY.has(w));
  const ack = ackPrefix(words);
  /**
   * El "sí" del inicio cuenta como sí (y no como la cartera) salvo que sea toda la respuesta a "¿de qué cartera es?" o
   * que vaya unido a otra cartera ("Claro y Flamingo").
   */
  const yesAt = (i: number) => i < ack.end && YES_WORDS.has(words[i]) && !joinedToNext(words, found, i)
    && (ack.claroQueSi || !ack.whole || !opts.onlyPortfolio);
  const negated = (m: Mention<P>) => NEGATED_LEAD.test(leadOf(m)) || words[m.at + m.size] === NO_AFTER;
  // "Flamingo no, Offcorss", "Offcorss, no Flamingo": niega una y dice otra; es una corrección.
  const swapped = found.some(negated) && found.some((m) => !negated(m) && !yesAt(m.at));
  const correction = CORRECTION_RE.test(n) || swapped;
  const negWords = new Set(found.filter(negated).flatMap((m) => [...distinctOf(m)]));
  const bare = words.filter((w, i) => !FILLER.has(w) && !BARE_FILLER.has(w) && !consumed.has(w) && !/^\d+$/.test(w)
    && !NEGATORS.has(w) && w !== NO_AFTER && !negWords.has(stem(w)) && !yesAt(i)).map(stem);
  const isBare = (m: Mention<P>) => bare.length > 0 && bare.every((w) => distinctOf(m).has(w));
  const marked = (m: Mention<P>) => {
    const lead = leadOf(m);
    if (/\bmi (cartera|area)( es| de)?( la| el)?$/.test(lead)) return true;
    if (PORTFOLIO_MARK.test(lead) && !(job && ADVISOR_MARK.test(lead))) return true;
    if (opts.human && !job && ADVISORS_MARK.test(lead)) return true;
    return correction && /\b(es|era|sino|seria)$/.test(lead);
  };
  const live = found.filter((m) => !negated(m) && !yesAt(m.at));
  if (live.length === 0) return undefined;
  const kinds = (list: Mention<P>[]) => new Set(list.map((m) => m.p.key)).size;
  const coordinated = live.some((a, i) => live.slice(i + 1).some((b) => b.p.key !== a.p.key
    && words.slice(a.at + a.size, b.at).every((w) => COORDINATION.has(w))));
  if (coordinated && !correction) return undefined;
  const explicit = live.filter(marked);
  if (explicit.length > 0) {
    if (kinds(explicit) === 1 || correction) return { portfolio: explicit.at(-1)!.p, explicit: true, corrected: correction };
    return undefined;
  }
  if (correction) {
    const fixed = live.find(isBare);
    if (fixed) return { portfolio: fixed.p, explicit: true, corrected: true };
  }
  if (!asked) return undefined;
  if (asked === 'bare') {
    const m = live.find((x) => isBare(x) && ![...distinctOf(x)].every((w) => YES_WORDS.has(w)));
    return m ? { portfolio: m.p, explicit: false } : undefined;
  }
  const clear = live.filter((m) => !ambiguous(m));
  if (clear.length > 0) return kinds(clear) === 1 ? { portfolio: clear[0].p, explicit: false } : undefined;
  const m = live.find(isBare);
  return m ? { portfolio: m.p, explicit: false } : undefined;
}

/* ---------- nombre ---------- */

const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los']);
/** Lo que sigue a "de" en nombres y apellidos compuestos ("Juan de Dios", "María del Carmen", "José de la Cruz", "de la Hoz"). */
const PARTICLE_NAMES = new Set(['dios', 'jesus', 'pilar', 'carmen', 'rosario', 'mar', 'cruz', 'luz', 'paz', 'socorro', 'fatima', 'lourdes', 'angeles',
  'mercedes', 'dolores', 'fe', 'hoz', 'rosa', 'torre', 'ossa', 'espriella', 'vega', 'pava', 'cuesta']);
const LETTERS = /^[a-záéíóúüñ'-]+$/i;
const isNoise = (w: string) => /^(ja|je|ji|jo|ha|he|ka|js|xd)+$/.test(w) || /(.)\1\1/.test(w) || /[bcdfghjklmnpqrstvwxz]{4,}/.test(w)
  || /^(u+y+|a+y+|u+f+|m+h*|a+h+|e+h+|o+h+|u+h+|u+j+u*m*)$/.test(w);
/** Terminaciones de palabras comunes que casi nunca son un nombre de pila ("Obligatorio", "Financiera", "Presencial"). */
const NOT_NAME_ENDING = /(orio|oria|ble|mente|cion|sion|dad|tad|ismo|ista|oso|osa|ado|ada|ido|ida|ando|iendo|aje|ante|ente|ivo|iva|ico|ica|miento|anza|encia|ancia|ario|aria|eria|ero|era|ura|cial|tual|ional)$/;
const titleCase = (words: string[]) =>
  words.map((w) => (PARTICLES.has(normalize(w)) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
const capitalized = (w: string) => /^[A-ZÁÉÍÓÚÑ]/.test(w);
const clean = (piece: string) => piece.replace(/^[¿¡"'(]+|[,.;:!?)"']+$/g, '');

/**
 * Una palabra que puede ser un nombre aunque no esté en las listas ("Yurley", "wilmar", "Duberney"): no es una
 * palabra común ni su plural, ni un lugar, ni una palabra del sitio, ni parece un sustantivo ("Obligatorio", "tarifas").
 */
function looksLikeName(w: string, stop?: Set<string>): boolean {
  if (FIRST_NAMES.has(w) || SURNAMES.has(w)) return true;
  if (w.length < 3 || w.length > 14 || isCommonWord(w) || PLACES.has(w) || stop?.has(w) || isNoise(w) || !/[aeiouy]/.test(w)) return false;
  // Un plural ("convenios", "tarifas"); Carlos, Andrés o Marcos están en la lista. En -is o -ys casi nunca es un plural
  // sino un nombre ("Yarlenis", "Leidys"), salvo las palabras en -itis ("gastritis").
  if (w.length > 4 && w.endsWith('s') && (!/(is|ys)$/.test(w) || /itis$/.test(w))) return false;
  return !NOT_NAME_ENDING.test(w);
}

/**
 * "linda", "mi reina", "princesa", "pastor" en minúscula: un apelativo o un oficio, no el nombre ("Linda" o "Pastor
 * Hernández" sí pueden serlo).
 */
const NOT_NAME_ALONE = (w: string) => ENDEARMENTS.has(w) || w === 'pastor';
const endearmentOnly = (s: string) => {
  const ws = s.trim().split(/\s+/).map(clean).filter(Boolean);
  return ws.length > 0 && ws.length <= 3 && !ws.some(capitalized)
    && ws.some((w) => NOT_NAME_ALONE(normalize(w))) && ws.every((w) => NOT_NAME_ALONE(normalize(w)) || ['mi', 'mis'].includes(normalize(w)));
};
/** Tras "soy", un nombre que también describe a la persona ("soy franco", "soy clara", "soy pastora", "soy linda"). */
const describes = (w: string) => DESCRIPTIVE_NAMES.has(w) || ENDEARMENTS.has(w);

/** "Dr. Juan Pérez", "la señora Gloria Pérez", "el doctor Pedro Gómez": el tratamiento se quita antes de leer el nombre. */
const LEAD_TITLE = /^\s*(?:(?:el|la)\s+)?(?:(?:se[ñn]or(?:a|ita)?|doctor(?:a)?|dr|dra|sr|sra|srta|ing|ingenier[oa]|lic|licenciad[oa]|prof|profesor(?:a)?|don|do[ñn]a|abg|abogad[oa])\.?\s+)+/iu;

/**
 * Lee un nombre al inicio de `text`: corta en la primera palabra que no puede ser parte de un nombre.
 * - Un apellido conocido sigue el nombre aunque sea también una palabra ("Carlos Mora"), salvo que vaya en minúscula y
 *   siga la frase ("soy juan bueno quería saber" → "Juan").
 * - Un nombre de pila conocido gana a una palabra común ("Leo", "Domingo"; ver looseName para "domingo te los mando").
 * - Tras "de" solo sigue un nombre o apellido ("María del Pilar", "Ana de León"), no una marca ni un lugar ("Laura de
 *   Ecopetrol", "Carlos de Bello" → "Laura", "Carlos").
 * - Un cargo al inicio ("Asistente Administrativa") no es un nombre.
 */
function readName(text: string, stop?: Set<string>): string[] {
  const out: string[] = [];
  let role = false;
  let afterParticle = false;
  const pieces = text.replace(LEAD_TITLE, '').trim().split(/\s+/);
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const w = clean(piece);
    if (!w || !LETTERS.test(w)) break;
    const nw = normalize(w);
    if (out.length === 0 && TITLES.has(nw)) {
      if (ROLE_TITLES.has(nw)) role = true;
      if (/[,;:!?]$/.test(piece)) break;
      continue;
    }
    if (PARTICLES.has(nw)) {
      if (out.length === 0) break;
      out.push(w);
      afterParticle = true;
      if (/[,.;:!?]$/.test(piece)) break;
      continue;
    }
    const surname = out.length > 0 && SURNAMES.has(nw);
    const known = FIRST_NAMES.has(nw) || surname;
    if (role && out.length === 0 && !known) break;
    if (afterParticle) {
      if (!(PARTICLE_NAMES.has(nw) || ((FIRST_NAMES.has(nw) || SURNAMES.has(nw)) && !PLACES.has(nw)))) break;
    } else if (!known) {
      if (nw.length < 2 || isCommonWord(nw) || PLACES.has(nw) || stop?.has(nw) || isNoise(nw)) break;
    } else if (surname && !FIRST_NAMES.has(nw) && isCommonWord(nw) && !capitalized(w) && !/[,.;:!?]$/.test(piece)) {
      const next = pieces[i + 1] ? normalize(clean(pieces[i + 1])) : '';
      if (next && !/^\d/.test(pieces[i + 1]) && !(FIRST_NAMES.has(next) || SURNAMES.has(next) || PARTICLES.has(next) || next === 'y' || next === 'e')) break;
    }
    out.push(w);
    afterParticle = false;
    if (/[,.;:!?]$/.test(piece) || out.length >= 6) break;
  }
  // "María del Pilar" sí; "Juan de" no: un nombre no termina en partícula y "la/los/las" solo van tras "de".
  while (out.length && PARTICLES.has(normalize(out.at(-1)!))) out.pop();
  for (let i = 1; i < out.length; i++) {
    if (['la', 'las', 'los'].includes(normalize(out[i])) && normalize(out[i - 1]) !== 'de') return out.slice(0, i);
  }
  return out;
}

const nameWords = (words: string[]) => words.filter((w) => !PARTICLES.has(normalize(w)));
const finish = (words: string[]): string | null => {
  const name = titleCase(words);
  return words.length > 0 && name.length >= 2 && name.length <= 60 ? name : null;
};
/** Dónde termina el nombre leído dentro de `text` (para ver qué sigue después). */
const endOf = (text: string, words: string[]) => {
  let end = 0;
  for (const w of words) end = text.indexOf(w, end) + w.length;
  return end;
};

/** Lo que puede seguir a un nombre en su tramo sin que deje de ser solo el nombre ("Juan Pérez y mi cédula es…"). */
const TAIL_OK = new Set(`y e mi mis el la los las de del es son con numero cedula documento cc c identificacion identificado identificada nit pasaporte
  tarjeta identidad ciudadania extranjeria gracias muchas por favor porfa si ok listo aqui este esta ese esa datos nombre completo apellido apellidos`.split(/\s+/));
/** Palabras que unen el nombre con el resto de la frase ("Juan Pérez y necesito…", "soy Yurany de Cali"). */
const CONNECTORS = new Set(['y', 'e', 'pero', 'porque', 'que', 'pues', 'entonces', 'para', 'con', 'de', 'del']);

const EXPLICIT_RE = /(?:^|[^\p{L}])(me llamo|mi nombre completo es|mi nombre es|mi nombre:|nombre completo:|nombre:|mi nombre|soy|le habla|te habla|les habla|con usted habla|habla con|hablas con|habla|le escribe|te escribe|les escribe|me dicen|me conocen como|me puedes decir|me puede decir|me pueden decir|puedes decirme|puede decirme|ll[aá]mame|ll[aá]meme)\s*[:,]?\s+/giu;
const STRONG = /^(me llamo|mi nombre completo es|mi nombre es|mi nombre:|nombre completo:|nombre:|mi nombre)$/i;

/**
 * Nombre dicho de forma explícita en cualquier parte del mensaje: "te digo que mi nombre es Juan Esteban".
 * Con "soy …", "habla …" o "le escribe …" (más ambiguos: "soy colombiano", "soy víctima") solo cuenta un nombre de
 * pila conocido, uno con apellido conocido, o uno con mayúscula o pedido por el bot (`asked`, "soy wilmar") que no
 * siga con más frase. "No me llamo X" o "yo no soy X" no cuentan; "no, me llamo Y" sí (es una corrección).
 */
export function explicitName(message: string, _askedName = false): string | null {
  return explicitNameOf(message)?.name ?? null;
}

/**
 * `asked`: el bot pidió el nombre. Uno poco común en minúscula tras "soy" ("soy wilmar") cuenta solo si pidió solo el
 * nombre (`onlyName`) o si viene con el documento (`withDocument`): "soy emprendedora" o "soy sobrina del titular" no.
 */
function explicitNameOf(
  message: string, opts: { stop?: Set<string>; asked?: boolean; onlyName?: boolean; withDocument?: boolean } = {},
): { name: string; strong: boolean } | null {
  let best: { name: string; strong: boolean } | null = null;
  for (const m of message.matchAll(EXPLICIT_RE)) {
    const start = m.index! + m[0].indexOf(m[1]);
    const before = message.slice(0, start);
    // "No me llamo…", "yo no soy…" no cuentan; "no, me llamo Andrés" sí (corrige).
    if (/\bno\s+$/i.test(before)) continue;
    // "Le soy franco", "te soy clara", "les soy sincero": una expresión, no el nombre.
    if (/^soy$/i.test(m[1]) && /(?:^|[^\p{L}])(le|te|les|se|os)\s+$/iu.test(before)) continue;
    const after = message.slice(m.index! + m[0].length);
    const words = readName(after, opts.stop);
    const core = nameWords(words);
    if (core.length === 0) continue;
    const strong = STRONG.test(m[1].toLowerCase());
    const norm = core.map((w) => normalize(w));
    const tail = normalize(after.slice(endOf(after, words)).split(/[,;.!?:\n]/)[0]).split(' ').filter(Boolean);
    const settled = tail.every((w) => TAIL_OK.has(w)) || CONNECTORS.has(tail[0]);
    // "Soy franco, no puedo pagar", "soy clara con usted", "soy linda": un nombre que también es palabra cuenta con
    // mayúscula ("soy Franco") o con apellido ("soy franco pérez").
    const firstOk = FIRST_NAMES.has(norm[0]) && (!describes(norm[0]) || capitalized(core[0]));
    const known = firstOk || norm.slice(1).some((w) => SURNAMES.has(w) || FIRST_NAMES.has(w));
    const capsLike = capitalized(core[0]) && looksLikeName(norm[0], opts.stop);
    const askedLike = !!opts.asked && !!(opts.onlyName || opts.withDocument) && norm.every((w) => looksLikeName(w, opts.stop))
      && !(core.length === 1 && describes(norm[0]) && !capitalized(core[0]));
    if (!strong && !(known || ((capsLike || askedLike) && settled))) continue;
    const name = finish(words);
    if (!name) continue;
    // El dicho con "me llamo / mi nombre es" gana a un "soy"; entre iguales, el último (corrige al anterior).
    if (!best || strong || !best.strong) best = { name, strong };
  }
  return best;
}

/**
 * "No es Pedro, es Juan Gómez", "mi nombre no es Pedro, es Juan", "no me llamo Pedro sino Juan", "no, es Juan Gómez",
 * "me equivoqué de nombre, es Juan". "No soy Juan Pérez" o "no me llamo Pedro" solos niegan: no traen un nombre.
 */
const NAME_FIX = /(?:^|[^\p{L}])(?:(?:mi nombre )?no es [^,.;:!?]{2,40}?|(?:yo )?no (?:me llamo|soy) [^,.;:!?]{2,40}?|no\s*[,;:.!]|me equivoqu[eé](?: de nombre| con el nombre| en el nombre)?|perd[oó]n|disculp[ae])\s*[,;:.]?\s*(?:es|era|sino|mi nombre es|me llamo|soy)\s+(?<rest>[^,.;:!?\n]+)/iu;
/** "No me llamo Pedro", "yo no soy Juan Pérez", "mi nombre no es Pedro": el nombre que niega (normalizado). */
const NAME_DENIAL = /(?:^|[^\p{L}])(?:(?:yo )?no me llamo|(?:yo )?no soy|mi nombre no es|ese no es mi nombre,?)\s+(?<denied>[\p{L}]+(?:\s+[\p{L}]+)?)/iu;
export function deniedName(message: string): string | null {
  const m = message.match(NAME_DENIAL)?.groups?.denied;
  return m ? normalize(m) : null;
}
function nameCorrection(message: string, stop?: Set<string>): string | null {
  const rest = message.match(NAME_FIX)?.groups?.rest;
  if (!rest) return null;
  const words = readName(rest, stop);
  const core = nameWords(words);
  if (core.length === 0) return null;
  const norm = core.map((w) => normalize(w));
  const evidence = FIRST_NAMES.has(norm[0]) || norm.slice(1).some((w) => SURNAMES.has(w) || FIRST_NAMES.has(w))
    || (capitalized(core[0]) && looksLikeName(norm[0], stop));
  return evidence ? finish(words) : null;
}

/** "Pedro no, Juan Gómez", "no Pedro, Juan Gómez", "no, Juan Gómez": cambia el nombre guardado por otro. */
const NAME_SWAP = /^\s*(?:(?<old>[\p{L}]+(?:\s+[\p{L}]+)?)\s+no|no(?:\s+(?<old2>[\p{L}]+(?:\s+[\p{L}]+)?))?)\s*[,;:.!]+\s*(?<rest>[^,.;:!?\n]+?)[\s.!]*$/iu;
function nameSwap(message: string, saved: string | null | undefined, stop?: Set<string>): string | null {
  if (!saved) return null;
  const m = message.match(NAME_SWAP)?.groups;
  if (!m) return null;
  const old = normalize(m.old ?? m.old2 ?? '');
  // El nombre que niega debe ser el guardado ("Pedro no, …" con "Pedro Gómez" guardado).
  if (old && !normalize(saved).split(' ').includes(old.split(' ')[0])) return null;
  const words = readName(m.rest, stop);
  const core = nameWords(words);
  if (core.length === 0 || normalize(m.rest.slice(endOf(m.rest, words))).trim()) return null;
  const norm = core.map((w) => normalize(w));
  if (normalize(saved) === norm.join(' ')) return null;
  const full = core.length >= 2 && (FIRST_NAMES.has(norm[0]) || core.every(capitalized)) && norm.every((w) => looksLikeName(w, stop));
  const single = !!old && core.length === 1 && capitalized(core[0]) && looksLikeName(norm[0], stop);
  return full || single ? finish(words) : null;
}

const LEAD_FILLER = /^(buenas tardes|buenas noches|buenos d[ií]as|buen d[ií]a|hola|buenas|bueno|claro que s[ií]|claro|listo|ok|okey|s[ií]|dale|pues|gracias|vale|perfecto|mucho gusto|un gusto|con gusto|el gusto es m[ií]o|hablas con|habla con|habla|yo soy|soy|yo|mis datos completos son|mis datos son|mis datos|aqu[ií] van mis datos|aqu[ií] van|aqu[ií] est[aá]n|te (?:paso|doy|env[ií]o|dejo) mis datos|te los (?:paso|doy|env[ií]o|dejo)|ya te los doy|ya te lo dije|te lo dije|ya te dije|como te dije|le escribe|te escribe|les escribe|de parte de|mi nombre (?:y|con) (?:mi )?(?:c[eé]dula|documento)|mi nombre completo|nombre completo|nombre y apellidos?|mi nombre|nombre|datos)(?![\p{L}])[\s,.:]*/iu;
const DOC_PHRASE = /\b(identificad[oa] con|con (la )?(c\.?\s?c\.?|c[eé]dula)|c\.?\s?c\.?(\s*(no\.?|n[uú]mero|#))?|c[eé]dula( de ciudadan[ií]a| de extranjer[ií]a)?|documento( de identidad)?|tarjeta de identidad|n[uú]mero de (documento|c[eé]dula|identificaci[oó]n)|nit|identificaci[oó]n|pasaporte|ppt|pep)(?=[\s,.:;]|$)/gi;
/** "Dr." con punto: el punto no corta el mensaje en dos ("Dr. Carlos Mejía"). */
const ABBREV_TITLE_DOT = /(?<![\p{L}])(dr|dra|sr|sra|srta|ing|lic|prof|abg|arq)\.(?=\s|\p{L})/giu;
/** "Perdón, es Juan Pablo Pérez", "me equivoqué: …": la muletilla de la corrección no es parte del nombre. */
const CORRECTION_LEAD = /^[\s,.;:]*(perd[oó]n[ae]?|disculp[ae]|me equivoqu[eé]|me confund[ií]|corrijo|correcci[oó]n|mejor dicho|quise decir)(?![\p{L}])[\s,.;:]*(?:(?:el correcto|la correcta|el bueno|el nombre|mi nombre)\s+(?:es|era)|es|era|son)?(?![\p{L}])[\s,.:;]*/iu;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripLead = (s: string) => {
  let x = s.trim();
  for (let i = 0; i < 4 && LEAD_FILLER.test(x); i++) x = x.replace(LEAD_FILLER, '').trim();
  return x;
};
/** Un tramo que no dice nada propio ("mis datos son", "la de", "cliente de", "#", "ya te lo dije"). */
const fillerOnly = (s: string) => normalize(s).split(' ').filter(Boolean).every((w) => isCommonWord(w) || TAIL_OK.has(w));

/**
 * Qué estaba pasando cuando llegó un nombre suelto: 'name' (preguntó el nombre), 'handoff' (pidió los datos para el
 * asesor), 'offer' (ofreció un asesor), 'queue' (ya espera), 'correction' (corrige un dato) o 'data' (dio sus datos
 * sin que se los pidieran: "Juan Pérez 1020304050").
 */
type NameMode = 'name' | 'handoff' | 'offer' | 'queue' | 'correction' | 'data';

/** Un saludo o una cortesía que sigue al nombre ("Ana López mucho gusto", "Juan buenas noches", "Carlos, para servirle"). */
const GREETING_AFTER = /^(mucho gusto|un gusto|un placer|encantad[oa]|gracias|muchas gracias|mil gracias|buenas tardes|buenas noches|buenos dias|buen dia|buenas|hola|saludos|para servirle|para servirte|a la orden|a sus ordenes|a tu orden|igualmente|bendiciones|feliz (dia|tarde|noche))\b/;
/** "Ana López, mucho gusto", "Carlos Gómez, para servirle": se presenta con un nombre y una cortesía. */
const SELF_INTRO = /^[a-z]+(?: [a-z]+){1,4} (mucho gusto|un gusto|un placer|encantad[oa]|para servirle|para servirte|a la orden|a sus ordenes)( de (saludarte|saludarlo|saludarla|conocerte))?$/;
/** Lo que sigue a un nombre completo dado sin que se lo pidieran ("Juan Pérez quiero saber mi saldo, cc …"). */
const SELF_START = new Set(['quiero', 'quisiera', 'queria', 'necesito', 'necesitaba', 'tengo', 'tenia', 'debo', 'estoy', 'solicito', 'deseo',
  'requiero', 'busco', 'vivo', 'escribo', 'mi', 'mis', 'y', 'con', 'identificado', 'identificada', 'cedula', 'cc', 'documento', 'numero']);
/** "La cédula correcta es…", "mi número completo es…": la palabra entre el documento y el "es" lo describe (no es un nombre). */
const DOC_ADJECTIVE = /(?<![\p{L}])(c[eé]dula|documento|n[uú]mero|identificaci[oó]n|cc)\s+[\p{L}]+\s+(?=(?:es|era|ser[ií]a)(?![\p{L}]))/giu;
/** Palabras que, con mayúscula tras un nombre ("Pedro Asesor", "Juan Bien"), no son su apellido. */
const NOT_SURNAME_WORDS = new Set(`bien mal aqui alla aca ahora ya mas tambien asesor asesora cliente usuario usuaria titular deudor deudora
  cedula documento numero nombre cartera gracias favor porfa tarde tardes noche noches dia dias manana luego despues hoy ayer saludos
  bendiciones gusto placer`.split(/\s+/));
/** "¿Cómo estás?", "¿qué tal?", "bien, ¿y tú?": un saludo que pregunta; no es una pregunta del tema ni el nombre. */
const SOCIAL_ONLY = /^(?:y )?(?:(?:tu|usted|ustedes) )?(?:como (?:estas|esta|estan|vas|va|te va|le va|les va|amaneciste|amanecio|amanecieron|ha estado|has estado|han estado|te ha ido|le ha ido)|que tal|que mas|que hubo|quiubo|todo bien|(?:muy )?bien(?: gracias)?(?: y (?:tu|usted))?|y (?:tu|usted))(?: (?:tu|usted|ustedes|todo bien|por alla|por aca))?$/;
/**
 * Lo que sigue al nombre cuando habla de otra persona: "Carlos Mora me dijo que les escribiera", "Ana Ruiz es mi
 * mamá", "Pedro Gómez el de cartera me llamó", "Jorge Pérez me recomendó este chat".
 */
const OTHER_PERSON = /^(?:(?:me|nos|le|les|te) (?:dijo|dijeron|pidio|pidieron|recomendo|recomendaron|mando|mandaron|remitio|remitieron|escribio|escribieron|atendio|atendieron|dio|dieron|hablo|hablaron|conto|contaron|envio|enviaron|refirio|indico|indicaron|sugirio|aconsejo|explico|comento|informo|contacto|contactaron|marco|cobro|cobraron|ayudo|vendio|dejo|colgo|cito|busco|puso|presto|paso|llamaron|dice|dicen|pide|piden|recomienda|manda|mandan)|(?:es|era|fue) (?:mi|el|la|un|una|su)(?! nombre\b)|(?:el|la) de|de (?:cartera|la empresa|ustedes)|quien|que me)\b/;

/**
 * Nombre en una respuesta, sin "me llamo" ("Juan Pérez", "Juan Pérez 1002003 general", "Con Pedro", "Andrés, mucho
 * gusto", "wilmar gómez", "mis datos son Juan Pérez cc …"). Se lee tramo por tramo (los separan comas, puntos, números
 * y las palabras del documento); los tramos de relleno ("mis datos son", "la de", "ya te lo dije") se saltan.
 * Lo que sigue al nombre en su tramo decide si es un nombre:
 * - nada, o lo que acompaña a los datos ("y mi cédula es…"): sí;
 * - nombre y apellido conocidos seguidos de otra frase ("Juan Pérez quiero saber mi saldo", "Ana López mucho gusto"):
 *   sí (sin que se lo pidieran, solo si la frase es suya: "Juan Pérez quiero…, cc …");
 * - un nombre de pila conocido seguido de un saludo ("Carlos mucho gusto"): sí; de otra frase ("domingo te los mando",
 *   "Carlos me dijo…", "cuéntame un chiste"): no.
 * Según el momento:
 * - nombre y apellido (o dos palabras con mayúscula que parecen nombre): siempre;
 * - un nombre de pila conocido ("Juan", "Leo", "Domingo" con mayúscula, o "rosa" si es todo el mensaje): salvo en 'data';
 * - uno poco común ("Yurley", "ludwing"): si el bot pidió solo el nombre; si pidió el nombre y el documento, con el
 *   documento en el mismo mensaje, si solo faltaba el nombre, o con mayúscula si es todo el mensaje ("Ludwing").
 * Nunca una pregunta, una negativa ("prefiero no decirlo"), una palabra del chat, del negocio, una marca o una ciudad.
 */
function looseName(
  message: string, terms: string[], mode: NameMode,
  opts: { stop?: Set<string>; onlyName?: boolean; withDocument?: boolean; portfolioMissing?: boolean },
): string | null {
  let t = message.replace(ABBREV_TITLE_DOT, '$1 ').replace(CORRECTION_LEAD, '').replace(DOC_ADJECTIVE, '$1 ');
  t = t.replace(/(?<![\p{L}\d])[A-Za-z]{1,3}-?\d{5,9}(?!\d)/gu, ' , '); // pasaporte con letras ("AB123456")
  t = t.replace(/\+?\d[\d.,'’\s-]*/g, ' , ');
  for (const term of terms) if (term.trim()) t = t.replace(new RegExp(`(?<![\\p{L}])${escapeRe(term)}(?![\\p{L}])`, 'giu'), ' , ');
  t = t.replace(DOC_PHRASE, ' , ');
  const segs: { body: string; question: boolean }[] = [];
  for (const m of t.matchAll(/([^,;.!?¿¡:\n]*)([,;.!?:\n]|$)/g)) {
    if (m[0] === '') break;
    if (!m[1].trim()) continue;
    segs.push({ body: stripLead(m[1]), question: m[2] === '?' || /¿\s*$/.test(t.slice(0, m.index!)) });
  }
  const refusal = (s: string) => NOT_A_NAME_RE.test(normalize(s));
  const social = (s: { body: string }) => !!s.body && SOCIAL_ONLY.test(normalize(s.body));
  // "ok linda, Juan Pérez …", "listo mi reina, …": el apelativo es relleno.
  const content = (s: { body: string }) => !!s.body && !fillerOnly(s.body) && !refusal(s.body) && !endearmentOnly(s.body) && !social(s);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    // "Hola, ¿cómo estás? Luisa": la pregunta del saludo no corta la lectura.
    if (social(seg)) continue;
    if (seg.question) return null;
    let body = seg.body;
    if (!body || refusal(body) || endearmentOnly(body)) continue;
    // "Con Pedro", "con Juan Pérez, cc …": con quién habla el bot.
    body = body.replace(/^con(?![\p{L}])\s+/iu, '');
    const words = readName(body, opts.stop);
    const core = nameWords(words);
    if (core.length === 0) {
      if (fillerOnly(body)) continue;
      return null;
    }
    const rawTail = body.slice(endOf(body, words)).trim();
    const tail = normalize(rawTail).split(' ').filter(Boolean);
    // "Juan de Pereira", "Laura de Ecopetrol": de dónde es o de qué empresa viene no le quita el nombre.
    const origin = ['de', 'del', 'desde'].includes(tail[0]) && tail.length <= 3
      && tail.slice(1).every((w) => PLACES.has(w) || isCommonWord(w) || !!opts.stop?.has(w) || TAIL_OK.has(w));
    const settled = tail.every((w) => TAIL_OK.has(w)) || origin;
    const alone = !segs.some((s, k) => k !== i && content(s));
    /** El mensaje es solo el nombre (y, si acaso, el documento): "rosa", "luz dary", "Ludwing". */
    const whole = alone && tail.length === 0;
    const greeting = GREETING_AFTER.test(tail.join(' '));
    const norm = core.map((w) => normalize(w));
    const knownFirst = FIRST_NAMES.has(norm[0]);
    const withSurname = norm.slice(1).some((w) => SURNAMES.has(w) || FIRST_NAMES.has(w));
    const nameLike = norm.every((w) => looksLikeName(w, opts.stop));
    const full = (withSurname && (knownFirst || nameLike)) || (core.length >= 2 && core.every(capitalized) && nameLike);
    const known = knownFirst && (!WORD_NAMES.has(norm[0]) || capitalized(core[0]));
    const loose = (knownFirst || nameLike) && core.length <= 3;
    const asking = mode === 'name' || mode === 'handoff';
    // "Carlos Mora me dijo que les escribiera": el nombre es de otra persona.
    const otherPerson = OTHER_PERSON.test(tail.join(' ')) || /^me\s+llamó/iu.test(rawTail) || (tail[0] === 'me' && tail[1] === 'llamo' && tail.length > 2);
    // "Laura Prueba", "Carlos Alemán", "Ana Claro" (todo el mensaje, con mayúscula, cuando el bot pide el nombre): la
    // palabra común que sigue es su apellido; una marca o una ciudad no ("Ana Claro" → "Ana").
    const tailWord = clean(rawTail.split(/\s+/)[0] ?? '');
    if (!settled && tail.length === 1 && alone && asking && (knownFirst || nameLike) && core.length <= 3 && capitalized(tailWord)
      && LETTERS.test(tailWord) && !GREETING_AFTER.test(tail[0]) && !CONNECTORS.has(tail[0]) && !OTHER_PERSON.test(tail[0])
      && !NOT_SURNAME_WORDS.has(tail[0]) && !TITLES.has(tail[0])) {
      const brandOrPlace = COMMON_BRAND(tail[0]) || PLACES.has(tail[0]) || !!opts.stop?.has(tail[0]) || ENDEARMENTS.has(tail[0]);
      if (core.length === 1 && PLACES.has(norm[0]) && !FIRST_NAMES.has(norm[0])) return null;
      return finish(brandOrPlace ? words : [...words, tailWord]);
    }
    let ok: boolean;
    if (!settled) {
      ok = full && !otherPerson
        ? (mode === 'data' ? i === 0 && knownFirst && withSurname && SELF_START.has(tail[0]) : true)
        : known && greeting && mode !== 'data';
    } else if (full) ok = mode !== 'data' || alone;
    else if (known) ok = mode !== 'data';
    else if (knownFirst && whole && asking) ok = true;
    else if (loose && alone) {
      ok = mode === 'name' || (mode === 'handoff' && ((!!(opts.onlyName || opts.withDocument) && !!(opts.onlyName || !opts.portfolioMissing))
        || (whole && core.every(capitalized))));
    } else ok = false;
    // Una palabra sola que es una ciudad ("Pasto", "Pereira") no es el nombre.
    if (ok && core.length === 1 && PLACES.has(norm[0]) && !FIRST_NAMES.has(norm[0])) ok = false;
    return ok ? finish(words) : null;
  }
  return null;
}

/** "Prefiero no decirlo", "anónimo", "no te lo voy a decir": se niega a dar el nombre. */
const NOT_A_NAME_RE = /\b(prefiero no|preferiria no|prefiero reservar\w*|no (quiero|deseo|puedo) (dar|decir|decirte|decirlo|compartir)|no (te |le |les )?(lo |la )?(voy a )?(doy|dare|digo|dire|dar|decir)|no lo (digo|doy)|anonim[oa]|confidencial|secreto|reservad[oa]|para que (quieres|necesitas|quiere|necesita)|(que|no) (te|le|les) (importa|incumbe)|no (te|le|les) (interesa|incumbe)|no tengo (por que|porque) (decir|decirte|decirle|darte|darle|dar)|(eso )?es (personal|privado)|no es (tu|su) (asunto|problema))\b/;

/* ---------- todo junto ---------- */

/** Saludos y cortesías que acompañan los datos ("hola, ¿qué tal? soy Luisa", "Carlos Gómez, para servirle"): no son un tema. */
const SOCIAL_WORDS = /\b(que tal|que mas|que hubo|quiubo|como (estas|esta|estan|vas|va|te va|le va|les va|amaneciste|amanecio|amanecieron|ha estado|has estado|han estado)|todo bien|para servirle|para servirte|a la orden|a sus ordenes|a tu orden|un placer|encantad[oa]|igualmente|bendiciones|(muy )?bien( gracias)?( y (tu|usted))?|y (tu|usted)|(buen|buena|buenos|buenas|feliz|lindo|linda|bonito|bonita|excelente|bendecido|bendecida) (dia|dias|tarde|tardes|noche|noches))\b/g;
const DATA_WORDS = /\b(me llamo|mi nombre completo es|mi nombre es|mi nombre|soy|nombre|numero|de documento|documento|tarjeta de identidad|tarjeta|identidad|cedula de ciudadania|cedula de extranjeria|ciudadania|extranjeria|registro civil|cedula|cc|c c|identificacion|identificado|identificada|mi cartera es|cartera|area|es|mi|y|de|el|la|te|estoy|diciendo|dije|que|ya|te lo|lo|digo|son|mis|datos|aqui|van|paso|escribe|completo|apellido|apellidos|cliente|esta|este|por favor|gracias|muchas|listo|ok|hola|buenas|buenos|dias|tardes|noches|mucho gusto|gusto|un|con|perdon|disculpa|disculpe|me equivoque|me confundi|corrijo|el correcto|la correcta|el bueno|mejor dicho|quise decir|era|es correcto|correcto|si|no|bueno|claro|pues|porfa|favor|saludos|senor|senora|doctor|doctora|le habla|habla|le|les)\b/g;
/** Lo que queda junto a los datos y sí es un tema: "Andrés, ¿y el correo?", "me llamo Ana, el teléfono?". */
const CONTENT_HINT = /\b(correo|correos|email|mail|telefono|telefonos|linea|lineas|whatsapp|direccion|direcciones|ubicacion|sede|sedes|oficina|oficinas|horario|horarios|precio|precios|costo|costos|tarifa|tarifas|servicio|servicios|vacante|vacantes|empleo|trabajo|pagina|link|nit)\b/;
export const asksForInfo = (text: string) => CONTENT_HINT.test(normalize(text));

/**
 * Datos presentes en el mensaje. El nombre suelto (sin "me llamo") solo cuenta si el bot lo pidió, si el visitante lo
 * corrige, o si el mensaje es solo su nombre completo y su documento ("Juan Pérez 1020304050"). Un cierre ("gracias,
 * feliz noche") o la respuesta a la oferta de un asesor ("sí", "simón") no traen un nombre. La cartera solo se busca
 * si hay varias (con una sola no hay nada que elegir).
 */
export function extractVisitorData<P extends PortfolioTerms>(message: string, portfolios: P[], context?: CaptureContext | boolean | 'weak'): Extracted {
  const ctx = toContext(context);
  const n = normalize(message);
  const missing = ctx.missing ?? ['name'];
  const correction = CORRECTION_RE.test(n);
  const collecting = ctx.asked === 'handoff' || ctx.asked === 'queue';
  const doc = findDocument(message, ctx.companyNumbers, { askedDocument: collecting && missing.includes('document'), correcting: correction });
  const terms = portfolios.flatMap((p) => termsOf(p));
  const stop = ctx.siteWords;
  // `nameLoose`: el nombre guardado es una palabra suelta poco común; un nombre completo claro lo reemplaza.
  const nameAsked = ctx.asked === 'name' || ctx.asked === 'offer' || (collecting && (missing.includes('name') || !!ctx.nameLoose));
  const onlyName = ctx.asked === 'name' || (ctx.asked === 'handoff' && missing.length === 1 && missing[0] === 'name');
  const explicit = explicitNameOf(message, {
    stop, asked: ctx.asked === 'name' || (ctx.asked === 'handoff' && missing.includes('name')), onlyName, withDocument: !!doc,
  });
  let name = explicit?.name ?? null;
  const fixed = name ? null : (nameCorrection(message, stop) ?? nameSwap(message, ctx.savedName, stop));
  name ??= fixed;
  const analysis = analyze(message);
  // Un cierre ("gracias, feliz noche"), un saludo ("aló", "hey") o la respuesta a la oferta ("sí", "simón") no traen un nombre.
  // Un sí o un no ("simón", "nel", "ok", "nel, gracias") tampoco: ante la duda no se guarda.
  const answering = analysis.intent === 'thanks' || analysis.intent === 'greeting'
    || ((ctx.asked === 'offer' || !n.includes(' ') || isPureYesNo(message)) && yesNo(message) !== null);
  if (!name && !answering) {
    const common = { stop, onlyName, withDocument: !!doc, portfolioMissing: missing.includes('portfolio') };
    // "Disculpa, la cédula correcta es 1020304051": corrige el documento; de ahí solo sale un nombre claro.
    if (ctx.asked && nameAsked) name = looseName(message, terms, correction && doc ? 'correction' : ctx.asked, common);
    else if (correction) name = looseName(message, terms, 'correction', common);
    else if (!ctx.asked && doc) name = looseName(message, terms, 'data', common);
    else if (!ctx.asked && !ctx.savedName && SELF_INTRO.test(n)) {
      // "Ana López, mucho gusto": se presenta sin que se lo pidieran; cuenta un nombre completo.
      const intro = looseName(message, terms, 'name', common);
      if (intro && intro.split(' ').length >= 2) name = intro;
    }
  }
  const askedPortfolio = collecting && missing.includes('portfolio');
  const consumed = new Set(name ? normalize(name).split(' ') : []);
  const portfolioMode = !askedPortfolio ? false : ctx.asked === 'queue' ? 'bare' as const : true;
  const stated = portfolios.length > 0
    ? statedPortfolio(message, portfolios, portfolioMode, consumed, {
      // En la cola el bot no está preguntando la cartera: un "claro" ahí es un acuse.
      onlyPortfolio: ctx.asked === 'handoff' && missing.length === 1 && missing[0] === 'portfolio',
      human: analysis.intent === 'human' || analysis.intent === 'sensitive',
    })
    : undefined;
  const portfolio = stated?.portfolio;
  const phone = findPhone(message, ctx.companyNumbers);
  // "No, la de Offcorss", "Flamingo no, Offcorss": también corrige (la cartera).
  const corrected = correction || correctsWithPause(message) || !!stated?.corrected;

  // Lo que sobra sin los datos: decide si el mensaje traía además una pregunta o un tema.
  let rest = normalize(message.replace(/(?<![\p{L}\d])[A-Za-z]{1,3}-?\d{5,9}(?!\d)/gu, ' ').replace(/\+?\d[\d.,'’\s-]*/g, ' '));
  if (phone) rest = rest.replace(PHONE_PHRASE, ' ');
  // "No me llamo teléfono, me llamo Pedro": lo que niega no es un tema.
  if (name) rest = rest.replace(/\b(no me llamo|no soy|mi nombre no es)( \S+){1,2}?(?= me llamo| soy| mi nombre| sino| es\b|$)/g, ' ');
  if (name) for (const w of normalize(name).split(' ')) rest = rest.replace(new RegExp(`\\b${escapeRe(w)}\\b`, 'g'), ' ');
  rest = rest.replace(SOCIAL_WORDS, ' ');
  if (portfolio) {
    for (const term of termsOf(portfolio)) rest = rest.replace(normalize(term), ' ');
    for (const w of stems(portfolio.name)) rest = rest.replace(new RegExp(`\\b${escapeRe(w)}\\w*\\b`, 'g'), ' ');
  }
  rest = rest.replace(/\b(pasaporte|nit|ppt|pep)\b/g, ' ');
  // Lo mismo sin quitar las palabras de los datos: "Juan Pérez qué horario tienen" → "que horario tienen" (sí pregunta).
  const said = `${rest.replace(/\s+/g, ' ').trim()} `
    .replace(/^(?:(?:me llamo|mi nombre (?:completo )?es|mi nombre|soy|mi (?:numero de )?(?:cedula|documento)(?: es)?|cc|cedula|documento|y|e|hola|buenas|buenos dias|buenas tardes|buenas noches)\s+)+/, '')
    .trim();
  rest = rest.replace(DATA_WORDS, ' ').replace(/\s+/g, ' ').trim();

  return {
    phone, document: doc?.value, documentExplicit: !!doc?.explicit,
    portfolioKey: portfolio?.key, portfolioExplicit: !!stated?.explicit,
    name: name ?? undefined, nameExplicit: !!explicit || !!fixed || (correction && !!name), correction: corrected,
    asks: /[?¿]/.test(message),
    rest: doc || portfolio || name || phone ? rest : normalize(message),
    said: doc || portfolio || name || phone ? said : normalize(message),
  };
}

/**
 * El mensaje solo traía datos (de identificación o un número de contacto): nada que responder aparte de agradecerlos.
 * "Andrés, ¿y el correo?" o "me llamo Ana, el teléfono?" no: preguntan algo.
 */
export const onlyData = (x: Extracted) => {
  if (!(x.document || x.portfolioKey || x.name || x.phone)) return false;
  const words = x.rest.split(' ').filter((w) => w.length >= 3);
  if (CONTENT_HINT.test(x.rest) || (x.asks && words.length > 0)) return false;
  return words.length < 2;
};

/**
 * El mensaje sin los datos del visitante, para buscar en el sitio: "me llamo Ana, ¿qué servicios ofrecen?" →
 * "que servicios ofrecen" (y no la línea telefónica por "llamo"); "mi cédula es 123, ¿cuánto cuesta?" → "cuanto cuesta".
 */
export function withoutVisitorData(message: string): string {
  let t = message;
  // De atrás hacia adelante, para que las posiciones del mensaje original sigan valiendo.
  for (const m of [...message.matchAll(EXPLICIT_RE)].reverse()) {
    const from = m.index! + m[0].length;
    const words = readName(message.slice(from));
    if (nameWords(words).length === 0) continue;
    let end = from;
    for (const w of words) end = message.indexOf(w, end) + w.length;
    t = `${t.slice(0, m.index!)} ${t.slice(end)}`;
  }
  return normalize(
    t.replace(/(?<![\p{L}])mi (n[uú]mero de )?(c[eé]dula|documento|celular|tel[eé]fono|cel|whatsapp|n[uú]mero)( es)?(?![\p{L}])/giu, ' ')
      // "Soy cliente de Offcorss, ¿qué servicios ofrecen?": de quién es cliente no es lo que pregunta.
      .replace(/(?<![\p{L}])(soy|somos) (cliente|clientes|usuari[oa]s?|deudor(a|es)?|afiliad[oa]s?) (de|del) [\p{L}]+(?: [\p{L}]+)?(?=\s*[,.;:!?¿]|$)/giu, ' ')
      .replace(/\+?\d[\d.,'’\s-]*/g, ' '),
  );
}
