import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Badge, ErrorBox, Field, useAction, useLoad } from '../ui';

export function OriginsTab({ companyId }: { companyId: string }) {
  const base = `/companies/${companyId}/origins`;
  const list = useLoad(() => api<{ items: any[] }>('GET', base), [companyId]);
  const [origin, setOrigin] = useState('');
  const add = useAction(list.reload);
  const toggle = useAction(list.reload);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void add.run(async () => {
      await api('POST', base, { origin });
      setOrigin('');
    });
  };
  return (
    <div className="card">
      <h2>Dominios permitidos (CORS)</h2>
      <p className="muted">Solo estos orígenes pueden crear sesiones y chatear. Incluye <code>http://localhost:5173</code> para pruebas locales.</p>
      <ErrorBox msg={list.error || toggle.error} />
      <table>
        <thead><tr><th>Origen</th><th>Estado</th><th /></tr></thead>
        <tbody>
          {list.data?.items.map((o) => (
            <tr key={o.id}>
              <td><code>{o.origin}</code></td>
              <td><Badge on={o.active} /></td>
              <td><button onClick={() => toggle.run(() => api('PATCH', `${base}/${o.id}`, { active: !o.active }))}>{o.active ? 'Desactivar' : 'Activar'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={submit} className="inline">
        <Field label="Nuevo origen"><input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://tu-sitio.com" required /></Field>
        <button className="primary" disabled={add.busy}>Agregar</button>
      </form>
      <ErrorBox msg={add.error} />
    </div>
  );
}
