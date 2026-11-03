import { normalize } from '../utils/text';
import { HUMAN_RE, classify } from './intents';

/**
 * Captura de datos del visitante (nombre, documento y cartera) a partir de lo que escribe, en CUALQUIER mensaje y
 * en cualquier orden. Es determinística: no depende del modelo, así que funciona aunque la IA no esté disponible.
 */

export type DataField = 'name' | 'document' | 'portfolio';
export interface PortfolioTerms { key: string; name: string; aliases?: string[] | null }
export interface Extracted {
  document?: string;
  portfolioKey?: string;
  name?: string;
  /** El visitante dijo su nombre de forma explícita ("me llamo…", "mi nombre es…"): corrige uno anterior. */
  nameExplicit?: boolean;
  /** Lo que queda del mensaje sin los datos: si está vacío, el mensaje solo traía datos. */
  rest: string;
}

/* ---------- documento ---------- */

const DOC_WORDS = /\b(cedula|documento|identificacion|cc|c c|nit|pasaporte)\b/;
const PHONE_WORDS = /\b(celular|cel|telefono|tel|whatsapp|movil|contacto|llamar|llamen|llamenme)\b/;

/**
 * Documento de 5 a 15 dígitos; acepta separadores ("1.021.803.088", "1021 803 088"). No toma montos ("$1.500.000",
 * "500 mil pesos") ni un celular: si el mensaje habla de teléfono, solo cuenta el número que sigue a "cédula/documento".
 */
export function extractDocument(message: string): string | undefined {
  const n = normalize(message);
  const lead = (i: number) => normalize(message.slice(Math.max(0, i - 25), i));
  const found = [...message.matchAll(/\d[\d.\s-]{3,20}\d/g)]
    .map((m) => ({ i: m.index!, end: m.index! + m[0].length, digits: m[0].replace(/\D/g, '') }))
    .filter((m) => m.digits.length >= 5 && m.digits.length <= 15)
    // Un monto no es un documento.
    .filter((m) => !/\$\s*$/.test(message.slice(Math.max(0, m.i - 3), m.i)) && !/^(pesos|mil|millones|cop|usd)\b/.test(normalize(message.slice(m.end, m.end + 12))));
  if (found.length === 0) return undefined;
  const nearDoc = found.find((m) => DOC_WORDS.test(lead(m.i)));
  if (nearDoc) return nearDoc.digits;
  if (PHONE_WORDS.test(n)) return found.find((m) => !PHONE_WORDS.test(lead(m.i)) && DOC_WORDS.test(n))?.digits;
  return found[0].digits;
}

/* ---------- cartera ---------- */

const FILLER = new Set(['cartera', 'carteras', 'area', 'areas', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'mi', 'es', 'en', 'con', 'por', 'para']);
/** Raíz simple: "pruebas" y "prueba" cuentan igual; "creditos" y "credito" también. */
const stem = (w: string) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const stems = (s: string) => normalize(s).split(' ').filter((w) => w && !FILLER.has(w)).map(stem);

/**
 * Cartera mencionada en el mensaje por su clave, nombre o alias. Tolera plurales y palabras de relleno
 * ("mi cartera es cartera de prueba" encuentra "Cartera de pruebas"). Si varias coinciden, gana la más específica.
 */
export function matchPortfolio<P extends PortfolioTerms>(message: string, portfolios: P[]): P | undefined {
  const words = new Set(stems(message));
  let best: { p: P; size: number } | undefined;
  for (const p of portfolios) {
    for (const term of [p.key.replace(/[-_]/g, ' '), p.name, ...(p.aliases ?? [])]) {
      const t = stems(term);
      if (t.length === 0 || !t.every((w) => words.has(w))) continue;
      if (!best || t.length > best.size) best = { p, size: t.length };
    }
  }
  return best?.p;
}

/* ---------- nombre ---------- */

/** Palabras que cortan un nombre ("Juan Pérez y mi documento es…"). */
const NAME_STOP = new Set([
  'y', 'e', 'con', 'mi', 'numero', 'documento', 'cedula', 'cc', 'nit', 'cartera', 'area', 'tengo', 'quiero', 'necesito', 'para',
  'porque', 'pero', 'que', 'del', 'el', 'la', 'por', 'favor', 'gracias', 'identificacion', 'mis', 'datos', 'estoy', 'soy', 'de',
]);
/**
 * Lo que no es un nombre aunque llegue donde se esperaba uno: respuestas cortas ("ok", "sí", "gracias"), lo que
 * sigue a "soy" sin ser un nombre ("soy cliente", "soy de Bogotá", "soy colombiano") y palabras del propio chat.
 */
const NOT_A_NAME = new Set([
  'cliente', 'usuario', 'usuaria', 'el', 'la', 'un', 'una', 'de', 'del', 'nuevo', 'nueva', 'deudor', 'deudora', 'titular', 'estudiante',
  'abogado', 'abogada', 'persona', 'quien', 'yo', 'asesor', 'asesora', 'empresa', 'representante', 'propietario', 'propietaria', 'muy',
  'ok', 'okey', 'okay', 'si', 'no', 'listo', 'vale', 'gracias', 'bueno', 'buena', 'claro', 'dale', 'perfecto', 'excelente', 'genial', 'bien',
  'hola', 'buenas', 'buenos', 'nada', 'ninguno', 'ninguna', 'ayuda', 'informacion', 'pregunta', 'duda', 'humano', 'robot', 'bot', 'chao',
  'adios', 'ya', 'aja', 'mmm', 'hmm', 'test', 'prueba', 'pruebas', 'colombiano', 'colombiana', 'venezolano', 'venezolana', 'independiente',
  'empleado', 'empleada', 'pensionado', 'pensionada', 'comerciante', 'empresario', 'empresaria', 'interesado', 'interesada', 'codeudor',
  'codeudora', 'fiador', 'fiadora', 'familiar', 'hijo', 'hija', 'esposo', 'esposa', 'madre', 'padre', 'mama', 'papa', 'senor', 'senora',
  'don', 'dona', 'doctor', 'doctora', 'ingeniero', 'ingeniera', 'trabajador', 'trabajadora', 'otro', 'otra', 'igual', 'tambien', 'aqui',
  'por', 'favor', 'porfa', 'porfavor', 'hagale', 'me', 'parece', 'sip', 'nop', 'exacto', 'correcto', 'afirmativo', 'negativo', 'seguro',
  'obvio', 'entendido', 'vale', 'super', 'chevere', 'gracia',
]);
const LETTERS = /^[a-záéíóúüñ']+$/i;
const titleCase = (words: string[]) => words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const notAName = (w: string) => NOT_A_NAME.has(normalize(w));

/**
 * Nombre dicho de forma explícita en cualquier parte del mensaje: "te digo que mi nombre es Juan Esteban".
 * Con "soy …" (más ambiguo: "soy colombiano") solo cuenta si el bot pidió el nombre o el nombre viene con mayúscula.
 */
export function explicitName(message: string, askedName = false): string | null {
  const m = message.match(/\b(me llamo|mi nombre es|mi nombre:|mi nombre|soy)\s+(.+)/i);
  if (!m) return null;
  const words: string[] = [];
  for (const raw of m[2].split(/\s+/)) {
    const w = raw.replace(/[,.;:!?¡¿()"]+$/g, '');
    if (!w || !LETTERS.test(w) || NAME_STOP.has(normalize(w))) break;
    words.push(w);
    if (/[,.;:!?]$/.test(raw) || words.length === 4) break;
  }
  if (words.length === 0 || words.some(notAName)) return null;
  if (/^soy$/i.test(m[1]) && !askedName && !/^[A-ZÁÉÍÓÚÑ]/.test(words[0])) return null;
  const name = titleCase(words);
  return name.length >= 2 && name.length <= 60 ? name : null;
}

/**
 * Respuesta corta al "¿cómo te llamas?" ("Juan Pérez 1002003 general"): quita documento y cartera y toma lo que queda.
 * Solo se usa cuando el bot acaba de pedir el nombre, para no confundir una frase cualquiera con un nombre.
 */
export function nameFromReply(message: string, terms: string[] = []): string | null {
  if (/[?¿]/.test(message) || /^\s*(que|qué|quien|quién|como|cómo|cual|cuál|donde|dónde|cuando|cuándo|por qué|quiero|necesito|puedo|tienen|hola|buenas|gracias)\b/i.test(message)) return null;
  // "ok", "gracias", "quiero un asesor"… son respuestas o pedidos, nunca un nombre.
  if (classify(message.replace(/\d[\d.\s-]*/g, ' ')) !== 'other') return null;
  const explicit = explicitName(message, true);
  if (explicit) return explicit;
  let t = message.replace(/\d[\d.\s-]*/g, ' ');
  for (const term of terms) if (term) t = t.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  t = t.replace(/\b(me llamo|mi nombre es|mi nombre|soy|nombre|numero|número|de documento|documento|cedula|cédula|cc|mi cartera es|cartera|area|área|es|mi)\b/gi, ' ')
    .replace(/[,.;:!-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (HUMAN_RE.test(normalize(t))) return null;
  // El nombre son las primeras palabras; se corta en la primera que no lo es: "Juan Pérez con almacenes…" → "Juan Pérez".
  const words: string[] = [];
  for (const w of t.split(' ').filter(Boolean)) {
    if (NAME_STOP.has(normalize(w))) break;
    if (!LETTERS.test(w)) return null;
    words.push(w);
  }
  if (words.length === 0 || words.length > 4 || words.some(notAName)) return null;
  const name = titleCase(words);
  return name.length >= 2 && name.length <= 60 ? name : null;
}

/* ---------- todo junto ---------- */

const DATA_WORDS = /\b(me llamo|mi nombre es|mi nombre|soy|nombre|numero|de documento|documento|cedula|cc|identificacion|mi cartera es|cartera|area|es|mi|y|de|el|la|te|estoy|diciendo|dije|que|ya|te lo|lo|digo|son|mis|datos|aqui|esta|este|por favor|gracias|listo|ok)\b/g;

/**
 * Datos presentes en el mensaje. `askedName` indica que el bot acaba de pedir el nombre: solo entonces una respuesta
 * corta sin "me llamo…" se toma como nombre. Con 'weak' (el bot ofreció un asesor y el visitante responde con sus
 * datos: "Pedro Gómez 30000003") el nombre suelto solo cuenta si el mismo mensaje trae documento o cartera.
 */
export function extractVisitorData<P extends PortfolioTerms>(message: string, portfolios: P[], askedName: boolean | 'weak'): Extracted {
  const document = extractDocument(message);
  const portfolio = matchPortfolio(message, portfolios);
  const terms = portfolios.flatMap((p) => [p.key, p.name, ...(p.aliases ?? [])]);
  const explicit = explicitName(message, askedName === true);
  const looseName = askedName === true || (askedName === 'weak' && !!(document || portfolio));
  const name = explicit ?? (looseName ? nameFromReply(message, terms) : null);

  // Lo que sobra sin los datos: decide si el mensaje traía además una pregunta o un tema.
  let rest = normalize(message.replace(/\d[\d.\s-]*/g, ' '));
  if (name) rest = rest.replace(normalize(name), ' ');
  if (portfolio) for (const term of [portfolio.key, portfolio.name, ...(portfolio.aliases ?? [])]) rest = rest.replace(normalize(term), ' ');
  for (const w of stems(portfolio ? portfolio.name : '')) rest = rest.replace(new RegExp(`\\b${w}\\w*\\b`, 'g'), ' ');
  rest = rest.replace(DATA_WORDS, ' ').replace(/\s+/g, ' ').trim();

  return {
    document, portfolioKey: portfolio?.key, name: name ?? undefined, nameExplicit: !!explicit,
    rest: document || portfolio || name ? rest : normalize(message),
  };
}

/** El mensaje solo traía datos de identificación (nada que responder aparte de agradecerlos). */
export const onlyData = (x: Extracted) => !!(x.document || x.portfolioKey || x.name) && x.rest.split(' ').filter((w) => w.length >= 3).length < 2;
