import { gunzipSync } from 'node:zlib';
import { SPANISH_WORDS } from './spanishWords.data';

/**
 * Diccionario del español (~635.000 formas: sustantivos, adjetivos, verbos conjugados…), normalizado como normalize():
 * minúsculas, sin tildes y con la ñ como n. Sirve para que una palabra común que no está en el léxico ("burro",
 * "actriz", "musulmán", "parálisis") no pase por un nombre poco común. Los nombres de pila y los apellidos conocidos
 * (lexicon.ts) se miran antes y ganan siempre: "rosa", "juan" o "mora" también son palabras.
 *
 * Palabras: an-array-of-spanish-words 2.0.0 (licencia MIT, © 2016 Zeke Sikelianos), derivado de la lista de Letterpress.
 * Se guardan ordenadas, con codificación por prefijo y gzip (src/scripts/buildSpanishWords.ts). Se cargan la primera vez
 * que se consultan, como un solo texto con sus posiciones (unos 10 MB), y se buscan por bisección.
 */
let text = '';
let starts: Uint32Array | null = null;

function load(): Uint32Array {
  const packed = gunzipSync(Buffer.from(SPANISH_WORDS.replace(/\s+/g, ''), 'base64')).toString('latin1');
  const lines = packed.split('\n');
  const words: string[] = new Array(lines.length);
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    prev = prev.slice(0, line.charCodeAt(0) - 48) + line.slice(1);
    words[i] = prev;
  }
  text = words.join('\n');
  const at = new Uint32Array(words.length + 1);
  let pos = 0;
  for (let i = 0; i < words.length; i++) {
    at[i] = pos;
    pos += words[i].length + 1;
  }
  at[words.length] = pos;
  return at;
}

/** La palabra (ya normalizada) es del español: "burro", "actriz", "paralisis" sí; "yeison", "wilmar" o "duberney" no. */
export function isSpanishWord(w: string): boolean {
  if (!w || !/^[a-z]+$/.test(w)) return false;
  starts ??= load();
  let lo = 0;
  let hi = starts.length - 2;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const word = text.slice(starts[mid], starts[mid + 1] - 1);
    if (word === w) return true;
    if (word < w) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}
