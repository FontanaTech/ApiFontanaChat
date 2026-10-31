import { loadConfig } from '../config/env';
import { createPgDb, type Queryable } from '../db';
import { createAdmin, findAdminByEmail } from '../models/admins';
import { createAdvisor, createPhone } from '../models/catalog';
import { createCompany, getCompanyBySlug } from '../models/companies';
import { createPortfolio, getDefaultPortfolio, getPortfolioByKey } from '../models/portfolios';
import { hashPassword } from '../services/password';

const companySlug = 'fontanaweb-demo';
const portfolioData = [
  { key: 'flamingo', name: 'Flamingo', people: [['Laura Gómez', '573005550101'], ['Carlos Pérez', '573005550102']] },
  { key: 'offcorss', name: 'Offcorss', people: [['Andrea Martínez', '573005550201'], ['Daniel Ruiz', '573005550202']] },
  { key: 'supra', name: 'Supra', people: [['Valentina Torres', '573005550301'], ['Miguel Castro', '573005550302']] },
  { key: 'lebon', name: 'Lebon', people: [['Sofía Ramírez', '573005550401'], ['Juan Herrera', '573005550402']] },
] as const;

export async function seedLiveDemo(q: Queryable, password = 'FontanaDemo2026!') {
  let company = await getCompanyBySlug(q, companySlug);
  if (!company) company = await createCompany(q, { slug: companySlug, name: 'FontanaWeb Demo' });
  const advisorByName = new Map<string, string>();
  for (const [index, item] of portfolioData.entries()) {
    let portfolio = await getPortfolioByKey(q, company.id, item.key);
    if (!portfolio) portfolio = await createPortfolio(q, company.id, {
      key: item.key, name: item.name, description: `Cartera ficticia ${item.name}`, aliases: [item.name.toLowerCase()],
      isDefault: index === 0 && !(await getDefaultPortfolio(q, company.id)), sortOrder: index * 10,
    });
    for (const [name, number] of item.people) {
      let advisor = (await q.query<any>('SELECT * FROM advisors WHERE company_id = $1 AND name = $2', [company.id, name])).rows[0];
      if (!advisor) advisor = await createAdvisor(q, company.id, name);
      advisorByName.set(name, advisor.id);
      const phone = await q.query('SELECT 1 FROM phones WHERE company_id = $1 AND advisor_id = $2 AND portfolio_id = $3', [company.id, advisor.id, portfolio.id]);
      if (!phone.rows[0]) await createPhone(q, company.id, { advisorId: advisor.id, number, label: 'WhatsApp de prueba', isPrimary: true, portfolioId: portfolio.id });
    }
  }
  const supra = await getPortfolioByKey(q, company.id, 'supra');
  const lebon = await getPortfolioByKey(q, company.id, 'lebon');
  if (supra && lebon) await q.query(
    `INSERT INTO advisor_portfolios (company_id, advisor_id, portfolio_id) VALUES ($1,$2,$3) ON CONFLICT (advisor_id, portfolio_id) DO NOTHING`,
    [company.id, advisorByName.get('Valentina Torres'), lebon.id],
  );
  const passwordHash = await hashPassword(password);
  const users = [
    { email: 'admin@fontanaweb.demo', name: 'Administrador general', role: 'company_admin' as const, advisorId: null },
    { email: 'flamingo@fontanaweb.demo', name: 'Asesor Flamingo', role: 'advisor' as const, advisorId: advisorByName.get('Laura Gómez')! },
    { email: 'offcorss@fontanaweb.demo', name: 'Asesor Offcorss', role: 'advisor' as const, advisorId: advisorByName.get('Andrea Martínez')! },
    { email: 'supra-lebon@fontanaweb.demo', name: 'Asesor Supra y Lebon', role: 'advisor' as const, advisorId: advisorByName.get('Valentina Torres')! },
  ];
  for (const user of users) if (!(await findAdminByEmail(q, user.email))) await createAdmin(q, {
    email: user.email, name: user.name, passwordHash, role: user.role, companyId: company.id, advisorId: user.advisorId,
  });
  return { company, users: users.map(({ email, role }) => ({ email, role })), password };
}

async function main() {
  const cfg = loadConfig();
  const db = createPgDb(cfg.databaseUrl);
  try {
    const result = await db.tx((q) => seedLiveDemo(q, process.env.LIVE_DEMO_PASSWORD || undefined));
    console.log(`Seed listo: ${result.company.name} (${result.company.slug})`);
    console.log(`Contraseña de prueba: ${result.password}`);
    for (const user of result.users) console.log(`- ${user.email} (${user.role})`);
  } finally { await db.close(); }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });

