import type { Config } from '../config/env';
import { LlmUnavailableError, createOllamaClient, type LlmClient } from './ollama';

type OpenAiConfig = Pick<Config, 'llmBaseUrl' | 'llmApiKey' | 'llmModel' | 'llmTimeoutMs'>;

/** Tras un 429 no se vuelve a llamar al proveedor durante este tiempo (máximo), para no gastar más cuota ni esperar en vano. */
const MAX_COOLDOWN_MS = 600_000; // un límite diario puede tardar horas: se reintenta cada 10 min como máximo
const DEFAULT_COOLDOWN_MS = 20_000;
/**
 * Un 429 por límite POR MINUTO (p. ej. Groq gratuito: 6000 tokens/min) suele pedir esperar 1–3 s. En un chat es mejor
 * esperar ese momento y reintentar UNA vez que contestar sin el modelo; esperas más largas sí pausan el proveedor.
 */
const SHORT_RETRY_MAX_MS = 3_000;
/**
 * Un intento colgado (pasa de vez en cuando con el proveedor: no responde y se agota el tiempo) no debe gastar todo
 * el tiempo de espera: se corta a los ATTEMPT_MAX_MS y, si queda margen, se reintenta una vez.
 */
const ATTEMPT_MAX_MS = 8_000;
const MIN_RETRY_MS = 4_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera que pide el proveedor: `retry-after` (segundos) o, en su defecto, `x-ratelimit-reset-tokens` ("760ms", "1.69s", "2m3s"). */
function retryAfterMs(h: Headers): number | null {
  const ra = Number(h.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return ra * 1000;
  const reset = h.get('x-ratelimit-reset-tokens');
  if (!reset) return null;
  let ms = 0;
  for (const [, n, unit] of reset.matchAll(/([\d.]+)(ms|s|m|h)/g)) ms += Number(n) * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000);
  return ms > 0 ? ms : null;
}

/** Motivo legible de un error del proveedor (sin datos sensibles): "HTTP 400 json_validate_failed: …". */
function describeError(status: number, body: string): string {
  try {
    const e = (JSON.parse(body) as { error?: { code?: string; type?: string; message?: string } }).error;
    if (e) return `HTTP ${status} ${e.code ?? e.type ?? ''}: ${(e.message ?? '').slice(0, 160)}`.trim();
  } catch { /* cuerpo no JSON */ }
  return `HTTP ${status}`;
}

/**
 * Cliente para cualquier proveedor con API compatible con OpenAI (`/chat/completions`): Groq, Gemini
 * (endpoint /openai), OpenRouter, etc. Solo el backend lo usa: la clave nunca llega al navegador.
 * Cualquier fallo (clave, cuota, red, tiempo) se informa como LlmUnavailableError y el chat cae
 * al atajo con el texto del sitio o a un asesor.
 */
export function createOpenAiCompatClient(cfg: OpenAiConfig): LlmClient {
  let blockedUntil = 0;
  return {
    async chatJson(messages, meta) {
      if (!cfg.llmBaseUrl || !cfg.llmApiKey || !cfg.llmModel) throw new LlmUnavailableError('LLM_BASE_URL, LLM_API_KEY o LLM_MODEL no configurados');
      if (Date.now() < blockedUntil) throw new LlmUnavailableError('Proveedor de IA en pausa por límite de uso');
      const deadline = Date.now() + cfg.llmTimeoutMs;
      let retried429 = false;
      let retriedTimeout = false;
      for (;;) {
        const remaining = deadline - Date.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), retriedTimeout ? remaining : Math.min(remaining, ATTEMPT_MAX_MS));
        try {
          const res = await fetch(`${cfg.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.llmApiKey}` },
            signal: ctrl.signal,
            body: JSON.stringify({
              model: cfg.llmModel,
              messages,
              temperature: 0.1,
              max_tokens: 200,
              response_format: { type: 'json_object' },
            }),
          });
          if (res.status === 429) {
            const wait = retryAfterMs(res.headers);
            // Límite por minuto con espera corta: se espera y se reintenta una vez (si cabe en el tiempo máximo).
            if (!retried429 && wait !== null && wait <= SHORT_RETRY_MAX_MS && Date.now() + wait + 1500 < deadline) {
              retried429 = true;
              clearTimeout(timer);
              await sleep(wait + 150);
              continue;
            }
            blockedUntil = Date.now() + (wait !== null ? Math.min(Math.max(wait, 1000), MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS);
            throw new LlmUnavailableError('Límite de uso del proveedor de IA (HTTP 429)');
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            // Groq rechaza con 400 "json_validate_failed" una salida que no es JSON estricto, pero la adjunta en
            // `failed_generation`: el chat intenta leer el JSON que traiga (p. ej. con texto alrededor) antes de rendirse.
            if (res.status === 400) {
              try {
                const failed = (JSON.parse(body) as { error?: { failed_generation?: unknown } }).error?.failed_generation;
                if (typeof failed === 'string' && failed.includes('{')) return failed;
              } catch { /* sigue como error */ }
            }
            throw new LlmUnavailableError(`El proveedor de IA respondió ${describeError(res.status, body)}`);
          }
          const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
          if (meta && typeof data.usage?.total_tokens === 'number') meta.tokens = data.usage.total_tokens;
          const content = data?.choices?.[0]?.message?.content;
          if (typeof content !== 'string' || !content.trim()) throw new LlmUnavailableError('Respuesta vacía del proveedor de IA');
          return content;
        } catch (e: any) {
          if (e instanceof LlmUnavailableError) throw e;
          if (e?.name === 'AbortError') {
            if (!retriedTimeout && deadline - Date.now() >= MIN_RETRY_MS) {
              retriedTimeout = true;
              continue;
            }
            throw new LlmUnavailableError('Timeout del proveedor de IA');
          }
          throw new LlmUnavailableError(`Proveedor de IA no disponible: ${e?.cause?.code ?? e?.message}`);
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}

/** Elige el proveedor según `LLM_PROVIDER` (ollama por defecto). */
export function createLlmClient(cfg: Config): LlmClient {
  return cfg.llmProvider === 'openai' ? createOpenAiCompatClient(cfg) : createOllamaClient(cfg);
}
