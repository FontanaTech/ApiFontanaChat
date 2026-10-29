import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, Field, LiveBadge, fmt, useLive, useLoad } from '../ui';

const DEVICES: Record<string, string> = { desktop: 'Computador', mobile: 'Celular', tablet: 'Tableta', bot: 'Bot' };

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function DateRange({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (s: string) => void; setTo: (s: string) => void }) {
  return (
    <div className="inline">
      <Field label="Desde"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label="Hasta"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
    </div>
  );
}

export function RecordsTab({ companyId }: { companyId: string }) {
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 30 * 86400_000)));
  const [to, setTo] = useState(isoDay(new Date()));
  const qs = `?from=${from}&to=${to}&limit=100`;
  const h = useLoad(() => api<{ items: any[] }>('GET', `/companies/${companyId}/handoffs${qs}`), [companyId, from, to]);
  const e = useLoad(() => api<{ items: any[] }>('GET', `/companies/${companyId}/events${qs}`), [companyId, from, to]);

  useLive(() => Promise.all([h.reload(), e.reload()]));
  return (
    <>
      <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} /> <LiveBadge />
      <ErrorBox msg={h.error || e.error} />
      <div className="card">
        <h2>Derivaciones a WhatsApp</h2>
        <p className="muted">«Clic en WhatsApp» significa que la persona abrió el enlace; no confirma que haya enviado el mensaje.</p>
        <table>
          <thead><tr><th>Fecha</th><th>Visitante</th><th>Motivo</th><th>Cartera</th><th>Botón</th><th>Asesor</th><th>Número</th><th>Estado</th></tr></thead>
          <tbody>
            {h.data?.items.map((r) => (
              <tr key={r.id}>
                <td>{fmt(r.created_at)}</td><td>{r.visitor_name}</td><td>{r.reason}</td><td>{r.portfolio_name ?? '—'}</td><td>{r.button_label ?? '—'}</td><td>{r.advisor_name}</td><td><code>{r.phone_number}</code></td>
                <td>{r.status === 'whatsapp_clicked' ? 'Clic en WhatsApp' : 'Creada'}</td>
              </tr>
            ))}
            {h.data?.items.length === 0 && <tr><td colSpan={8} className="muted">Sin registros en el rango.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Eventos</h2>
        <table>
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Página</th><th>Botón</th><th>Dispositivo</th><th>Navegador</th></tr></thead>
          <tbody>
            {e.data?.items.map((r) => (
              <tr key={r.id}><td>{fmt(r.created_at)}</td><td>{r.type === 'page_view' && r.is_visit ? 'Ingreso' : r.type}</td><td>{r.page_path ?? '—'}</td><td>{r.button_label ?? '—'}</td><td>{DEVICES[r.device] ?? r.device ?? '—'}</td><td>{r.browser ? `${r.browser} · ${r.os}` : '—'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
