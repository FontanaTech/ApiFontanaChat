/**
 * Cliente de la API Fontanachat para los sitios estáticos.
 * - Sesión pública por pestaña (sessionStorage) con token temporal.
 * - Nunca conoce ni usa Ollama; solo habla con la API.
 * - Nunca construye enlaces de WhatsApp ni teléfonos: usa solo `waUrl` devuelto por el servidor.
 * - Si la API falla lanza ApiError (retryable) para que la UI muestre "Reintentar".
 */

export type EventType = 'page_view' | 'chat_open' | 'button_click';

export interface ChatReply {
  /** answer: respuesta con base en el sitio · handoff_offer: pasar con un asesor · fallback: el asistente no pudo responder. */
  type: 'answer' | 'handoff_offer' | 'fallback';
  message: string;
  link?: { title: string; url: string };
  /**
   * Presente cuando el visitante debe pasar con un asesor: enlace de WhatsApp ya listo (sin formulario).
   * Muéstralo como un botón/enlace "Continuar en WhatsApp" y avisa del clic con whatsappClicked(handoffId).
   */
  waUrl?: string;
  handoffId?: string;
}
export interface PublicButton {
  key: string;
  label: string;
  color: string;
  textColor: string;
  available: boolean;
}
export interface PublicConfig {
  company: { slug: string; name: string };
  /** Hay al menos un asesor disponible para atender una derivación. */
  available: boolean;
  buttons: PublicButton[];
}
export interface HandoffInput {
  /** Botón pulsado; sin él se asigna cualquier asesor disponible (round robin). */
  buttonKey?: string;
  /** Opcionales: el visitante no tiene que dejar datos para ir a WhatsApp. */
  name?: string;
  reason?: string;
}
export interface HandoffResult {
  handoffId: string;
  replayed: boolean;
  advisorName: string;
  waUrl: string;
  summary: { name: string | null; reason: string | null };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'timeout' | 'http',
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** La UI debe ofrecer "Reintentar" (sin inventar teléfonos ni enlaces). */
  get retryable() {
    return this.kind !== 'http' || (this.status ?? 0) >= 500 || this.status === 429;
  }
  /** No hay asesor disponible: reintentar no ayuda; mostrar el mensaje del servidor y no ofrecer el formulario. */
  get noAdvisor() {
    return this.code === 'no_advisor_available';
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ClientOptions {
  baseUrl: string;
  slug: string;
  fetch?: typeof fetch;
  storage?: StorageLike | null;
  timeoutMs?: number;
  /** Espera máxima de una respuesta del chat (el modelo puede tardar decenas de segundos en frío). Por defecto 60 s. */
  chatTimeoutMs?: number;
  pagePath?: () => string;
}

interface StoredSession {
  token: string;
  expiresAt: string;
}

const memoryStorage = (): StorageLike => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

export class FontanaChatClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly storage: StorageLike;
  private readonly storageKey: string;
  private readonly timeoutMs: number;
  private readonly chatTimeoutMs: number;
  private session: StoredSession | null = null;
  private sessionPromise: Promise<StoredSession> | null = null;
  private readonly pendingKeys = new Map<string, string>();

  constructor(private readonly opts: ClientOptions) {
    this.base = `${opts.baseUrl.replace(/\/+$/, '')}/api/v1/public/${encodeURIComponent(opts.slug)}`;
    this.f = opts.fetch ?? ((...a) => fetch(...a));
    let st: StorageLike | null = opts.storage ?? null;
    if (st === null && opts.storage === undefined) {
      try {
        st = typeof sessionStorage !== 'undefined' ? sessionStorage : null; // por pestaña
      } catch {
        st = null;
      }
    }
    this.storage = st ?? memoryStorage();
    this.storageKey = `fontanachat:session:${opts.slug}`;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.chatTimeoutMs = opts.chatTimeoutMs ?? Math.max(this.timeoutMs, 60000);
  }

  /* ---------- sesión ---------- */
  private readStored(): StoredSession | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const s = JSON.parse(raw) as StoredSession;
      return new Date(s.expiresAt).getTime() - Date.now() > 60_000 ? s : null;
    } catch {
      return null;
    }
  }

  async ensureSession(): Promise<void> {
    await this.getSession();
  }

  private async getSession(): Promise<StoredSession> {
    this.session ??= this.readStored();
    if (this.session && new Date(this.session.expiresAt).getTime() - Date.now() > 60_000) return this.session;
    this.sessionPromise ??= this.createSession().finally(() => (this.sessionPromise = null));
    return this.sessionPromise;
  }

  private async createSession(): Promise<StoredSession> {
    const pagePath = this.opts.pagePath?.() ?? (typeof location !== 'undefined' ? location.pathname : '/');
    const r = await this.raw<{ token: string; expiresAt: string }>('POST', '/sessions', { pagePath }, {});
    this.session = { token: r.token, expiresAt: r.expiresAt };
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.session));
    } catch {
      /* almacenamiento no disponible: la sesión vive en memoria */
    }
    return this.session;
  }

  private resetSession() {
    this.session = null;
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      /* noop */
    }
  }

  /* ---------- HTTP ---------- */
  private async raw<T>(method: 'GET' | 'POST', path: string, body: unknown, headers: Record<string, string>, timeoutMs = this.timeoutMs): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.f(this.base + path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        credentials: 'omit',
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        /* sin cuerpo JSON */
      }
      if (!res.ok) {
        throw new ApiError(data?.error?.message ?? `Error HTTP ${res.status}`, 'http', res.status, data?.error?.code);
      }
      return data as T;
    } catch (e: any) {
      if (e instanceof ApiError) throw e;
      if (e?.name === 'AbortError') throw new ApiError('La solicitud tardó demasiado', 'timeout');
      throw new ApiError('No se pudo conectar con el servidor', 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Petición autenticada; si el token expiró (401) crea una sesión nueva y reintenta una vez. */
  private async authed<T>(method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}, timeoutMs?: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const s = await this.getSession();
      try {
        return await this.raw<T>(method, path, body, { authorization: `Bearer ${s.token}`, ...extra }, timeoutMs);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401 && attempt === 0) {
          this.resetSession();
          continue;
        }
        throw e;
      }
    }
  }

  /* ---------- API pública ---------- */
  getConfig(): Promise<PublicConfig> {
    return this.authed<PublicConfig>('GET', '/config');
  }

  /** Registra un evento; nunca lanza (la analítica no debe romper la página). */
  async track(type: EventType, extra: { buttonKey?: string; path?: string } = {}): Promise<void> {
    try {
      await this.authed('POST', '/events', { type, ...extra });
    } catch {
      /* ignorado a propósito */
    }
  }

  chat(message: string, history: Array<{ role: 'user' | 'assistant'; content: string }> = []): Promise<ChatReply> {
    return this.authed<ChatReply>('POST', '/chat', { message, history: history.slice(-6) }, {}, this.chatTimeoutMs);
  }

  /**
   * Crea la derivación. La clave de idempotencia se conserva entre reintentos del mismo payload
   * hasta que el servidor responde con éxito, para no duplicar la derivación si se reintenta.
   */
  async createHandoff(input: HandoffInput): Promise<HandoffResult> {
    const sig = JSON.stringify([input.buttonKey ?? '', input.name ?? '', input.reason ?? '']);
    let key = this.pendingKeys.get(sig);
    if (!key) {
      key = randomKey();
      this.pendingKeys.set(sig, key);
    }
    const r = await this.authed<HandoffResult>('POST', '/handoffs', input, { 'idempotency-key': key });
    this.pendingKeys.delete(sig);
    return r;
  }

  /** Llamar cuando el visitante pulsa el enlace de WhatsApp (clic, no "mensaje enviado"). */
  async whatsappClicked(handoffId: string): Promise<void> {
    try {
      await this.authed('POST', `/handoffs/${encodeURIComponent(handoffId)}/whatsapp-click`, {});
    } catch {
      /* la navegación a WhatsApp no debe bloquearse */
    }
  }
}

function randomKey(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
