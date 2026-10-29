import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ErrorBox, LiveBadge, useBackupReload, useLiveStream, useLoad, type LiveEvent } from '../ui';
import { DateRange, isoDay } from './RecordsTab';

const LABELS: Record<string, string> = {
  visit: 'Ingresos',
  page_view: 'Vistas de página',
  chat_open: 'Chats abiertos',
  button_click: 'Clics en botones',
  handoff_created: 'Derivaciones creadas',
  whatsapp_click: 'Clics en WhatsApp',
};

const DEVICE_NAMES: Record<string, string> = { desktop: 'Computador', mobile: 'Celular', tablet: 'Tableta', bot: 'Bot' };

/** Suma un evento en vivo a las métricas ya cargadas (sin consultar la base). Los eventos fuera del rango visible se ignoran. */
function applyLiveEvent(d: any, e: LiveEvent, from: string, to: string): any {
  const day = e.at.slice(0, 10); // el servidor agrupa por día UTC
  if (day < from || day > to) return d;
  const n = structuredClone(d);
  const bump = (type: string) => {
    n.counts[type] = (n.counts[type] ?? 0) + 1;
    const row = n.byDay.find((x: any) => x.day === day && x.type === type);
    if (row) row.total += 1;
    else n.byDay.push({ day, type, total: 1 });
  };
  const tally = (list: { name: string; visits: number }[], name: string | null | undefined) => {
    const key = name || 'Desconocido';
    const row = list.find((r) => r.name === key);
    if (row) row.visits += 1;
    else list.push({ name: key, visits: 1 });
    list.sort((a, b) => b.visits - a.visits);
  };
  bump(e.type);
  if (e.type === 'page_view' && e.data.isVisit) {
    bump('visit');
    tally(n.byDevice, e.data.device);
    tally(n.byBrowser, e.data.browser);
    tally(n.byOs, e.data.os);
  }
  n.byDay.sort((a: any, b: any) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return n;
}

export function MetricsTab({ companyId }: { companyId: string }) {
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 30 * 86400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const m = useLoad(() => api('GET', `/companies/${companyId}/metrics?from=${from}&to=${to}`), [companyId, from, to]);
  // Los datos se cargan una vez; después los eventos llegan por SSE y se suman aquí, sin volver a consultar la base.
  const [live, setLive] = useState<any>(null);
  useEffect(() => setLive(m.data), [m.data]);
  const resync = useRef<ReturnType<typeof setTimeout>>();
  const online = useLiveStream(
    companyId,
    (e) => {
      setLive((cur: any) => (cur ? applyLiveEvent(cur, e, from, to) : cur));
      // Las derivaciones cambian los cuadros por asesor y cartera, que no se calculan aquí: una sola recarga agrupada.
      if (e.type === 'handoff_created' || e.type === 'whatsapp_click') {
        clearTimeout(resync.current);
        resync.current = setTimeout(() => void m.reload(), 2000);
      }
    },
    () => void m.reload(),
  );
  useBackupReload(m.reload);
  const d = live ?? m.data;
  const days: string[] = d ? [...new Set<string>(d.byDay.map((x: any) => x.day))] : [];
  const val = (day: string, type: string) => d.byDay.find((x: any) => x.day === day && x.type === type)?.total ?? 0;
  const max = d ? Math.max(1, ...d.byDay.map((x: any) => x.total)) : 1;

  return (
    <>
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <p className="muted">
        Un <strong>ingreso</strong> es una visita real: se identifica al visitante por su IP y navegador, y no vuelve a contarse al cambiar de vista, recargar o abrir otra
        pestaña hasta pasados 30 minutos sin actividad. Las <strong>vistas de página</strong> cuentan cada cambio de vista. <LiveBadge online={online} />
      </p>
      <ErrorBox msg={m.error} />
      {d && (
        <>
          <div className="stats">
            {Object.keys(LABELS).map((k) => (
              <div className="stat" key={k}>
                <div className="num">{d.counts[k] ?? 0}</div>
                <div>{LABELS[k]}</div>
                <small className="muted">{d.sessions[k] ?? 0} {k === 'visit' ? 'visitantes únicos' : 'sesiones'}</small>
              </div>
            ))}
          </div>
          <div className="card">
            <h2>Ingresos por dispositivo y navegador</h2>
            <div className="inline" style={{ alignItems: 'flex-start', gap: 32 }}>
              {([['Dispositivo', d.byDevice], ['Navegador', d.byBrowser], ['Sistema', d.byOs]] as const).map(([title, rows]) => (
                <table key={title}>
                  <thead><tr><th>{title}</th><th>Ingresos</th></tr></thead>
                  <tbody>
                    {(rows ?? []).map((r: any) => <tr key={r.name}><td>{DEVICE_NAMES[r.name] ?? r.name}</td><td>{r.visits}</td></tr>)}
                    {(rows ?? []).length === 0 && <tr><td colSpan={2} className="muted">Sin ingresos.</td></tr>}
                  </tbody>
                </table>
              ))}
            </div>
          </div>
          <div className="card">
            <h2>Por cartera</h2>
            <table>
              <thead><tr><th>Cartera</th><th>Derivaciones</th><th>Clics en WhatsApp</th></tr></thead>
              <tbody>
                {(d.byPortfolio ?? []).map((a: any) => <tr key={a.portfolio}><td>{a.portfolio}</td><td>{a.handoffs}</td><td>{a.whatsapp_clicks}</td></tr>)}
                {(d.byPortfolio ?? []).length === 0 && <tr><td colSpan={3} className="muted">Sin derivaciones en el rango.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>Por asesor</h2>
            <table>
              <thead><tr><th>Asesor</th><th>Derivaciones</th><th>Clics en WhatsApp</th></tr></thead>
              <tbody>
                {d.byAdvisor.map((a: any) => <tr key={a.advisor}><td>{a.advisor}</td><td>{a.handoffs}</td><td>{a.whatsapp_clicks}</td></tr>)}
                {d.byAdvisor.length === 0 && <tr><td colSpan={3} className="muted">Sin derivaciones en el rango.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>Por día</h2>
            <table>
              <thead><tr><th>Día</th>{Object.keys(LABELS).map((k) => <th key={k}>{LABELS[k]}</th>)}</tr></thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day}>
                    <td>{day}</td>
                    {Object.keys(LABELS).map((k) => (
                      <td key={k}>
                        <span className="bar" style={{ width: `${(val(day, k) / max) * 60}px` }} /> {val(day, k)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
