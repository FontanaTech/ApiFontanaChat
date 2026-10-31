import { useState, type FormEvent } from 'react';
import { api } from './api';
import { Badge, ErrorBox, Field, fmt, useAction, useLoad } from './ui';

export function AdminsPage() {
  const admins = useLoad(() => api<{ items: any[] }>('GET', '/admins'), []);
  const companies = useLoad(() => api<{ items: any[] }>('GET', '/companies'), []);
  const [f, setF] = useState({ email: '', name: '', password: '', role: 'company_admin', companyId: '', advisorId: '' });
  const advisors = useLoad(
    () => f.companyId ? api<{ items: any[] }>('GET', `/companies/${f.companyId}/advisors`) : Promise.resolve({ items: [] }),
    [f.companyId],
  );
  const create = useAction(admins.reload);
  const toggle = useAction(admins.reload);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run(async () => {
      await api('POST', '/admins', {
        ...f, companyId: f.role === 'superadmin' ? null : f.companyId,
        advisorId: f.role === 'advisor' ? f.advisorId : null,
      });
      setF({ ...f, email: '', name: '', password: '' });
    });
  };
  return (
    <>
      <h1>Usuarios del panel</h1>
      <p className="muted">No existe registro público: solo un superadmin crea cuentas. El primer superadmin se crea con <code>npm run admin:create</code>.</p>
      <ErrorBox msg={admins.error || toggle.error} />
      <div className="card">
        <table>
          <thead><tr><th>Correo</th><th>Nombre</th><th>Rol</th><th>Empresa</th><th>Último acceso</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {admins.data?.items.map((a) => (
              <tr key={a.id}>
                <td>{a.email}</td><td>{a.name}</td><td>{a.role}</td>
                <td>{companies.data?.items.find((c) => c.id === a.company_id)?.name ?? '—'}</td>
                <td>{fmt(a.last_login_at)}</td>
                <td><Badge on={a.active} /></td>
                <td><button onClick={() => toggle.run(() => api('PATCH', `/admins/${a.id}`, { active: !a.active }))}>{a.active ? 'Desactivar' : 'Activar'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="card" onSubmit={submit}>
        <h2>Nuevo administrador</h2>
        <div className="grid">
          <Field label="Correo"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
          <Field label="Nombre"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          <Field label="Contraseña inicial" hint="Mínimo 12 caracteres"><input type="password" autoComplete="new-password" minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>
          <Field label="Rol">
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="company_admin">company_admin</option>
              <option value="supervisor">supervisor</option>
              <option value="advisor">advisor</option>
              <option value="superadmin">superadmin</option>
            </select>
          </Field>
          {f.role !== 'superadmin' && (
            <Field label="Empresa">
              <select value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })} required>
                <option value="">—</option>
                {companies.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          )}
          {f.role === 'advisor' && (
            <Field label="Asesor vinculado">
              <select value={f.advisorId} onChange={(e) => setF({ ...f, advisorId: e.target.value })} required>
                <option value="">—</option>
                {advisors.data?.items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <ErrorBox msg={create.error} />
        <button className="primary" disabled={create.busy}>Crear</button>
      </form>
    </>
  );
}
