import { createHash } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Config } from '../config/env';
import type { Db } from '../db';
import { contentSchema } from '../validation/schemas';
import { activeOrigins } from '../models/origins';
import { saveContentResult, type Company } from '../models/companies';
import { isPrivateIp } from '../utils/ssrf';

export class ContentError extends Error {}

/** Descarga el texto (no valida esquema). Inyectable para pruebas. */
export type ContentFetcher = (url: string) => Promise<string>;

const isLocalHost = (h: string) => h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0';

/**
 * Valida la URL configurada por el admin (nunca una enviada por el visitante):
 * https (http solo en desarrollo local), sin credenciales, origen igual a un origen permitido
 * de la empresa y sin host/IP privados ni localhost fuera de modo desarrollo.
 */
export function validateContentUrl(raw: string, allowedOrigins: string[], allowLocal: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ContentError('URL de contenido inválida');
  }
  if (url.username || url.password) throw new ContentError('La URL no puede incluir credenciales');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = isLocalHost(host) || (net.isIP(host) > 0 && isPrivateIp(host));
  if (local && !allowLocal) throw new ContentError('URL local o privada no permitida');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLocal && local)) {
    throw new ContentError('La URL debe usar https');
  }
  if (!local && url.port && url.port !== '443') throw new ContentError('Puerto no permitido');
  if (!allowedOrigins.map((o) => o.toLowerCase()).includes(url.origin.toLowerCase())) {
    throw new ContentError('El dominio de la URL no está entre los orígenes permitidos de la empresa');
  }
  return url;
}

/** Fetch real: sin redirecciones, tope de tamaño, timeout y resolución DNS verificada (anti-SSRF / rebinding). */
export function createContentFetcher(cfg: Pick<Config, 'contentMaxBytes' | 'contentFetchTimeoutMs' | 'allowLocalContentUrls'>): ContentFetcher {
  const allowLocal = cfg.allowLocalContentUrls;
  const dispatcher = new Agent({
    connect: {
      lookup: (hostname: string, options: any, cb: any) => {
        dns.lookup(hostname, { ...options, all: true }, (err, addrs: any) => {
          if (err) return cb(err);
          const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
          if (!allowLocal && list.some((a: any) => isPrivateIp(a.address))) return cb(new Error('El host resuelve a una IP privada'));
          if (options?.all) return cb(null, list);
          cb(null, list[0].address, list[0].family);
        });
      },
    },
  });
  return async (url: string) => {
    const literal = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (!allowLocal && net.isIP(literal) && isPrivateIp(literal)) throw new ContentError('URL local o privada no permitida');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.contentFetchTimeoutMs);
    try {
      const res = await undiciFetch(url, {
        redirect: 'manual', signal: ctrl.signal, dispatcher, headers: { accept: 'application/json' },
      });
      if (res.status >= 300 && res.status < 400) throw new ContentError('Las redirecciones no están permitidas');
      if (!res.ok) throw new ContentError(`El sitio respondió HTTP ${res.status}`);
      if (!(res.headers.get('content-type') ?? '').includes('json')) throw new ContentError('El contenido no es JSON');
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > cfg.contentMaxBytes) throw new ContentError('El contenido excede el tamaño máximo');
      if (!res.body) throw new ContentError('Respuesta vacía');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body as any) {
        size += chunk.length;
        if (size > cfg.contentMaxBytes) {
          ctrl.abort();
          throw new ContentError('El contenido excede el tamaño máximo');
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (e: any) {
      if (e instanceof ContentError) throw e;
      if (e?.name === 'AbortError') throw new ContentError('Tiempo de espera agotado al leer el contenido');
      throw new ContentError(`No se pudo descargar el contenido: ${e?.cause?.message ?? e?.message ?? 'error de red'}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface SyncOutcome {
  ok: boolean;
  error?: string;
  company: Company;
}

/** Sincroniza el contenido público de UNA empresa desde su URL configurada y guarda hash/fecha/estado. */
export async function syncCompanyContent(
  db: Db,
  cfg: Pick<Config, 'allowLocalContentUrls' | 'contentMaxBytes'>,
  fetcher: ContentFetcher,
  company: Company,
): Promise<SyncOutcome> {
  try {
    if (!company.content_url) throw new ContentError('La empresa no tiene URL de contenido configurada');
    const origins = await activeOrigins(db, company.id);
    const url = validateContentUrl(company.content_url, origins, cfg.allowLocalContentUrls);
    const text = await fetcher(url.toString());
    if (Buffer.byteLength(text) > cfg.contentMaxBytes) throw new ContentError('El contenido excede el tamaño máximo');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ContentError('El contenido no es JSON válido');
    }
    const parsed = contentSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ContentError(`Esquema inválido en ${first.path.join('.') || 'raíz'}: ${first.message}`);
    }
    if (parsed.data.slug && parsed.data.slug !== company.slug) {
      throw new ContentError('El slug del contenido no coincide con la empresa');
    }
    const hash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    const updated = await saveContentResult(db, company.id, { ok: true, json: parsed.data, hash });
    return { ok: true, company: updated };
  } catch (e: any) {
    const msg = e instanceof ContentError ? e.message : 'Error inesperado al sincronizar';
    if (!(e instanceof ContentError)) console.error('[content-sync]', e);
    const updated = await saveContentResult(db, company.id, { ok: false, error: msg });
    return { ok: false, error: msg, company: updated };
  }
}
