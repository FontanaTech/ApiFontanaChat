import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, LiveBadge, useLive, useLoad } from '../ui';
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

export function MetricsTab({ companyId }: { companyId: string }) {
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 30 * 86400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const m = useLoad(() => api('GET', `/companies/${companyId}/metrics?from=${from}&to=${to}`), [companyId, from, to]);
  useLive(m.reload);
  const d = m.data;
  const days: string[] = d ? [...new Set<string>(d.byDay.map((x: any) => x.day))] : [];
  const val = (day: string, type: string) => d.byDay.find((x: any) => x.day === day && x.type === type)?.total ?? 0;
  const max = d ? Math.max(1, ...d.byDay.map((x: any) => x.total)) : 1;

  return (
    <>
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <p className="muted">
        Un <strong>ingreso</strong> es una visita real: se identifica al visitante por su IP y navegador, y no vuelve a contarse al cambiar de vista, recargar o abrir otra
        pestaña hasta pasados 30 minutos sin actividad. Las <strong>vistas de página</strong> cuentan cada cambio de vista. <LiveBadge />
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
