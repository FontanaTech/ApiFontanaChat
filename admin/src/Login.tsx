import { useState, type FormEvent } from 'react';
import { api, type Admin } from './api';
import { ErrorBox, Field, useAction } from './ui';

export function Login({ onLogin }: { onLogin: (a: Admin, csrf: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const { run, error, busy } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ admin: Admin; csrfToken: string }>('POST', '/auth/login', { email, password });
      onLogin(r.admin, r.csrfToken);
    });
  };
  return (
    <form className="card login" onSubmit={submit}>
      <h1>Panel Fontanachat</h1>
      <p className="muted">Acceso solo para administradores autorizados.</p>
      <Field label="Correo">
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </Field>
      <Field label="Contraseña">
        <div className="pw">
          <input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button type="button" className="eye" onClick={() => setShow(!show)} aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={show} title={show ? 'Ocultar' : 'Mostrar'}>
            {show ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </button>
        </div>
      </Field>
      <ErrorBox msg={error} />
      <button className="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
    </form>
  );
}
