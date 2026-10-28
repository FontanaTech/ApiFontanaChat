import type { Config } from '../config/env';
import { LlmUnavailableError, createOllamaClient, type LlmClient } from './ollama';

type OpenAiConfig = Pick<Config, 'llmBaseUrl' | 'llmApiKey' | 'llmModel' | 'llmTimeoutMs'>;

/** Tras un 429 no se vuelve a llamar al proveedor durante este tiempo (máximo), para no gastar más cuota ni esperar en vano. */
const MAX_COOLDOWN_MS = 600_000; // un límite diario puede tardar horas: se reintenta cada 10 min como máximo
const DEFAULT_COOLDOWN_MS = 20_000;

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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.llmTimeoutMs);
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
          const wait = Number(res.headers.get('retry-after'));
          blockedUntil = Date.now() + (Number.isFinite(wait) && wait > 0 ? Math.min(wait * 1000, MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS);
          throw new LlmUnavailableError('Límite de uso del proveedor de IA (HTTP 429)');
        }
        if (!res.ok) throw new LlmUnavailableError(`El proveedor de IA respondió HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
        if (meta && typeof data.usage?.total_tokens === 'number') meta.tokens = data.usage.total_tokens;
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new LlmUnavailableError('Respuesta vacía del proveedor de IA');
        return content;
      } catch (e: any) {
        if (e instanceof LlmUnavailableError) throw e;
        throw new LlmUnavailableError(e?.name === 'AbortError' ? 'Timeout del proveedor de IA' : `Proveedor de IA no disponible: ${e?.cause?.code ?? e?.message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Elige el proveedor según `LLM_PROVIDER` (ollama por defecto). */
export function createLlmClient(cfg: Config): LlmClient {
  return cfg.llmProvider === 'openai' ? createOpenAiCompatClient(cfg) : createOllamaClient(cfg);
}
