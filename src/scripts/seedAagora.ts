import { loadConfig } from '../config/env';
import { createPgDb, type Queryable } from '../db';
import { recordAudit } from '../models/audit';
import { createButton, getButtonByKey } from '../models/catalog';
import { createCompany, getCompanyBySlug } from '../models/companies';
import { createOrigin, listOrigins } from '../models/origins';
import { originStr } from '../validation/schemas';

export const AAGORA_SLUG = 'aagora-bpo';

/** Botón inicial editable desde el panel; sin asesor fijo = reparte entre los asesores disponibles. */
export const AAGORA_BUTTON = { key: 'asesor', label: 'Hablar con un asesor', color: '#0f766e', textColor: '#ffffff' };

export async function seedAagora(q: Queryable, opts: { origins?: string[]; contentUrl?: string; withButton?: boolean }) {
  let company = await getCompanyBySlug(q, AAGORA_SLUG);
  const created = !company;
  if (!company) {
    company = await createCompany(q, { slug: AAGORA_SLUG, name: 'AAgora BPO', contentUrl: opts.contentUrl ?? null });
    await recordAudit(q, { adminId: null, companyId: company.id, action: 'seed', entity: 'company', entityId: company.id, after: company });
  }
  const existing = new Set((await listOrigins(q, company.id)).map((o) => o.origin));
  for (const raw of opts.origins ?? []) {
    const origin = originStr.parse(raw);
    if (!existing.has(origin)) await createOrigin(q, company.id, origin);
  }
  if (opts.withButton !== false && !(await getButtonByKey(q, company.id, AAGORA_BUTTON.key))) {
    await createButton(q, company.id, { ...AAGORA_BUTTON, sortOrder: 10 });
  }
  return { company, created };
}

async function main() {
  const cfg = loadConfig();
  const db = createPgDb(cfg.databaseUrl);
  try {
    const origins = (process.env.AAGORA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const { company, created } = await db.tx((q) =>
      seedAagora(q, {
        origins,
        contentUrl: process.env.AAGORA_CONTENT_URL || undefined,
        withButton: !process.argv.includes('--only-company'),
      }),
    );
    console.log(`${created ? 'Empresa creada' : 'Empresa ya existía'}: ${company.name} (${company.slug})`);
    console.log('IMPORTANTE: no se registró ningún asesor ni teléfono. Ingresa los números reales en el panel (/admin) antes de usar el chat.');
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}
