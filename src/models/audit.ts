import type { Queryable } from '../db';

export interface AuditEntry {
  adminId: string | null;
  companyId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/** Quita campos sensibles antes de persistir el diff. */
function scrub(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v ?? null;
  const o = { ...(v as Record<string, unknown>) };
  for (const k of ['password_hash', 'passwordHash', 'password', 'token_hash', 'content_json']) delete o[k];
  return o;
}

export async function recordAudit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (admin_id, company_id, action, entity, entity_id, before_data, after_data, ip)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      e.adminId, e.companyId, e.action, e.entity, e.entityId ?? null,
      JSON.stringify(scrub(e.before)), JSON.stringify(scrub(e.after)), e.ip ?? null,
    ],
  );
}

export async function listAudit(q: Queryable, companyId: string, limit: number, offset: number) {
  return (
    await q.query(
      `SELECT l.id, l.action, l.entity, l.entity_id, l.before_data, l.after_data, l.created_at, a.email AS admin_email
       FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id
       WHERE l.company_id = $1 ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`,
      [companyId, limit, offset],
    )
  ).rows;
}
