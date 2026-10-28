/** Minúsculas, sin tildes ni signos; útil para comparar términos de áreas. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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
