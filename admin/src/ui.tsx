import { useCallback, useEffect, useState, type ReactNode } from 'react';

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
