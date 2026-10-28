import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, useLoad } from '../ui';
import { DateRange, isoDay } from './RecordsTab';

const LABELS: Record<string, string> = {
  page_view: 'Visitas a la página',
  chat_open: 'Chats abiertos',
  button_click: 'Clics en botones',
  handoff_created: 'Derivaciones creadas',
  whatsapp_click: 'Clics en WhatsApp',
};

export function MetricsTab({ companyId }: { companyId: string }) {
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 30 * 86400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const m = useLoad(() => api('GET', `/companies/${companyId}/metrics?from=${from}&to=${to}`), [companyId, from, to]);
  const d = m.data;
  const days: string[] = d ? [...new Set<string>(d.byDay.map((x: any) => x.day))] : [];
  const val = (day: string, type: string) => d.byDay.find((x: any) => x.day === day && x.type === type)?.total ?? 0;
  const max = d ? Math.max(1, ...d.byDay.map((x: any) => x.total)) : 1;

  return (
    <>
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      <ErrorBox msg={m.error} />
      {d && (
        <>
          <div className="stats">
            {Object.keys(LABELS).map((k) => (
              <div className="stat" key={k}>
                <div className="num">{d.counts[k] ?? 0}</div>
                <div>{LABELS[k]}</div>
                <small className="muted">{d.sessions[k] ?? 0} sesiones</small>
              </div>
            ))}
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
