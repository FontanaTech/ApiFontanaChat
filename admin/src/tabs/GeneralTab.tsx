import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Badge, ErrorBox, Field, fmt, useAction, useLoad } from '../ui';

interface SetupStep { key: string; label: string; done: boolean; required: boolean; hint: string }

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
