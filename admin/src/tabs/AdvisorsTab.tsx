import { useState } from 'react';
import { api } from '../api';
import { Badge, ErrorBox, Field, useAction, useLoad } from '../ui';

export function AdvisorsTab({ companyId }: { companyId: string }) {
  const base = `/companies/${companyId}`;
  const list = useLoad(() => api<{ items: any[] }>('GET', `${base}/advisors`), [companyId]);
  const [name, setName] = useState('');
  const create = useAction(list.reload);
  const act = useAction(list.reload);

  return (
    <>
      <ErrorBox msg={list.error || act.error} />
      <p className="muted">
        Agrega tus asesores y su número de WhatsApp con código de país (formato internacional). Los chats se reparten solos, por turnos,
        entre todos los asesores activos que tengan un número activo. Un cambio de número aplica de inmediato, sin tocar el sitio.
      </p>
      {list.data?.items.map((a) => <AdvisorCard key={a.id} advisor={a} base={base} act={act} />)}
      {list.data?.items.length === 0 && <div className="card muted">Aún no hay asesores.</div>}
      <form className="card inline" onSubmit={(e) => { e.preventDefault(); void create.run(async () => { await api('POST', `${base}/advisors`, { name }); setName(''); }); }}>
        <Field label="Nuevo asesor"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></Field>
        <button className="primary" disabled={create.busy}>Crear asesor</button>
        <ErrorBox msg={create.error} />
      </form>
    </>
  );
}

function AdvisorCard({ advisor, base, act }: { advisor: any; base: string; act: ReturnType<typeof useAction> }) {
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  return (
    <div className={`card ${advisor.active ? '' : 'inactive'}`}>
      <h2>{advisor.name} <Badge on={advisor.active} /></h2>
      <button onClick={() => act.run(() => api('PATCH', `${base}/advisors/${advisor.id}`, { active: !advisor.active }))}>{advisor.active ? 'Desactivar asesor' : 'Activar asesor'}</button>
      <table>
        <thead><tr><th>Número</th><th>Etiqueta</th><th>Principal</th><th>Estado</th><th /></tr></thead>
        <tbody>
          {advisor.phones.map((p: any) => <PhoneRow key={p.id} phone={p} base={base} act={act} />)}
        </tbody>
      </table>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api('POST', `${base}/phones`, { advisorId: advisor.id, number, label, isPrimary: advisor.phones.length === 0 }); setNumber(''); setLabel(''); }); }}>
        <Field label="Agregar número"><input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Código de país + número" required inputMode="tel" /></Field>
        <Field label="Etiqueta"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Opcional" maxLength={60} /></Field>
        <button className="primary">Agregar</button>
      </form>
    </div>
  );
}

function PhoneRow({ phone, base, act }: { phone: any; base: string; act: ReturnType<typeof useAction> }) {
  const [editing, setEditing] = useState(false);
  const [number, setNumber] = useState(phone.number);
  const patch = (b: object) => act.run(() => api('PATCH', `${base}/phones/${phone.id}`, b));
  return (
    <tr className={phone.active ? '' : 'inactive'}>
      <td>
        {editing ? (
          <>
            <input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="tel" />
            <button onClick={async () => { if (await patch({ number })) setEditing(false); }}>Guardar</button>
            <button onClick={() => { setNumber(phone.number); setEditing(false); }}>Cancelar</button>
          </>
        ) : (
          <code>{phone.number}</code>
        )}
      </td>
      <td>{phone.label || '—'}</td>
      <td>{phone.is_primary ? 'Sí' : <button onClick={() => patch({ isPrimary: true })}>Hacer principal</button>}</td>
      <td><Badge on={phone.active} /></td>
      <td>
        {!editing && <button onClick={() => setEditing(true)}>Cambiar número</button>}
        <button onClick={() => patch({ active: !phone.active })}>{phone.active ? 'Desactivar' : 'Activar'}</button>
      </td>
    </tr>
  );
}
