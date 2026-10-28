import { api } from '../api';
import { ErrorBox, fmt, useLoad } from '../ui';

export function AuditTab({ companyId }: { companyId: string }) {
  const a = useLoad(() => api<{ items: any[] }>('GET', `/companies/${companyId}/audit?limit=100`), [companyId]);
  return (
    <div className="card">
      <h2>Auditoría de cambios</h2>
      <ErrorBox msg={a.error} />
      <table>
        <thead><tr><th>Fecha</th><th>Administrador</th><th>Acción</th><th>Entidad</th><th>Antes</th><th>Después</th></tr></thead>
        <tbody>
          {a.data?.items.map((r) => (
            <tr key={r.id}>
              <td>{fmt(r.created_at)}</td><td>{r.admin_email ?? 'sistema'}</td><td>{r.action}</td><td>{r.entity}</td>
              <td><code className="json">{r.before_data ? JSON.stringify(r.before_data) : '—'}</code></td>
              <td><code className="json">{r.after_data ? JSON.stringify(r.after_data) : '—'}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
