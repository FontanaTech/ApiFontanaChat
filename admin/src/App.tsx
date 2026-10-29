import { useEffect, useState } from 'react';
import { api, setCsrf, type Admin } from './api';
import { AdminsPage } from './AdminsPage';
import { CompaniesPage } from './CompaniesPage';
import { CompanyPage } from './CompanyPage';
import { GlobalUsageCard } from './GlobalUsage';
import { Login } from './Login';

export function App() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<{ page: 'companies' } | { page: 'company'; id: string } | { page: 'admins' } | { page: 'usage' }>({ page: 'companies' });

  useEffect(() => {
    api<{ admin: Admin; csrfToken: string }>('GET', '/auth/me')
      .then((r) => {
        setCsrf(r.csrfToken);
        setAdmin(r.admin);
        // company_admin entra directo a su empresa
        if (r.admin.role === 'company_admin' && r.admin.company_id) setView({ page: 'company', id: r.admin.company_id });
      })
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    const out = () => setAdmin(null);
    window.addEventListener('fc-session-expired', out);
    return () => window.removeEventListener('fc-session-expired', out);
  }, []);

  if (!ready) return <p className="center">Cargando…</p>;
  if (!admin) {
    return (
      <Login
        onLogin={(a, csrf) => {
          setCsrf(csrf);
          setAdmin(a);
          setView(a.role === 'company_admin' && a.company_id ? { page: 'company', id: a.company_id } : { page: 'companies' });
        }}
      />
    );
  }
  const logout = async () => {
    await api('POST', '/auth/logout', {}).catch(() => undefined);
    setAdmin(null);
  };
  const isSuper = admin.role === 'superadmin';
  return (
    <>
      <header className="topbar">
        <strong className="brand">Panel Fontanachat</strong>
        <nav>
          {isSuper && <button className={`link ${view.page === 'companies' || view.page === 'company' ? 'active' : ''}`} onClick={() => setView({ page: 'companies' })}>Empresas</button>}
          {isSuper && <button className={`link ${view.page === 'usage' ? 'active' : ''}`} onClick={() => setView({ page: 'usage' })}>Uso</button>}
          {isSuper && <button className={`link ${view.page === 'admins' ? 'active' : ''}`} onClick={() => setView({ page: 'admins' })}>Administradores</button>}
        </nav>
        <span className="spacer" />
        <span className="muted">{admin.email} · {admin.role}</span>
        <button onClick={logout}>Salir</button>
      </header>
      <main>
        {view.page === 'companies' && isSuper && <CompaniesPage onOpen={(id) => setView({ page: 'company', id })} />}
        {view.page === 'usage' && isSuper && (
          <>
            <h1>Uso</h1>
            <GlobalUsageCard />
          </>
        )}
        {view.page === 'admins' && isSuper && <AdminsPage />}
        {view.page === 'company' && (
          <CompanyPage key={view.id} id={view.id} admin={admin} onBack={isSuper ? () => setView({ page: 'companies' }) : undefined} />
        )}
      </main>
    </>
  );
}
