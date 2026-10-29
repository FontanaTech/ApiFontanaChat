import { createHmac } from 'node:crypto';

export interface Client {
  browser: string;
  os: string;
  device: 'desktop' | 'mobile' | 'tablet' | 'bot';
}

/** Navegador, sistema y tipo de dispositivo a partir del user-agent (reglas simples; sin dependencias). */
export function parseUserAgent(ua: string | undefined): Client {
  const s = (ua ?? '').slice(0, 400);
  if (!s || /bot|crawler|spider|slurp|facebookexternalhit|preview|headless|curl|wget|python-requests|node-fetch|undici|axios|monitor|uptime/i.test(s)) {
    return { browser: 'Otro', os: 'Otro', device: 'bot' };
  }
  const os = /Windows/i.test(s) ? 'Windows'
    : /Android/i.test(s) ? 'Android'
    : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
    : /Mac OS X|Macintosh/i.test(s) ? 'macOS'
    : /CrOS/i.test(s) ? 'ChromeOS'
    : /Linux/i.test(s) ? 'Linux'
    : 'Otro';
  // El orden importa: Edge, Opera y Samsung también dicen "Chrome"; Chrome también dice "Safari".
  const browser = /Edg(e|A|iOS)?\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(s) ? 'Firefox'
    : /Chrome|CriOS/.test(s) ? 'Chrome'
    : /Safari/.test(s) ? 'Safari'
    : 'Otro';
  const device = /iPad|Tablet/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s)) ? 'tablet'
    : /Mobi|iPhone|iPod|Android/i.test(s) ? 'mobile'
    : 'desktop';
  return { browser, os, device };
}

/**
 * Huella del visitante: HMAC(IP + user-agent) con el secreto del servidor y la empresa. No es reversible, de modo que no se
 * guarda la IP en claro, y es distinta en cada empresa (no permite seguir a una persona entre sitios).
 */
export function visitorHash(secret: string, companyId: string, ip: string, ua: string | undefined): string {
  return createHmac('sha256', secret).update(`visitor|${companyId}|${ip}|${(ua ?? '').slice(0, 400)}`).digest('hex').slice(0, 32);
}
