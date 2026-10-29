import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Badge, ErrorBox, Field, fmt, useAction, useLoad } from '../ui';

interface SetupStep { key: string; label: string; done: boolean; required: boolean; hint: string }

interface LlmUsage {
  enabled: boolean;
  provider: 'openai' | 'ollama';
  model: string;
  today: { requests: number; tokens: number };
  dailyLimit: number | null;
  globalLimit: number | null;
  globalToday: number;
  days: { day: string; requests: number; tokens: number }[];
}

const num = (n: number) => n.toLocaleString('es');

/** Webhook de salida: el servidor avisa a una URL de la empresa, en vivo, cada vez que ocurre un evento. Solo superadmin. */
function WebhookCard({ company, reload }: { company: any; reload: () => void }) {
  const base = `/companies/${company.id}`;
  const [url, setUrl] = useState<string>(company.webhook_url ?? '');
  const [secret, setSecret] = useState('');
  const [testMsg, setTestMsg] = useState('');
  useEffect(() => setUrl(company.webhook_url ?? ''), [company.webhook_url]);
  const act = useAction(reload);
  const patch = async (body: object) => {
    setTestMsg('');
    await act.run(async () => {
      const r = await api<{ webhookSecret?: string }>('PATCH', base, body);
      if (r.webhookSecret) setSecret(r.webhookSecret); // se muestra una sola vez
    });
  };
  const test = useAction();
  const active = !!company.webhook_url;
  return (
    <div className="card">
      <h2>Webhook en vivo</h2>
      <p className="muted">
        El servidor envía un POST firmado a esta URL cuando hay un <code>visit</code> (ingreso real), <code>chat_open</code>, <code>button_click</code>, <code>handoff_created</code> o <code>whatsapp_click</code>.
        No se envían los cambios de vista ni los teléfonos de los asesores.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); void patch({ webhookUrl: url.trim() || null }); }}>
        <Field label="URL del webhook (https)"><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://tu-sistema.com/hooks/fontanachat" /></Field>
        <button className="primary" disabled={act.busy}>{active ? 'Guardar' : 'Activar webhook'}</button>
        {active && <button type="button" className="danger" onClick={() => { if (window.confirm('¿Desactivar el webhook? Se borrará también su secreto.')) { setSecret(''); void patch({ webhookUrl: null }); } }}>Desactivar</button>}
      </form>
      <ErrorBox msg={act.error} />
      {secret && (
        <div className="alert" role="status">
          <strong>Secreto de firma (cópialo ahora; no se vuelve a mostrar):</strong>
          <p><code>{secret}</code></p>
          <small>Cada envío trae <code>X-Fontanachat-Signature: sha256=HMAC(secreto, timestamp + "." + cuerpo)</code> y <code>X-Fontanachat-Timestamp</code>. Verifícalos antes de confiar en el mensaje.</small>
        </div>
      )}
      {active && (
        <>
          <p>
            Último estado: <strong>{company.webhook_status ?? 'sin envíos todavía'}</strong>
            {company.webhook_last_at ? <> · {fmt(company.webhook_last_at)}</> : null}
          </p>
          <button disabled={test.busy} onClick={async () => { setTestMsg(''); const ok = await test.run(async () => { const r = await api('POST', `${base}/webhook/test`, {}); setTestMsg(`Prueba enviada: el destino respondió HTTP ${r.status}.`); }); if (ok) reload(); }}>{test.busy ? 'Enviando…' : 'Enviar prueba'}</button>
          <button onClick={() => { if (window.confirm('¿Generar un secreto nuevo? El anterior dejará de ser válido y debes actualizarlo en el receptor.')) void patch({ regenerateWebhookSecret: true }); }}>Regenerar secreto</button>
          {testMsg && <p role="status">{testMsg}</p>}
          <ErrorBox msg={test.error} />
        </>
      )}
    </div>
  );
}

/** Consumo diario del modelo de IA y límite propio de la empresa. */
function LlmUsageCard({ companyId, savedLimit, isSuper, onSaved }: { companyId: string; savedLimit: number | null; isSuper: boolean; onSaved: () => void }) {
  const [tick, setTick] = useState(0);
  const usage = useLoad(() => api<LlmUsage>('GET', `/companies/${companyId}/llm-usage`), [companyId, savedLimit, tick]);
  const [limit, setLimit] = useState(savedLimit != null ? String(savedLimit) : '');
  useEffect(() => setLimit(savedLimit != null ? String(savedLimit) : ''), [savedLimit]);
  const save = useAction(() => {
    setTick((t) => t + 1);
    onSaved();
  });
  const u = usage.data;

  const setDaily = (value: number | null) => save.run(() => api('PATCH', `/companies/${companyId}`, { llmDailyTokens: value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(limit);
    if (!Number.isInteger(n) || n <= 0) {
      void save.run(async () => {
        throw new Error('Escribe un número entero mayor que 0, o usa "Quitar límite".');
      });
      return;
    }
    void setDaily(n);
  };

  const max = u ? (u.dailyLimit ?? u.globalLimit) : null;
  const pct = u && max ? Math.min(100, Math.round((u.today.tokens / max) * 100)) : null;
  const level = pct == null ? '' : pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';

  return (
    <div className="card">
      <h2>Uso del modelo de IA</h2>
      <ErrorBox msg={usage.error} />
      {u && !u.enabled && <p className="muted">Modelo de IA no configurado. El chat responde con el texto del sitio y pasa a un asesor cuando no alcanza.</p>}
      {u && u.enabled && (
        <>
          <p>Proveedor: <strong>{u.provider === 'openai' ? 'Modelo alojado (API compatible con OpenAI)' : 'Ollama'}</strong> · Modelo: <code>{u.model}</code></p>
          <p>
            Hoy: <strong>{num(u.today.tokens)}</strong>{max ? <> de <strong>{num(max)}</strong></> : null} tokens
            {' · '}{num(u.today.requests)} {u.today.requests === 1 ? 'pregunta' : 'preguntas'} al modelo
          </p>
          {pct != null && (
            <div className={`meter ${level}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Uso diario del modelo de IA">
              <span style={{ width: `${pct}%` }} />
            </div>
          )}
          {pct != null && <small className="muted">{pct}% del límite diario{u.dailyLimit != null ? ' de esta empresa' : ' de la API'}</small>}
          {pct != null && pct >= 100 && (
            <div className="alert error" role="alert">
              Se alcanzó el límite diario. El chat sigue funcionando, pero ya no usa el modelo: responde con el texto de la página o pasa a un asesor. El conteo se reinicia al día siguiente.
            </div>
          )}
          {pct != null && pct >= 80 && pct < 100 && (
            <div className="alert warn" role="status">
              Has usado el {pct}% del límite diario. Al agotarse, el chat sigue funcionando pero responde con el texto de la página o pasa a un asesor, sin usar el modelo.
            </div>
          )}
          {u.globalLimit != null && (
            <p className="muted">Uso total de todas las empresas hoy: <strong>{num(u.globalToday)}</strong> de {num(u.globalLimit)} tokens.</p>
          )}

          <form onSubmit={submit}>
            <div className="inline">
              <Field
                label="Límite diario de esta empresa (tokens)"
                hint="1 pregunta al modelo ≈ 2.000 tokens. Con el plan gratuito de Groq hay 200.000 tokens al día para TODAS las empresas: repártelos entre ellas."
              >
                <input type="number" min={1} step={1} value={limit} placeholder="Sin límite propio" disabled={!isSuper || save.busy} onChange={(e) => setLimit(e.target.value)} />
              </Field>
              <button className="primary" disabled={!isSuper || save.busy}>Guardar</button>
              <button type="button" disabled={!isSuper || save.busy || u.dailyLimit == null} onClick={() => void setDaily(null)}>Quitar límite</button>
            </div>
            {!isSuper && <small className="muted">Solo un superadmin puede cambiar este límite.</small>}
            <ErrorBox msg={save.error} />
          </form>

          {u.days.length > 0 && (
            <>
              <h3>Últimos 14 días</h3>
              <table>
                <thead><tr><th>Día</th><th>Preguntas al modelo</th><th>Tokens</th></tr></thead>
                <tbody>{u.days.map((d) => <tr key={d.day}><td>{d.day}</td><td>{num(d.requests)}</td><td>{num(d.tokens)}</td></tr>)}</tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function GeneralTab({ company, isSuper, reload }: { company: any; isSuper: boolean; reload: () => void }) {
  const [name, setName] = useState(company.name);
  const [contentUrl, setContentUrl] = useState(company.content_url ?? '');
  const [tick, setTick] = useState(0);
  const refresh = () => {
    reload();
    setTick((t) => t + 1);
  };
  const save = useAction(refresh);
  const sync = useAction(refresh);
  const toggle = useAction(refresh);
  const base = `/companies/${company.id}`;

  // Pasos pendientes calculados por el servidor (/setup) y secciones del contenido sincronizado.
  const status = useLoad(async () => {
    const [setup, content] = await Promise.all([
      api<{ ready: boolean; steps: SetupStep[] }>('GET', `${base}/setup`),
      api<{ sections: any[] }>('GET', `${base}/content`),
    ]);
    return { setup, sections: content.sections };
  }, [company.id, company.content_synced_at, company.content_url, company.active, tick]);

  const s = status.data;
  const steps = s?.setup.steps ?? [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save.run(() => api('PATCH', base, { name, contentUrl: contentUrl.trim() || null }));
  };

  return (
    <>
      <ErrorBox msg={status.error} />
      {steps.length > 0 && (
        <div className="card">
          <h2>Estado de configuración</h2>
          {s!.setup.ready ? (
            <div className="alert ok" role="status">✓ Listo para usar el chatbot.</div>
          ) : (
            <p className="muted">Completa los pasos marcados con ✗ para que el chatbot funcione en el sitio.</p>
          )}
          <ul className="checks">
            {steps.map((st) => (
              <li key={st.key} className={st.done ? 'done' : st.required ? 'todo' : 'optional'}>
                {st.done ? '✓' : st.required ? '✗' : '○'} {st.label}
                {!st.required && <small className="muted"> (opcional)</small>}
                {!st.done && st.hint && <small className="muted"> — {st.hint}</small>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <form className="card" onSubmit={submit}>
        <h2>Datos de la empresa</h2>
        <div className="grid">
          <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label="Slug"><input value={company.slug} disabled /></Field>
          <Field label="URL de chatbot-content.json" hint="Dirección del archivo que publica el sitio con sus textos, por ejemplo https://tu-sitio.com/chatbot-content.json. Su dominio debe estar en la pestaña Dominios (https).">
            <input type="url" value={contentUrl} onChange={(e) => setContentUrl(e.target.value)} />
          </Field>
        </div>
        <ErrorBox msg={save.error} />
        <button className="primary" disabled={save.busy}>Guardar</button>
        {isSuper && (
          <button type="button" onClick={() => toggle.run(() => api('PATCH', base, { active: !company.active }))}>
            {company.active ? 'Desactivar empresa' : 'Activar empresa'}
          </button>
        )}
        <Badge on={company.active} />
        <ErrorBox msg={toggle.error} />
      </form>

      <LlmUsageCard companyId={company.id} savedLimit={company.llm_daily_tokens ?? null} isSuper={isSuper} onSaved={reload} />

      {isSuper && <WebhookCard company={company} reload={reload} />}

      <div className="card">
        <h2>Contenido del chatbot</h2>
        <p>
          Estado: <strong>{company.content_status === 'ok' ? 'Sincronizado' : company.content_status === 'error' ? 'Error' : 'Nunca sincronizado'}</strong>
          {' · '}Última vez: {fmt(company.content_synced_at)}
        </p>
        {company.content_hash && <p className="muted">Hash: <code>{company.content_hash.slice(0, 16)}…</code></p>}
        {company.content_error && <div className="alert error">{company.content_error}</div>}
        <p className="muted">El chatbot responde con lo que dice el sitio. Cuando cambies los textos del sitio, vuelve a sincronizar. Guarda la URL antes de sincronizar.</p>
        <button disabled={sync.busy || !company.content_url} onClick={async () => { await sync.run(() => api('POST', `${base}/content/sync`, {})); refresh(); }}>
          {sync.busy ? 'Sincronizando…' : 'Sincronizar ahora'}
        </button>
        <ErrorBox msg={sync.error} />
        {s && s.sections.length > 0 && (
          <table>
            <thead><tr><th>Sección</th><th>Ruta</th><th>Caracteres</th></tr></thead>
            <tbody>{s.sections.map((x: any) => <tr key={x.slug}><td>{x.title}</td><td><code>{x.route}</code></td><td>{x.chars}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
