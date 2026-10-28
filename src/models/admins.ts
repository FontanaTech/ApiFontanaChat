import type { Queryable } from '../db';

export type Role = 'superadmin' | 'company_admin';

export interface Admin {
  id: string;
  email: string;
  name: string;
  role: Role;
  company_id: string | null;
  active: boolean;
  last_login_at: string | null;
}
export interface AdminWithSecret extends Admin {
  password_hash: string;
  failed_logins: number;
  locked_until: string | null;
}

const PUBLIC_COLS = 'id, email, name, role, company_id, active, last_login_at';

export async function findAdminByEmail(q: Queryable, email: string): Promise<AdminWithSecret | null> {
  return (
    (await q.query<AdminWithSecret>(`SELECT ${PUBLIC_COLS}, password_hash, failed_logins, locked_until FROM admins WHERE email = $1`, [email]))
      .rows[0] ?? null
  );
}

export async function listAdmins(q: Queryable): Promise<Admin[]> {
  return (await q.query<Admin>(`SELECT ${PUBLIC_COLS} FROM admins ORDER BY email`)).rows;
}

export async function createAdmin(
  q: Queryable,
  d: { email: string; name: string; passwordHash: string; role: Role; companyId: string | null },
): Promise<Admin> {
  return (
    await q.query<Admin>(
      `INSERT INTO admins (email, name, password_hash, role, company_id) VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC_COLS}`,
      [d.email, d.name, d.passwordHash, d.role, d.companyId],
    )
  ).rows[0];
}

export async function updateAdmin(
  q: Queryable,
  id: string,
  d: { name?: string; active?: boolean; passwordHash?: string },
): Promise<Admin | null> {
  return (
    (
      await q.query<Admin>(
        `UPDATE admins SET name = COALESCE($2, name), active = COALESCE($3, active),
           password_hash = COALESCE($4, password_hash), updated_at = now()
         WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
        [id, d.name ?? null, d.active ?? null, d.passwordHash ?? null],
      )
    ).rows[0] ?? null
  );
}

export async function getAdmin(q: Queryable, id: string): Promise<Admin | null> {
  return (await q.query<Admin>(`SELECT ${PUBLIC_COLS} FROM admins WHERE id = $1`, [id])).rows[0] ?? null;
}

export async function registerLoginFailure(q: Queryable, id: string, maxFails: number, lockMs: number): Promise<void> {
  await q.query(
    `UPDATE admins SET
       locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' milliseconds')::interval ELSE locked_until END,
       failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
     WHERE id = $1`,
    [id, maxFails, String(lockMs)],
  );
}

export async function registerLoginSuccess(q: Queryable, id: string): Promise<void> {
  await q.query('UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [id]);
}

/* ---------- sesiones administrativas ---------- */
export interface AdminSession {
  session_id: string;
  csrf_token: string;
  admin: Admin;
}

export async function createAdminSession(
  q: Queryable,
  d: { adminId: string; tokenHash: string; csrf: string; expiresAt: Date; ip?: string; userAgent?: string },
): Promise<void> {
  await q.query(
    'INSERT INTO admin_sessions (admin_id, token_hash, csrf_token, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
    [d.adminId, d.tokenHash, d.csrf, d.expiresAt.toISOString(), d.ip ?? null, (d.userAgent ?? '').slice(0, 300)],
  );
}

export async function findAdminSession(q: Queryable, tokenHash: string): Promise<AdminSession | null> {
  const r = await q.query<any>(
    `SELECT s.id AS session_id, s.csrf_token, a.id, a.email, a.name, a.role, a.company_id, a.active, a.last_login_at
     FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.active`,
    [tokenHash],
  );
  const row = r.rows[0];
  if (!row) return null;
  const { session_id, csrf_token, ...admin } = row;
  return { session_id, csrf_token, admin };
}

export async function revokeAdminSession(q: Queryable, tokenHash: string): Promise<void> {
  await q.query('UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1', [tokenHash]);
}

export async function revokeAllAdminSessions(q: Queryable, adminId: string): Promise<void> {
  await q.query('UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL', [adminId]);
}
