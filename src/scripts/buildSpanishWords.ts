/**
 * Genera src/services/spanishWords.data.ts: el diccionario del español que usa spanishWords.ts para que una palabra
 * común ("burro", "actriz", "parálisis") no se tome como un nombre poco común.
 *
 * Fuente: el paquete an-array-of-spanish-words 2.0.0 (licencia MIT, © 2016 Zeke Sikelianos), derivado de la lista de
 * palabras de Letterpress. No es una dependencia del proyecto: se descarga aparte y se pasa la ruta de su index.json.
 *
 *   npm pack an-array-of-spanish-words@2.0.0      (en una carpeta temporal; se descomprime el .tgz)
 *   npx tsx src/scripts/buildSpanishWords.ts <ruta a package/index.json>
 *
 * Las palabras se normalizan como normalize() (minúsculas, sin tildes, la ñ como n), se ordenan, se guardan con
 * codificación por prefijo (cada línea: cuántas letras comparte con la anterior + el resto) y se comprimen con gzip.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { normalize } from '../utils/text';

const source = process.argv[2];
if (!source) {
  console.error('Uso: npx tsx src/scripts/buildSpanishWords.ts <ruta a an-array-of-spanish-words/index.json>');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(source, 'utf8')) as string[];
const words = [...new Set(raw.map((w) => normalize(w)).filter((w) => /^[a-z]{2,}$/.test(w)))].sort();

// Prefijo compartido con la palabra anterior, como un carácter desde el '0' (hasta 35 letras).
const MAX_SHARED = 35;
let prev = '';
const lines = words.map((w) => {
  let shared = 0;
  while (shared < MAX_SHARED && shared < prev.length && shared < w.length && prev[shared] === w[shared]) shared++;
  prev = w;
  return String.fromCharCode(48 + shared) + w.slice(shared);
});
const packed = gzipSync(Buffer.from(lines.join('\n'), 'latin1'), { level: 9 }).toString('base64');
const wrapped = packed.match(/.{1,120}/g)!.join('\n');

const out = resolve(__dirname, '../services/spanishWords.data.ts');
writeFileSync(out, [
  '/* eslint-disable */',
  '// Generado por src/scripts/buildSpanishWords.ts: no editar a mano.',
  '// Palabras: an-array-of-spanish-words 2.0.0 (licencia MIT, © 2016 Zeke Sikelianos), derivado de la lista de Letterpress.',
  `// ${words.length} palabras, ordenadas, con codificación por prefijo y gzip, en base64.`,
  `export const SPANISH_WORDS_COUNT = ${words.length};`,
  `export const SPANISH_WORDS = \``,
  wrapped,
  '`;',
  '',
].join('\n'));
console.log(`${words.length} palabras → ${out} (${packed.length} caracteres en base64)`);
