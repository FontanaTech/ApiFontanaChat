import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { fetch as undiciFetch } from 'undici';
import type { Config } from '../config/env';
import type { Db } from '../db';
import { getWebhookSecret, recordWebhookStatus, type Company } from '../models/companies';
import { isPrivateIp } from '../utils/ssrf';
import { safeDispatcher } from './contentSync';

/** Eventos que se envían: ingresos reales (no cada cambio de vista), chat, botones, derivaciones y clics en WhatsApp. */
export type WebhookEventName = 'visit' | 'chat_open' | 'button_click' | 'handoff_created' | 'whatsapp_click' | 'test';

/** Avisa sin esperar: nunca retrasa ni rompe la respuesta al visitante. */
export type WebhookNotify = (company: Pick<Company, 'id' | 'slug' | 'name' | 'webhook_url'>, event: WebhookEventName, data: Record<string, unknown>) => void;

/** Hace el POST y devuelve el código HTTP. Inyectable para pruebas. */
export type WebhookPoster = (url: string, headers: Record<string, string>, body: string) => Promise<number>;

export interface WebhookResult {
  ok: boolean;
  status?: number;
  error?: string;
}
export interface WebhookService {
  notify: WebhookNotify;
  /** Envía un evento `test` y devuelve el resultado (para el botón «Probar» del panel). */
  test(company: Pick<Company, 'id' | 'slug' | 'name' | 'webhook_url'>): Promise<WebhookResult>;
}

export const generateWebhookSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;

/** La URL la fija un superadmin: https, sin credenciales, sin host ni IP privados (http solo en desarrollo local). */
export function validateWebhookUrl(raw: string, allowLocal: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL del webhook inválida');
  }
  if (url.username || url.password) throw new Error('La URL del webhook no puede incluir credenciales');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) > 0 && isPrivateIp(host));
  if (local && !allowLocal) throw new Error('El webhook no puede apuntar a una dirección local o privada');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLocal && local)) throw new Error('El webhook debe usar https');
  return url.toString();
}

export function createWebhookPoster(cfg: Pick<Config, 'allowLocalContentUrls'>): WebhookPoster {
  const dispatcher = safeDispatcher(cfg.allowLocalContentUrls);
  return async (url, headers, body) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await undiciFetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: ctrl.signal, dispatcher });
      await res.body?.cancel().catch(() => undefined);
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Firma HMAC-SHA256 de `${timestamp}.${cuerpo}` con el secreto de la empresa (el receptor la recalcula para verificar el origen). */
export const signWebhook = (secret: string, timestamp: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

export function createWebhookService(db: Db, post: WebhookPoster, retryDelayMs = 2000): WebhookService {
  async function deliver(company: Pick<Company, 'id' | 'slug' | 'name' | 'webhook_url'>, event: WebhookEventName, data: Record<string, unknown>, retries: number): Promise<WebhookResult> {
    const url = company.webhook_url;
    if (!url) return { ok: false, error: 'La empresa no tiene webhook configurado' };
    const secret = await getWebhookSecret(db, company.id);
    if (!secret) return { ok: false, error: 'El webhook no tiene secreto' };
    const id = randomUUID();
    const body = JSON.stringify({ id, event, occurredAt: new Date().toISOString(), company: { slug: company.slug, name: company.name }, data });
    let result: WebhookResult = { ok: false };
    for (let attempt = 0; attempt <= retries; attempt++) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      try {
        const status = await post(
          url,
          {
            'content-type': 'application/json',
            'user-agent': 'Fontanachat-Webhook/1',
            'x-fontanachat-event': event,
            'x-fontanachat-delivery': id,
            'x-fontanachat-timestamp': timestamp,
            'x-fontanachat-signature': signWebhook(secret, timestamp, body),
          },
          body,
        );
        result = status >= 200 && status < 300 ? { ok: true, status } : { ok: false, status, error: `El destino respondió HTTP ${status}` };
        if (result.ok || (status < 500 && status !== 429)) break; // un 4xx no se arregla reintentando
      } catch (e: any) {
        result = { ok: false, error: e?.name === 'AbortError' ? 'Tiempo de espera agotado (5 s)' : `No se pudo conectar: ${e?.cause?.message ?? e?.message ?? 'error de red'}` };
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    await recordWebhookStatus(db, company.id, result.ok ? `ok (HTTP ${result.status})` : `error: ${result.error}`.slice(0, 300)).catch(() => undefined);
    return result;
  }

  return {
    notify(company, event, data) {
      if (!company.webhook_url) return;
      void deliver(company, event, data, 1).catch((e) => console.warn(`[webhook] ${company.slug}/${event}: ${e?.message ?? e}`));
    },
    test: (company) => deliver(company, 'test', { message: 'Evento de prueba de Fontanachat' }, 0),
  };
}
