import { loadConfig } from '../config/env';
import { createPgDb } from '../db';
import { createAdmin, findAdminByEmail } from '../models/admins';
import { recordAudit } from '../models/audit';
import { getCompanyBySlug } from '../models/companies';
import { hashPassword } from '../services/password';
import { promptHidden } from './prompt';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = (arg('email') ?? '').trim().toLowerCase();
  const name = (arg('name') ?? '').trim();
  const role = (arg('role') ?? 'superadmin') as 'superadmin' | 'company_admin';
  const companySlug = arg('company');
  if (!email || !name || !['superadmin', 'company_admin'].includes(role) || (role === 'company_admin' && !companySlug)) {
    console.error('Uso: npm run admin:create -- --email correo@dominio --name "Nombre" [--role superadmin|company_admin] [--company slug]');
    console.error('La contraseña se pide por consola (o ADMIN_PASSWORD en el entorno para uso no interactivo).');
    process.exit(1);
  }
  let password = process.env.ADMIN_PASSWORD ?? '';
  if (!password) {
    password = await promptHidden('Contraseña (mín. 12 caracteres): ');
    const again = await promptHidden('Repite la contraseña: ');
    if (password !== again) throw new Error('Las contraseñas no coinciden');
  }
  if (password.length < 12) throw new Error('La contraseña debe tener al menos 12 caracteres');

  const cfg = loadConfig();
  const db = createPgDb(cfg.databaseUrl);
  try {
    if (await findAdminByEmail(db, email)) throw new Error('Ya existe un administrador con ese correo');
    let companyId: string | null = null;
    if (role === 'company_admin') {
      const c = await getCompanyBySlug(db, companySlug!);
      if (!c) throw new Error(`No existe la empresa con slug "${companySlug}"`);
      companyId = c.id;
    }
    const admin = await createAdmin(db, { email, name, passwordHash: await hashPassword(password), role, companyId });
    await recordAudit(db, { adminId: null, companyId, action: 'create_cli', entity: 'admin', entityId: admin.id, after: admin });
    console.log(`Administrador creado: ${admin.email} (${admin.role})`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
