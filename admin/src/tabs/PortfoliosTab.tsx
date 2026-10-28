import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Badge, ErrorBox, Field, useAction, useLoad } from '../ui';

/** "pago, cuota,  Pago" → ['pago', 'cuota'] (sin vacíos ni repetidos). */
export const parseAliases = (s: string): string[] => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];

export function PortfoliosTab({ companyId }: { companyId: string }) {
  const base = `/companies/${companyId}`;
  const list = useLoad(() => api<{ items: any[] }>('GET', `${base}/portfolios`), [companyId]);
  const act = useAction(list.reload);
  const create = useAction(list.reload);
  const [f, setF] = useState({ key: '', name: '', description: '', aliases: '' });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run(async () => {
      await api('POST', `${base}/portfolios`, { key: f.key, name: f.name, description: f.description, aliases: parseAliases(f.aliases) });
      setF({ key: '', name: '', description: '', aliases: '' });
    });
  };

  return (
    <>
      <ErrorBox msg={list.error || act.error} />
      <p className="muted">
        Una cartera agrupa los teléfonos y asesores que atienden a un cliente acreedor (por ejemplo, una entidad financiera). Cuando alguien
        menciona una de las palabras de la cartera en el chat, se le pasa con los asesores de esa cartera; si no, con la cartera por defecto.
      </p>
      {list.data?.items.map((p) => <PortfolioCard key={p.id} p={p} base={base} act={act} />)}
      {list.data?.items.length === 0 && <div className="card muted">Aún no hay carteras.</div>}
      <form className="card" onSubmit={submit}>
        <h2>Nueva cartera</h2>
        <div className="grid">
          <Field label="Clave" hint="minúsculas y guiones; no se puede cambiar">
            <input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={60} />
          </Field>
          <Field label="Nombre"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} /></Field>
          <Field label="Descripción" hint="Opcional; solo la ves tú"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={500} /></Field>
          <Field label="Palabras que la identifican" hint="Separadas por coma. Ej.: credivalores, crediorbe">
            <input value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} />
          </Field>
        </div>
        <ErrorBox msg={create.error} />
        <button className="primary" disabled={create.busy}>Crear cartera</button>
      </form>
    </>
  );
}

function PortfolioCard({ p, base, act }: { p: any; base: string; act: ReturnType<typeof useAction> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description ?? '');
  const [aliases, setAliases] = useState((p.aliases ?? []).join(', '));
  const patch = (b: object) => act.run(() => api('PATCH', `${base}/portfolios/${p.id}`, b));
  const cancel = () => {
    setName(p.name);
    setDescription(p.description ?? '');
    setAliases((p.aliases ?? []).join(', '));
    setEditing(false);
  };

  return (
    <div className={`card ${p.active ? '' : 'inactive'}`}>
      <h2>
        {p.name} <code>{p.key}</code> <Badge on={p.active} />{' '}
        {p.is_default && <span className="badge ok">Por defecto</span>}
      </h2>
      {editing ? (
        <div className="grid">
          <Field label="Nombre"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
          <Field label="Descripción"><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
          <Field label="Palabras que la identifican" hint="Separadas por coma"><input value={aliases} onChange={(e) => setAliases(e.target.value)} /></Field>
        </div>
      ) : (
        <>
          {p.description && <p className="muted">{p.description}</p>}
          <div className="chips" aria-label="Palabras que identifican la cartera">
            {(p.aliases ?? []).map((a: string) => <span className="chip" key={a}>{a}</span>)}
            {(p.aliases ?? []).length === 0 && <span className="muted">Sin palabras: solo recibe chats si es la cartera por defecto o desde un botón.</span>}
          </div>
        </>
      )}
      <p>
        Teléfonos activos: <strong>{p.phone_count}</strong>
      </p>
      {p.active && p.phone_count === 0 && (
        <div className="alert warn" role="status">
          Esta cartera no tiene teléfonos activos, así que nadie puede atender sus chats. Agrega un número en «Asesores y números» y elígela como cartera.
        </div>
      )}
      {editing ? (
        <>
          <button className="primary" disabled={!name.trim()} onClick={async () => { if (await patch({ name: name.trim(), description: description.trim(), aliases: parseAliases(aliases) })) setEditing(false); }}>Guardar</button>
          <button onClick={cancel}>Cancelar</button>
        </>
      ) : (
        <button onClick={() => setEditing(true)}>Editar</button>
      )}
      {!p.is_default && <button onClick={() => patch({ isDefault: true })}>Hacer por defecto</button>}
      <button disabled={p.is_default} title={p.is_default ? 'La cartera por defecto no se puede desactivar: elige otra como por defecto primero.' : undefined} onClick={() => patch({ active: !p.active })}>
        {p.active ? 'Desactivar' : 'Activar'}
      </button>
    </div>
  );
}
