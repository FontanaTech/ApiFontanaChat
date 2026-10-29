import { api } from './api';
import { ErrorBox, useBackupReload, useLoad } from './ui';

interface GlobalUsage {
  enabled: boolean;
  provider: 'openai' | 'ollama';
  model: string;
  resetsAt: string;
  global: { tokens: number; requests: number; limit: number | null };
  companies: { id: string; slug: string; name: string; tokens: number; requests: number; limit: number | null }[];
  days: { day: string; requests: number; tokens: number }[];
}

const num = (n: number) => n.toLocaleString('es-CO');
export const levelOf = (pct: number) => (pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '');

/** Barra de progreso con porcentaje; `used` frente a `limit`. */
export function Meter({ used, limit, label, small, large }: { used: number; limit: number; label: string; small?: boolean; large?: boolean }) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className={`meter ${small ? 'sm' : ''} ${large ? 'lg' : ''} ${levelOf(pct)}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** «Se reinicia hoy a las 7:00 p. m. (en 3 h 20 min)», en la hora del navegador del administrador. */
export function resetText(resetsAt: string): string {
  const at = new Date(resetsAt);
  const mins = Math.max(0, Math.round((at.getTime() - Date.now()) / 60000));
  const time = at.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
  const day = at.toDateString() === new Date().toDateString() ? 'hoy' : 'mañana';
  return `Se reinicia ${day} a las ${time} (en ${Math.floor(mins / 60)} h ${mins % 60} min)`;
}

/** Uso general del modelo de IA de todas las empresas frente a los límites. Solo superadmin; se actualiza cada minuto. */
export function GlobalUsageCard() {
  const usage = useLoad(() => api<GlobalUsage>('GET', '/llm-usage'), []);
  useBackupReload(usage.reload, 60_000);
  const u = usage.data;
  const g = u?.global;
  const pct = g?.limit ? Math.min(100, Math.round((g.tokens / g.limit) * 100)) : null;

  return (
    <div className="card">
      <h2>Uso general del modelo de IA</h2>
      <p className="muted">Todas las empresas comparten el mismo pozo diario de tokens; al agotarse, el chat sigue funcionando sin el modelo.</p>
      <ErrorBox msg={usage.error} />
      {u && !u.enabled && <p className="muted">Modelo de IA no configurado: el chat responde con el texto de los sitios y pasa a un asesor cuando no alcanza.</p>}
      {u && u.enabled && g && (
        <>
          <p>
            <strong>{num(g.tokens)}</strong>{g.limit ? <> de <strong>{num(g.limit)}</strong></> : null} tokens hoy · {num(g.requests)} {g.requests === 1 ? 'pregunta' : 'preguntas'} al modelo
            {pct != null && <> · <strong>{pct}%</strong> del límite diario de la API</>}
          </p>
          {g.limit ? <Meter large used={g.tokens} limit={g.limit} label="Uso diario general del modelo de IA" /> : <p className="muted">Sin tope general (<code>LLM_DAILY_TOKEN_LIMIT=0</code> o modelo local): no hay límite contra el cual medir. Quita esa variable o ponle un valor, p. ej. 180000.</p>}
          <p className="muted">
            Modelo <code>{u.model}</code> · {resetText(u.resetsAt)}. El conteo es por día UTC, igual que el proveedor.
          </p>
          {pct != null && pct >= 100 && (
            <div className="alert error" role="alert">
              Se alcanzó el límite general. El chat de todas las empresas sigue funcionando, pero sin el modelo: responde con el texto de cada sitio o pasa a un asesor.
            </div>
          )}
          {pct != null && pct >= 80 && pct < 100 && (
            <div className="alert warn" role="status">
              Va en {pct}% del límite general. Al llegar al 100% el chat sigue, pero sin el modelo, hasta el próximo reinicio.
            </div>
          )}

          <h3>Por empresa</h3>
          <table>
            <thead><tr><th>Empresa</th><th>Preguntas</th><th>Tokens hoy</th><th>Límite propio</th><th>Uso</th></tr></thead>
            <tbody>
              {u.companies.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{num(c.requests)}</td>
                  <td>{num(c.tokens)}</td>
                  <td>{c.limit != null ? num(c.limit) : <span className="muted">sin límite propio</span>}</td>
                  <td style={{ minWidth: 140 }}>
                    {c.limit != null
                      ? <><Meter small used={c.tokens} limit={c.limit} label={`Uso de ${c.name}`} /><small className="muted">{Math.min(100, Math.round((c.tokens / c.limit) * 100))}% de su límite</small></>
                      : g.limit ? <small className="muted">{Math.round((c.tokens / g.limit) * 100)}% del general</small> : '—'}
                  </td>
                </tr>
              ))}
              {u.companies.length === 0 && <tr><td colSpan={5} className="muted">Aún no hay empresas.</td></tr>}
            </tbody>
          </table>
          <p className="muted">Cuando una empresa llega a su límite propio, solo esa empresa deja de usar el modelo; cuando se llega al general, dejan todas.</p>

          {u.days.length > 0 && (
            <>
              <h3>Últimos 14 días (todas las empresas)</h3>
              <table>
                <thead><tr><th>Día</th><th>Preguntas</th><th>Tokens</th>{g.limit ? <th>% del límite</th> : null}</tr></thead>
                <tbody>
                  {u.days.map((d) => (
                    <tr key={d.day}><td>{d.day}</td><td>{num(d.requests)}</td><td>{num(d.tokens)}</td>{g.limit ? <td>{Math.round((d.tokens / g.limit) * 100)}%</td> : null}</tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      <button onClick={() => void usage.reload()}>Actualizar ahora</button>
    </div>
  );
}
