import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Los tokens nunca se guardan en claro: se guarda HMAC-SHA256 con SESSION_SECRET. */
export const hashToken = (secret: string, token: string) => createHmac('sha256', secret).update(token).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
