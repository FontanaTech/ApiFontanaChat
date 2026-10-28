import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
const int = (def: number) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(10000),
  DATABASE_URL: z.string().optional().default(''),
  SESSION_SECRET: z.string().optional().default(''),
  // Proveedor del modelo: 'ollama' (local/servidor propio) u 'openai' (cualquier API compatible: Groq, Gemini, OpenRouter...).
  LLM_PROVIDER: z.enum(['ollama', 'openai']).default('ollama'),
  LLM_BASE_URL: z.string().optional().default(''),
  LLM_API_KEY: z.string().optional().default(''),
  LLM_MODEL: z.string().optional().default(''),
  LLM_TIMEOUT_MS: int(15000),
  // Tope diario de tokens del modelo sumando TODAS las empresas (0 = sin tope). Con el plan gratuito de Groq: 180000 (la cuota es 200000).
  LLM_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(0).default(0),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().optional().default(''),
  OLLAMA_TIMEOUT_MS: int(20000),
  OLLAMA_KEEP_ALIVE: z.string().default('12h'),
  OLLAMA_NUM_CTX: int(8192),
  ADMIN_SESSION_TTL_HOURS: int(8),
  PUBLIC_SESSION_TTL_MINUTES: int(120),
  BODY_LIMIT_KB: int(16),
  CHAT_MESSAGE_MAX_CHARS: int(500),
  CHAT_CONTEXT_MAX_CHARS: int(16000),
  CHAT_FAST_SCORE: z.coerce.number().int().min(0).default(2),
  PUBLIC_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(15),
  CONTENT_MAX_BYTES: int(524288),
  CONTENT_FETCH_TIMEOUT_MS: int(8000),
  ALLOW_LOCAL_CONTENT_URLS: bool,
  RATE_LIMIT_WINDOW_SEC: int(60),
  RATE_LIMIT_GENERAL: int(300),
  RATE_LIMIT_SESSIONS: int(30),
  RATE_LIMIT_CHAT: int(20),
  RATE_LIMIT_LOGIN: int(10),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  SERVE_ADMIN: z.enum(['true', 'false']).optional(),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  isProd: boolean;
  host: string;
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  llmProvider: 'ollama' | 'openai';
  llmBaseUrl: string;
  /** Clave del proveedor: solo vive en el servidor, nunca se envía al navegador ni se registra. */
  llmApiKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  /** Tope diario global de tokens del modelo (suma de todas las empresas); 0 = sin tope. */
  llmDailyTokenLimit: number;
  /** Hay un modelo realmente configurado (según el proveedor elegido). */
  llmEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs: number;
  /** Tiempo que Ollama mantiene el modelo cargado entre mensajes (evita recargarlo). */
  ollamaKeepAlive: string;
  /** Ventana de contexto fija: cambiarla entre peticiones obliga a Ollama a recargar el modelo. */
  ollamaNumCtx: number;
  adminSessionTtlMs: number;
  publicSessionTtlMs: number;
  bodyLimitKb: number;
  chatMessageMaxChars: number;
  /** Máximo de caracteres del sitio que se envían como contexto al modelo. */
  chatContextMaxChars: number;
  /** Puntaje mínimo para responder al instante con el texto del sitio, sin modelo; 0 = siempre usar el modelo. */
  chatFastScore: number;
  /** Vencimiento de la caché de empresa/orígenes/sesión públicas; 0 la desactiva. */
  cacheTtlMs: number;
  contentMaxBytes: number;
  contentFetchTimeoutMs: number;
  /** Solo true fuera de producción. */
  allowLocalContentUrls: boolean;
  rate: { windowMs: number; general: number; sessions: number; chat: number; login: number };
  trustProxy: number;
  serveAdmin: boolean;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const e = schema.parse(source);
  const isProd = e.NODE_ENV === 'production';
  if (isProd && e.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET debe tener al menos 32 caracteres en producción');
  }
  const cfg: Config = {
    env: e.NODE_ENV,
    isProd,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET || 'dev-only-insecure-secret-change-me-0000',
    llmProvider: e.LLM_PROVIDER,
    llmBaseUrl: e.LLM_BASE_URL,
    llmApiKey: e.LLM_API_KEY,
    llmModel: e.LLM_MODEL,
    llmTimeoutMs: e.LLM_TIMEOUT_MS,
    llmDailyTokenLimit: e.LLM_DAILY_TOKEN_LIMIT,
    llmEnabled: e.LLM_PROVIDER === 'openai' ? !!(e.LLM_BASE_URL && e.LLM_API_KEY && e.LLM_MODEL) : !!e.OLLAMA_MODEL,
    ollamaBaseUrl: e.OLLAMA_BASE_URL,
    ollamaModel: e.OLLAMA_MODEL,
    ollamaTimeoutMs: e.OLLAMA_TIMEOUT_MS,
    ollamaKeepAlive: e.OLLAMA_KEEP_ALIVE,
    ollamaNumCtx: e.OLLAMA_NUM_CTX,
    adminSessionTtlMs: e.ADMIN_SESSION_TTL_HOURS * 3600_000,
    publicSessionTtlMs: e.PUBLIC_SESSION_TTL_MINUTES * 60_000,
    bodyLimitKb: e.BODY_LIMIT_KB,
    chatMessageMaxChars: e.CHAT_MESSAGE_MAX_CHARS,
    chatContextMaxChars: e.CHAT_CONTEXT_MAX_CHARS,
    chatFastScore: e.CHAT_FAST_SCORE,
    cacheTtlMs: e.PUBLIC_CACHE_TTL_SECONDS * 1000,
    contentMaxBytes: e.CONTENT_MAX_BYTES,
    contentFetchTimeoutMs: e.CONTENT_FETCH_TIMEOUT_MS,
    allowLocalContentUrls: !isProd && e.ALLOW_LOCAL_CONTENT_URLS,
    rate: {
      windowMs: e.RATE_LIMIT_WINDOW_SEC * 1000,
      general: e.RATE_LIMIT_GENERAL,
      sessions: e.RATE_LIMIT_SESSIONS,
      chat: e.RATE_LIMIT_CHAT,
      login: e.RATE_LIMIT_LOGIN,
    },
    trustProxy: e.TRUST_PROXY,
    serveAdmin: e.SERVE_ADMIN ? e.SERVE_ADMIN === 'true' : isProd,
  };
  return { ...cfg, ...overrides };
}
