import { loadConfig } from '../config/env';
import { createPgDb } from '../db';
import { findAdminByEmail, revokeAllAdminSessions } from '../models/admins';
import { recordAudit } from '../models/audit';
import { hashPassword } from '../services/password';
import { promptHidden } from './prompt';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = (arg('email') ?? '').trim().toLowerCase();
  if (!email) {
    console.error('Uso: npm run admin:password -- --email correo@dominio');
    console.error('La nueva contraseña se pide por consola (o NEW_PASSWORD en el entorno).');
    process.exit(1);
  }
  let password = process.env.NEW_PASSWORD ?? '';
  if (!password) {
    password = await promptHidden('Nueva contraseña (mín. 12 caracteres): ');
    if (password !== (await promptHidden('Repite la contraseña: '))) throw new Error('Las contraseñas no coinciden');
  }
  if (password.length < 12) throw new Error('La contraseña debe tener al menos 12 caracteres');

  const db = createPgDb(loadConfig().databaseUrl);
  try {
    const admin = await findAdminByEmail(db, email);
    if (!admin) throw new Error(`No existe un administrador con el correo ${email}`);
    await db.tx(async (q) => {
      await q.query('UPDATE admins SET password_hash = $2, failed_logins = 0, locked_until = NULL, active = true, updated_at = now() WHERE id = $1', [
        admin.id,
        await hashPassword(password),
      ]);
      await revokeAllAdminSessions(q, admin.id);
      await recordAudit(q, { adminId: null, companyId: admin.company_id, action: 'password_reset_cli', entity: 'admin', entityId: admin.id });
    });
    console.log(`Contraseña actualizada para ${email}. Sesiones anteriores cerradas y bloqueo levantado.`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
