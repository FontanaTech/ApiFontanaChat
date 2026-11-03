/** Minúsculas, sin tildes ni signos; útil para comparar términos de áreas. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(s: string): string {
  return normalize(s).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function clientIp(req: { ip?: string }): string | undefined {
  return req.ip;
}

/** Arregla la puntuación de un texto armado por partes: "D. C.." → "D. C.", espacios dobles y espacio antes de signos. */
export function tidy(s: string): string {
  return s.replace(/(?<!\.)\.\.(?!\.)/g, '.').replace(/[ \t]+([,.;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Une frases de un mensaje del bot con la puntuación correcta: si una parte no termina en signo, se le agrega punto
 * ("…604 607 4101" + "¿Con quién tengo el gusto?" → "…604 607 4101. ¿Con quién tengo el gusto?"). Ignora partes vacías.
 */
export function joinText(...parts: Array<string | null | undefined | false>): string {
  const list = parts.map((p) => (p ? tidy(p) : '')).filter(Boolean);
  let out = '';
  list.forEach((p, i) => {
    const piece = i < list.length - 1 && !/[.!?…:]$/.test(p) ? `${p}.` : p;
    // Después de una lista ("• …") la frase siguiente va en un renglón aparte, no pegada al último punto.
    out += i === 0 ? piece : /\n\s*•/.test(list[i - 1]) ? `\n${piece}` : ` ${piece}`;
  });
  return out;
}
