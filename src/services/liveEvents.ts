/**
 * Eventos en vivo para el panel (Server-Sent Events). Vive en memoria del proceso: publicar no toca la base de datos y,
 * sin nadie conectado, no hace nada. Con varias instancias del servicio habría que llevarlo a Postgres LISTEN/NOTIFY o Redis.
 */
export type LiveEventName = 'page_view' | 'chat_open' | 'button_click' | 'handoff_created' | 'whatsapp_click';
export const LIVE_EVENT_NAMES: readonly LiveEventName[] = ['page_view', 'chat_open', 'button_click', 'handoff_created', 'whatsapp_click'];

export interface LiveEvent {
  type: LiveEventName;
  /** Momento del evento (ISO, UTC): el panel lo usa para ubicarlo en el día correcto. */
  at: string;
  data: Record<string, unknown>;
}

/** Publica un evento de una empresa (sin esperar y sin lanzar). */
export type LiveNotify = (companyId: string, type: LiveEventName, data?: Record<string, unknown>) => void;

interface Subscriber {
  send: (e: LiveEvent) => void;
  close: () => void;
}

export function createLiveBus(maxTotal = 50, maxPerCompany = 20) {
  const subs = new Map<string, Set<Subscriber>>();
  let total = 0;

  return {
    publish: ((companyId, type, data = {}) => {
      const set = subs.get(companyId);
      if (!set) return;
      const event: LiveEvent = { type, at: new Date().toISOString(), data };
      for (const s of set) {
        try {
          s.send(event);
        } catch {
          /* conexión rota: se limpia al cerrarse */
        }
      }
    }) as LiveNotify,

    /** Devuelve la función para darse de baja, o null si se alcanzó el tope de conexiones (total o por empresa). */
    subscribe(companyId: string, sub: Subscriber): (() => void) | null {
      const set = subs.get(companyId) ?? new Set<Subscriber>();
      if (total >= maxTotal || set.size >= maxPerCompany) return null;
      set.add(sub);
      subs.set(companyId, set);
      total++;
      return () => {
        if (!set.delete(sub)) return;
        total--;
        if (set.size === 0) subs.delete(companyId);
      };
    },

    count: () => total,

    /** Cierra todas las conexiones (apagado ordenado del servidor). */
    closeAll() {
      for (const set of [...subs.values()]) for (const s of [...set]) s.close();
    },
  };
}
export type LiveBus = ReturnType<typeof createLiveBus>;
