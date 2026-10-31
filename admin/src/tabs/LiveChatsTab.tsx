import { useMemo, useRef, useState } from 'react';
import { api, type Admin } from '../api';
import { ErrorBox, LiveBadge, fmt, useAction, useBackupReload, useLiveStream, useLoad } from '../ui';

type Status = 'BOT_ACTIVO' | 'EN_ESPERA_ASESOR' | 'TOMADO_POR_ASESOR' | 'REMITIDO_WHATSAPP' | 'CERRADO' | 'ABANDONADO';
interface Conversation { id: string; visitor_name: string | null; document: string | null; portfolio_id: string | null; portfolio_name: string | null; status: Status; advisor_name: string | null; current_advisor_id: string | null; pending_transfer_to: string | null; last_interaction_at: string; last_message: string | null; waiting_seconds: number; subject: string }
interface Message { id: string; sender_type: 'USER' | 'BOT' | 'ADVISOR' | 'SYSTEM'; advisor_name?: string | null; content: string; created_at: string; metadata?: { waUrl?: string } }
interface Advisor { id: string; name: string; status: 'available' | 'busy' | 'offline'; portfolio_ids: string[]; active_chats: number; chats_today: number; last_activity_at: string | null }

const LABELS: Record<Status, string> = { BOT_ACTIVO: 'Bot activo', EN_ESPERA_ASESOR: 'En espera', TOMADO_POR_ASESOR: 'Con asesor', REMITIDO_WHATSAPP: 'Remitido', CERRADO: 'Cerrado', ABANDONADO: 'Abandonado' };
const ago = (n: number) => n < 60 ? `${n}s` : n < 3600 ? `${Math.floor(n / 60)} min` : `${Math.floor(n / 3600)} h`;

export function LiveChatsTab({ companyId, admin }: { companyId: string; admin: Admin }) {
  const [filters, setFilters] = useState({ status: '', portfolioId: '', advisorId: '', search: '', from: '', to: '', pending: false });
  const [selected, setSelected] = useState('');
  const [takeAdvisor, setTakeAdvisor] = useState(admin.advisor_id ?? '');
  const [portfolio, setPortfolio] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [draft, setDraft] = useState('');
  const setFilter = (key: keyof typeof filters, value: string | boolean) => setFilters((previous) => ({ ...previous, [key]: value }));
  const query = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, String(value)); });
    return params.toString();
  }, [filters]);
  const sessions = useLoad(() => api<{ items: Conversation[] }>('GET', `/companies/${companyId}/chat-sessions?${query}`), [companyId, query]);
  const detail = useLoad(() => selected
    ? api<{ conversation: Conversation; messages: Message[] }>('GET', `/companies/${companyId}/chat-sessions/${selected}`)
    : Promise.resolve({ conversation: null as any, messages: [] }), [companyId, selected]);
  const advisors = useLoad(() => api<{ items: Advisor[] }>('GET', `/companies/${companyId}/advisor-presence`), [companyId]);
  const portfolios = useLoad(() => api<{ items: Array<{ id: string; name: string; active: boolean }> }>('GET', `/companies/${companyId}/portfolios`), [companyId]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reload = () => void Promise.all([sessions.reload(), advisors.reload(), selected ? detail.reload() : Promise.resolve()]);
  const online = useLiveStream(companyId, (event) => {
    if (!event.type.startsWith('chat_') && !['advisor_status', 'conversation_created'].includes(event.type)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, 120);
  }, reload);
  useBackupReload(reload, 120_000);
  const action = useAction(reload);
  const current = detail.data?.conversation;
  const allowed = (advisors.data?.items ?? []).filter((a) => !current?.portfolio_id || a.portfolio_ids.includes(current.portfolio_id));
  const run = (path: string, body: unknown = {}) => action.run(() => api('POST', `/companies/${companyId}/chat-sessions/${selected}${path}`, body));
  const send = async () => { if (draft.trim() && await run('/messages', { message: draft })) setDraft(''); };
  return <>
    <div className="live-chat-heading">
      <div><h2>Chats en vivo</h2><p className="muted">Al tomar un chat, el bot se pausa solo para esa conversación.</p></div>
      <LiveBadge online={online} />
    </div>
    <ErrorBox msg={sessions.error || detail.error || advisors.error || portfolios.error || action.error} />
    <div className="live-filters">
      <input aria-label="Buscar" placeholder="Usuario o documento" value={filters.search} onChange={(e) => setFilter('search', e.target.value)} />
      <select aria-label="Estado" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
        <option value="">Todos los estados</option>
        {Object.entries(LABELS).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
      </select>
      <select aria-label="Cartera" value={filters.portfolioId} onChange={(e) => setFilter('portfolioId', e.target.value)}>
        <option value="">Todas las carteras</option>
        {portfolios.data?.items.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select aria-label="Asesor" value={filters.advisorId} onChange={(e) => setFilter('advisorId', e.target.value)}>
        <option value="">Todos los asesores</option>
        {advisors.data?.items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <label><input type="checkbox" checked={filters.pending} onChange={(e) => setFilter('pending', e.target.checked)} />Solo pendientes</label>
      <input type="datetime-local" aria-label="Desde" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
      <input type="datetime-local" aria-label="Hasta" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
    </div>
    <div className="live-chat-layout">
      <aside className="conversation-list" aria-label="Conversaciones">
        {(sessions.data?.items ?? []).map((conversation) => <button
          key={conversation.id}
          className={selected === conversation.id ? 'conversation active' : 'conversation'}
          onClick={() => { setSelected(conversation.id); setPortfolio(conversation.portfolio_id ?? ''); }}
        >
          <span><strong>{conversation.visitor_name || conversation.document || `Sesión ${conversation.id.slice(0, 8)}`}</strong><em className={`chat-status ${conversation.status}`}>{LABELS[conversation.status]}</em></span>
          <small>{conversation.portfolio_name || 'Sin cartera'} · {conversation.advisor_name || 'Sin asesor'}</small>
          <p>{conversation.last_message || 'Sin mensajes'}</p>
          <time>{fmt(conversation.last_interaction_at)}{conversation.status === 'EN_ESPERA_ASESOR' ? ` · espera ${ago(conversation.waiting_seconds)}` : ''}</time>
        </button>)}
        {sessions.data?.items.length === 0 && <p className="muted empty">No hay conversaciones.</p>}
      </aside>
      <section className="conversation-panel">
        {!current && <div className="empty-chat"><h3>Selecciona una conversación</h3></div>}
        {current && <>
          <header className="conversation-header">
            <div><h3>{current.visitor_name || `Sesión ${current.id.slice(0, 8)}`}</h3><p className="muted">{current.document ? `Documento ${current.document} · ` : ''}{current.portfolio_name || 'Sin cartera'} · {LABELS[current.status]}</p></div>
            {['BOT_ACTIVO', 'EN_ESPERA_ASESOR', 'ABANDONADO'].includes(current.status) && <div className="inline compact">
              {admin.role !== 'advisor' && <select aria-label="Asesor que tomará el chat" value={takeAdvisor} onChange={(e) => setTakeAdvisor(e.target.value)}><option value="">Seleccionar asesor</option>{allowed.filter((a) => a.status !== 'offline').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
              <button className="primary" disabled={!admin.advisor_id && !takeAdvisor} onClick={() => run('/take', takeAdvisor ? { advisorId: takeAdvisor } : {})}>Tomar control</button>
            </div>}
          </header>
          <div className="messages" aria-live="polite">
            {detail.data?.messages.map((message) => <article key={message.id} className={`message ${message.sender_type.toLowerCase()}`}>
              <small>{message.sender_type === 'USER' ? 'Usuario' : message.sender_type === 'ADVISOR' ? message.advisor_name || 'Asesor' : message.sender_type === 'BOT' ? 'Chatbot' : 'Sistema'} · {fmt(message.created_at)}</small>
              <p>{message.content}</p>
              {message.metadata?.waUrl && <a href={message.metadata.waUrl} target="_blank" rel="noreferrer">Abrir WhatsApp</a>}
            </article>)}
          </div>
          {current.status === 'TOMADO_POR_ASESOR' && <div className="composer">
            <textarea aria-label="Respuesta" rows={3} maxLength={4000} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder="Escribe una respuesta…" />
            <button className="primary" disabled={!draft.trim()} onClick={send}>Enviar</button>
          </div>}
          <div className="chat-actions">
            <select aria-label="Seleccionar cartera" value={portfolio || current.portfolio_id || ''} onChange={(e) => setPortfolio(e.target.value)}>
              <option value="">Seleccionar cartera</option>{portfolios.data?.items.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button disabled={!portfolio || portfolio === current.portfolio_id} onClick={() => action.run(() => api('PATCH', `/companies/${companyId}/chat-sessions/${selected}/portfolio`, { portfolioId: portfolio }))}>Cambiar cartera</button>
            {current.status === 'TOMADO_POR_ASESOR' && <>
              <button onClick={() => run('/release', { destination: 'bot' })}>Devolver al bot</button>
              <button onClick={() => run('/release', { destination: 'queue' })}>Liberar a cola</button>
              <select aria-label="Transferir a" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                <option value="">Transferir a…</option>{allowed.filter((a) => a.id !== current.current_advisor_id && a.status !== 'offline').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button disabled={!transferTo} onClick={() => run('/transfer', { advisorId: transferTo })}>Transferir</button>
              <button onClick={() => { const summary = window.prompt('Resumen para WhatsApp', current.subject || ''); if (summary !== null) void run('/whatsapp', { summary }); }}>Remitir a WhatsApp</button>
            </>}
            {current.pending_transfer_to === admin.advisor_id && <button className="primary" onClick={() => run('/accept-transfer')}>Aceptar transferencia</button>}
            {!['CERRADO', 'REMITIDO_WHATSAPP'].includes(current.status) && <button className="danger" onClick={() => {
              const reason = window.prompt('Motivo: resuelto, remitido, abandono, informacion_entregada u otro', 'resuelto');
              if (reason && ['resuelto', 'remitido', 'abandono', 'informacion_entregada', 'otro'].includes(reason)) void run('/close', { reason });
            }}>Cerrar</button>}
          </div>
        </>}
      </section>
    </div>
    <div className="card advisor-presence"><h2>Asesores</h2><table>
      <thead><tr><th>Asesor</th><th>Estado</th><th>Activos</th><th>Hoy</th><th>Última actividad</th></tr></thead>
      <tbody>{advisors.data?.items.map((advisor) => <tr key={advisor.id}>
        <td>{advisor.name}</td><td><select value={advisor.status} disabled={admin.role === 'advisor' && admin.advisor_id !== advisor.id} onChange={(e) => action.run(() => api('PATCH', `/companies/${companyId}/advisor-presence/${advisor.id}`, { status: e.target.value }))}><option value="available">Disponible</option><option value="busy">Ocupado</option><option value="offline">Desconectado</option></select></td>
        <td>{advisor.active_chats}</td><td>{advisor.chats_today}</td><td>{fmt(advisor.last_activity_at)}</td>
      </tr>)}</tbody>
    </table></div>
  </>;
}
