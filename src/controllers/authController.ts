import type { Request, Response } from 'express';
import type { AppDeps } from '../app-types';
import {
  createAdminSession, findAdminByEmail, registerLoginFailure, registerLoginSuccess, revokeAdminSession,
} from '../models/admins';
import { recordAudit } from '../models/audit';
import { hashToken, randomToken } from '../utils/crypto';
import { HttpError, badRequest, unauthorized } from '../utils/errors';
import { loginBody } from '../validation/schemas';
import { dummyHash, verifyPassword } from '../services/password';
import { adminCookieName, readCookie } from '../middleware/security';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

export function authController(deps: AppDeps) {
  const cookieOpts = (maxAge: number) => ({
    httpOnly: true,
    secure: deps.cfg.isProd,
    sameSite: 'strict' as const,
    path: '/',
    maxAge,
  });

  return {
    async login(req: Request, res: Response) {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) throw badRequest('Correo o contraseña inválidos');
      const { email, password } = parsed.data;
      const admin = await findAdminByEmail(deps.db, email);

      if (!admin || !admin.active) {
        await verifyPassword(await dummyHash(), password); // iguala tiempos
        throw unauthorized('Credenciales inválidas');
      }
      if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        throw new HttpError(429, 'locked', 'Cuenta bloqueada temporalmente por intentos fallidos');
      }
      if (!(await verifyPassword(admin.password_hash, password))) {
        await registerLoginFailure(deps.db, admin.id, MAX_FAILS, LOCK_MS);
        await recordAudit(deps.db, { adminId: admin.id, companyId: admin.company_id, action: 'login_failed', entity: 'admin', entityId: admin.id, ip: req.ip });
        throw unauthorized('Credenciales inválidas');
      }

      const token = randomToken();
      const csrf = randomToken(24);
      await registerLoginSuccess(deps.db, admin.id);
      await createAdminSession(deps.db, {
        adminId: admin.id, tokenHash: hashToken(deps.cfg.sessionSecret, token), csrf,
        expiresAt: new Date(Date.now() + deps.cfg.adminSessionTtlMs), ip: req.ip, userAgent: req.headers['user-agent'],
      });
      await recordAudit(deps.db, { adminId: admin.id, companyId: admin.company_id, action: 'login', entity: 'admin', entityId: admin.id, ip: req.ip });
      res.cookie(adminCookieName(deps.cfg.isProd), token, cookieOpts(deps.cfg.adminSessionTtlMs));
      const { password_hash: _p, failed_logins: _f, locked_until: _l, ...safe } = admin;
      res.json({ admin: safe, csrfToken: csrf });
    },

    async logout(req: Request, res: Response) {
      const name = adminCookieName(deps.cfg.isProd);
      const token = readCookie(req.headers.cookie, name);
      if (token) await revokeAdminSession(deps.db, hashToken(deps.cfg.sessionSecret, token));
      await recordAudit(deps.db, { adminId: req.admin!.id, companyId: req.admin!.company_id, action: 'logout', entity: 'admin', entityId: req.admin!.id, ip: req.ip });
      res.clearCookie(name, { path: '/', httpOnly: true, secure: deps.cfg.isProd, sameSite: 'strict' });
      res.json({ ok: true });
    },

    me(req: Request, res: Response) {
      res.json({ admin: req.admin, csrfToken: req.adminCsrf });
    },
  };
}
