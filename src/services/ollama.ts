import type { Config } from '../config/env';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Cliente LLM. Solo el backend lo usa; el navegador nunca ve Ollama. */
export interface LlmClient {
  chatJson(messages: LlmMessage[]): Promise<string>;
}

export class LlmUnavailableError extends Error {}

export function createOllamaClient(cfg: Pick<Config, 'ollamaBaseUrl' | 'ollamaModel' | 'ollamaTimeoutMs'> & Partial<Pick<Config, 'ollamaKeepAlive' | 'ollamaNumCtx'>>): LlmClient {
  return {
    async chatJson(messages) {
      if (!cfg.ollamaModel) throw new LlmUnavailableError('OLLAMA_MODEL no configurado');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.ollamaTimeoutMs);
      try {
        const res = await fetch(`${cfg.ollamaBaseUrl.replace(/\/+$/, '')}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: cfg.ollamaModel,
            messages,
            stream: false,
            format: 'json',
            // El modelo queda cargado y la parte fija del prompt (instrucciones + sitio) se reutiliza entre mensajes.
            keep_alive: cfg.ollamaKeepAlive ?? '30m',
            options: { temperature: 0.1, num_predict: 200, num_ctx: cfg.ollamaNumCtx ?? 8192 },
          }),
        });
        if (!res.ok) throw new LlmUnavailableError(`Ollama respondió HTTP ${res.status}`);
        const data = (await res.json()) as { message?: { content?: string } };
        const content = data?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new LlmUnavailableError('Respuesta vacía de Ollama');
        return content;
      } catch (e: any) {
        if (e instanceof LlmUnavailableError) throw e;
        throw new LlmUnavailableError(e?.name === 'AbortError' ? 'Timeout de Ollama' : `Ollama no disponible: ${e?.cause?.code ?? e?.message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
