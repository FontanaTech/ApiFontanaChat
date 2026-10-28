import { useState, type FormEvent } from 'react';
import { api } from './api';
import { Badge, ErrorBox, Field, fmt, useAction, useLoad } from './ui';

interface Company {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  content_status: string;
  content_synced_at: string | null;
}

export function CompaniesPage({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error, reload } = useLoad(() => api<{ items: Company[] }>('GET', '/companies'), []);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [origins, setOrigins] = useState('');
  const [contentUrl, setContentUrl] = useState('');
  const create = useAction(reload);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run(async () => {
      await api('POST', '/companies', {
        slug,
        name,
        origins: origins.split(/[\s,]+/).filter(Boolean),
        contentUrl: contentUrl.trim() || null,
      });
      setSlug(''); setName(''); setOrigins(''); setContentUrl('');
    });
  };
  const hasAagora = data?.items.some((c) => c.slug === 'aagora-bpo');

  return (
    <>
      <h1>Empresas</h1>
      <ErrorBox msg={error} />
      <div className="card">
        <table>
          <thead><tr><th>Nombre</th><th>Slug</th><th>Estado</th><th>Contenido del chat</th><th /></tr></thead>
          <tbody>
            {data?.items.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td><code>{c.slug}</code></td>
                <td><Badge on={c.active} /></td>
                <td>{c.content_status === 'ok' ? `Sincronizado ${fmt(c.content_synced_at)}` : c.content_status === 'error' ? 'Error de sincronización' : 'Sin sincronizar'}</td>
                <td><button onClick={() => onOpen(c.id)}>Abrir</button></td>
              </tr>
            ))}
            {data && data.items.length === 0 && <tr><td colSpan={5} className="muted">Aún no hay empresas.</td></tr>}
          </tbody>
        </table>
      </div>

      <form className="card" onSubmit={submit}>
        <h2>Nueva empresa</h2>
        {!hasAagora && data && (
          <p>
            <button type="button" onClick={() => { setSlug('aagora-bpo'); setName('AAgora BPO'); }}>Prellenar AAgora BPO</button>
            <span className="muted"> slug <code>aagora-bpo</code>. Los números de WhatsApp se registran después, en Asesores.</span>
          </p>
        )}
        <div className="grid">
          <Field label="Slug" hint="minúsculas, números y guiones"><input value={slug} onChange={(e) => setSlug(e.target.value)} required pattern="[a-z0-9]+(-[a-z0-9]+)*" /></Field>
          <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></Field>
          <Field label="Dominios permitidos" hint="Separados por coma. Ej. https://sitio.com, http://localhost:5173"><input value={origins} onChange={(e) => setOrigins(e.target.value)} /></Field>
          <Field label="URL de chatbot-content.json" hint="Opcional ahora; debe pertenecer a un dominio permitido"><input type="url" value={contentUrl} onChange={(e) => setContentUrl(e.target.value)} /></Field>
        </div>
        <ErrorBox msg={create.error} />
        <button className="primary" disabled={create.busy}>Crear empresa</button>
      </form>
    </>
  );
}
