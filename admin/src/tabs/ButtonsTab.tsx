import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Badge, ErrorBox, Field, useAction, useLoad } from '../ui';

const ANY = 'Cualquier asesor (rotativo)';

function AdvisorSelect({ value, advisors, onChange, label }: { value: string; advisors: any[]; onChange: (v: string) => void; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{ANY}</option>
      {advisors.map((a) => <option key={a.id} value={a.id}>{a.name}{a.active ? '' : ' (inactivo)'}</option>)}
    </select>
  );
}

export function ButtonsTab({ companyId }: { companyId: string }) {
  const base = `/companies/${companyId}`;
  const data = useLoad(async () => {
    const [buttons, advisors] = await Promise.all([api<{ items: any[] }>('GET', `${base}/buttons`), api<{ items: any[] }>('GET', `${base}/advisors`)]);
    return { buttons: buttons.items, advisors: advisors.items };
  }, [companyId]);
  const act = useAction(data.reload);
  const create = useAction(data.reload);
  const [f, setF] = useState({ key: '', advisorId: '', label: '', color: '#0f766e', textColor: '#ffffff' });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run(async () => {
      await api('POST', `${base}/buttons`, { ...f, advisorId: f.advisorId || null });
      setF({ ...f, key: '', label: '' });
    });
  };

  return (
    <>
      <ErrorBox msg={data.error || act.error} />
      <p className="muted">Cada botón abre WhatsApp con un asesor. Si eliges «{ANY}», se reparte entre todos los asesores activos que tengan un número activo.</p>
      <div className="card">
        <h2>Botones</h2>
        <table>
          <thead><tr><th>Vista previa</th><th>Texto</th><th>Color</th><th>Texto color</th><th>Asesor</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {data.data?.buttons.map((b) => <ButtonRow key={b.id} b={b} advisors={data.data!.advisors} base={base} act={act} />)}
            {data.data?.buttons.length === 0 && <tr><td colSpan={7} className="muted">Aún no hay botones.</td></tr>}
          </tbody>
        </table>
      </div>
      <form className="card" onSubmit={submit}>
        <h2>Nuevo botón</h2>
        <div className="grid">
          <Field label="Clave" hint="minúsculas y guiones; no se puede cambiar"><input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} required pattern="[a-z0-9]+(-[a-z0-9]+)*" /></Field>
          <Field label="Texto del botón"><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required maxLength={60} /></Field>
          <Field label="Asesor">
            <AdvisorSelect value={f.advisorId} advisors={data.data?.advisors.filter((a) => a.active) ?? []} onChange={(v) => setF({ ...f, advisorId: v })} label="Asesor del botón nuevo" />
          </Field>
          <Field label="Color de fondo"><input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></Field>
          <Field label="Color del texto"><input type="color" value={f.textColor} onChange={(e) => setF({ ...f, textColor: e.target.value })} /></Field>
        </div>
        <p><span className="preview" style={{ background: f.color, color: f.textColor }}>{f.label || 'Vista previa'}</span></p>
        <ErrorBox msg={create.error} />
        <button className="primary" disabled={create.busy}>Crear botón</button>
      </form>
    </>
  );
}

function ButtonRow({ b, advisors, base, act }: { b: any; advisors: any[]; base: string; act: ReturnType<typeof useAction> }) {
  const [label, setLabel] = useState(b.label);
  const patch = (body: object) => act.run(() => api('PATCH', `${base}/buttons/${b.id}`, body));
  return (
    <tr className={b.active ? '' : 'inactive'}>
      <td><span className="preview" style={{ background: b.color, color: b.text_color }}>{b.label}</span></td>
      <td>
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        {label !== b.label && <button onClick={() => patch({ label })}>Guardar</button>}
      </td>
      <td><input type="color" value={b.color} onChange={(e) => patch({ color: e.target.value })} /></td>
      <td><input type="color" value={b.text_color} onChange={(e) => patch({ textColor: e.target.value })} /></td>
      <td>
        <AdvisorSelect value={b.advisor_id ?? ''} advisors={advisors} onChange={(v) => patch({ advisorId: v || null })} label={`Asesor de ${b.label}`} />
      </td>
      <td><Badge on={b.active} /></td>
      <td><button onClick={() => patch({ active: !b.active })}>{b.active ? 'Desactivar' : 'Activar'}</button></td>
    </tr>
  );
}
