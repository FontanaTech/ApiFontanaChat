import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fn());
      setError('');
    } catch (e: any) {
      setError(e.message ?? 'Error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

/** Evento que el servidor empuja al panel (ver /companies/:id/live). */
export interface LiveEvent {
  type: 'page_view' | 'chat_open' | 'button_click' | 'handoff_created' | 'whatsapp_click';
  at: string;
  data: Record<string, any>;
}
const LIVE_TYPES: LiveEvent['type'][] = ['page_view', 'chat_open', 'button_click', 'handoff_created', 'whatsapp_click'];

/**
 * Datos en vivo sin consultar la base: abre un canal SSE con la API y entrega cada evento a `onEvent`.
 * Se pausa con la pestaña oculta y, al reconectar o volver a verla, llama a `onResync` (una sola recarga que corrige lo que se haya perdido).
 * Devuelve si el canal está conectado.
 */
export function useLiveStream(companyId: string, onEvent: (e: LiveEvent) => void, onResync: () => void): boolean {
  const handlers = useRef({ onEvent, onResync });
  handlers.current = { onEvent, onResync };
  const [online, setOnline] = useState(false);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let everOpened = false;
    const close = () => {
      clearTimeout(retry);
      es?.close();
      es = null;
      setOnline(false);
    };
    const connect = () => {
      close();
      es = new EventSource(`/api/v1/admin/companies/${companyId}/live`, { withCredentials: true });
      es.onopen = () => {
        setOnline(true);
        if (everOpened) handlers.current.onResync();
        everOpened = true;
      };
      es.onerror = () => {
        setOnline(false);
        // El navegador reintenta solo si la conexión se cayó; si el servidor la rechazó (CLOSED) se reintenta a mano.
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          retry = setTimeout(connect, 5000);
        }
      };
      for (const t of LIVE_TYPES) es.addEventListener(t, (m) => handlers.current.onEvent(JSON.parse((m as MessageEvent).data)));
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') close();
      else {
        connect();
        handlers.current.onResync();
      }
    };
    if (document.visibilityState === 'visible') connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [companyId]);
  return online;
}

/** Recarga de respaldo poco frecuente (el flujo en vivo ya mantiene los datos al día). */
export function useBackupReload(reload: () => void | Promise<void>, ms = 300_000) {
  const latest = useRef(reload);
  latest.current = reload; // la recarga más reciente, sin reiniciar el temporizador en cada render
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void latest.current();
    }, ms);
    return () => clearInterval(timer);
  }, [ms]);
}

export const LiveBadge = ({ online }: { online: boolean }) => (
  <span className={online ? 'live' : 'live off'} title="Los eventos llegan al instante, sin consultar la base de datos">{online ? '● En vivo' : '○ Reconectando…'}</span>
);

export const ErrorBox = ({ msg }: { msg: string }) => (msg ? <div className="alert error" role="alert">{msg}</div> : null);

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Ejecuta una acción mostrando el error en pantalla. */
export function useAction(after?: () => void | Promise<void>) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await after?.();
      return true;
    } catch (e: any) {
      setError(e.message ?? 'Error');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy };
}

export const Badge = ({ on, yes = 'Activo', no = 'Inactivo' }: { on: boolean; yes?: string; no?: string }) => (
  <span className={`badge ${on ? 'ok' : 'off'}`}>{on ? yes : no}</span>
);

export const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString('es') : '—');
