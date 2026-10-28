import { useState } from 'react';
import { api, type Admin } from './api';
import { AdvisorsTab } from './tabs/AdvisorsTab';
import { AuditTab } from './tabs/AuditTab';
import { ButtonsTab } from './tabs/ButtonsTab';
import { GeneralTab } from './tabs/GeneralTab';
import { MetricsTab } from './tabs/MetricsTab';
import { OriginsTab } from './tabs/OriginsTab';
import { RecordsTab } from './tabs/RecordsTab';
import { ErrorBox, useLoad } from './ui';

const TABS = [
  ['general', 'General'],
  ['origins', 'Dominios'],
  ['advisors', 'Asesores y números'],
  ['buttons', 'Botones'],
  ['records', 'Registros'],
  ['metrics', 'Métricas'],
  ['audit', 'Auditoría'],
] as const;
type TabKey = (typeof TABS)[number][0];

export function CompanyPage({ id, admin, onBack }: { id: string; admin: Admin; onBack?: () => void }) {
  const company = useLoad(() => api('GET', `/companies/${id}`), [id]);
  const [tab, setTab] = useState<TabKey>('general');
  const c = company.data;

  return (
    <>
      {onBack && <button className="link" onClick={onBack}>← Empresas</button>}
      <h1>{c ? c.name : 'Empresa'} {c && <small className="muted"><code>{c.slug}</code></small>}</h1>
      <ErrorBox msg={company.error} />
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {c && (
        <section>
          {tab === 'general' && <GeneralTab company={c} isSuper={admin.role === 'superadmin'} reload={company.reload} />}
          {tab === 'origins' && <OriginsTab companyId={id} />}
          {tab === 'advisors' && <AdvisorsTab companyId={id} />}
          {tab === 'buttons' && <ButtonsTab companyId={id} />}
          {tab === 'records' && <RecordsTab companyId={id} />}
          {tab === 'metrics' && <MetricsTab companyId={id} />}
          {tab === 'audit' && <AuditTab companyId={id} />}
        </section>
      )}
    </>
  );
}
