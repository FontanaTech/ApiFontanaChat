import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

/** true si la IP es privada, loopback, link-local, multicast o reservada. */
export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(l);
  }
  return true;
}

export async function resolveAll(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  const r = await dnsLookup(host, { all: true });
  return r.map((x) => x.address);
}
