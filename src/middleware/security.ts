import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { AppDeps } from '../app-types';
import { HttpError, forbidden, mapDbError, notFound, unauthorized } from '../utils/errors';
import { hashToken, safeEqual } from '../utils/crypto';
import { findAdminSession } from '../models/admins';
import { getCompany, getCompanyBySlug } from '../models/companies';
import type { PublicSite } from '../services/publicCache';
import { activeOrigins } from '../models/origins';
import { findPublicSession } from '../models/public';

export const adminCookieName = (isProd: boolean) => (isProd ? '__Host-fc_admin' : 'fc_admin');

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function limiter(windowMs: number, limit: number): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Demasiadas solicitudes, intenta de nuevo en un momento' } });
    },
  });
}

/* ---------------- administración ---------------- */
export function requireAdmin(deps: AppDeps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = readCookie(req.headers.cookie, adminCookieName(deps.cfg.isProd));
      if (!token) throw unauthorized();
      const s = await findAdminSession(deps.db, hashToken(deps.cfg.sessionSecret, token));
      if (!s) throw unauthorized('Sesión expirada');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const sent = req.headers['x-csrf-token'];
        if (typeof sent !== 'string' || !safeEqual(sent, s.csrf_token)) throw forbidden('Token CSRF inválido');
      }
      req.admin = s.admin;
      req.adminCsrf = s.csrf_token;
      next();
    } catch (e) {
      next(e);
    }
  };
}

export const requireSuperadmin: RequestHandler = (req, _res, next) => {
  if (req.admin?.role !== 'superadmin') return next(forbidden('Requiere superadmin'));
  next();
};

/** Autorización por empresa: company_admin solo accede a su propia empresa (404 para no revelar otras). */
export function companyScope(deps: AppDeps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const companyId = String(req.params.companyId);
      if (!/^[0-9a-f-]{36}$/i.test(companyId)) throw notFound('Empresa no encontrada');
      const admin = req.admin!;
      if (admin.role !== 'superadmin' && admin.company_id !== companyId) throw notFound('Empresa no encontrada');
      if (!(await getCompany(deps.db, companyId))) throw notFound('Empresa no encontrada');
      req.companyId = companyId;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Un asesor usa únicamente la bandeja en vivo y lecturas auxiliares; no puede administrar la empresa. */
export const advisorPanelScope: RequestHandler = (req, _res, next) => {
  if (req.admin?.role !== 'advisor') return next();
  const path = req.path;
  const readAllowed = req.method === 'GET' && (path === '/' || path === '/live' || path === '/portfolios' || path.startsWith('/chat-sessions') || path === '/advisor-presence');
  const actionAllowed = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (path.startsWith('/chat-sessions/') || path.startsWith('/advisor-presence/'));
  if (!readAllowed && !actionAllowed) return next(forbidden('El rol asesor solo puede usar la bandeja de chats en vivo'));
  next();
};

/* ---------------- público ---------------- */
/** Empresa + orígenes activos del slug, con caché corta (se invalida desde el panel). */
async function loadSite(deps: AppDeps, slug: string): Promise<PublicSite | null> {
  const hit = deps.cache.sites.get(slug);
  if (hit) return hit;
  const company = await getCompanyBySlug(deps.db, slug);
  if (!company) return null;
  return deps.cache.sites.set(slug, { company, origins: await activeOrigins(deps.db, company.id) });
}

/** CORS por empresa: solo orígenes registrados y activos de la empresa del slug. */
export function publicGate(deps: AppDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const site = await loadSite(deps, String(req.params.slug));
      if (!site || !site.company.active) throw notFound('Empresa no encontrada');
      const origin = req.headers.origin;
      if (typeof origin !== 'string' || !site.origins.includes(origin.toLowerCase())) {
        throw new HttpError(403, 'origin_not_allowed', 'Origen no permitido');
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      req.pub = { company: site.company, origin: origin.toLowerCase() };
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requirePublicSession(deps: AppDeps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
      if (!m) throw unauthorized('Falta el token de sesión');
      const companyId = req.pub!.company.id;
      const tokenHash = hashToken(deps.cfg.sessionSecret, m[1]);
      const key = `${companyId}:${tokenHash}`;
      let session = deps.cache.sessions.get(key);
      if (session && new Date(session.expires_at) <= new Date()) session = undefined;
      if (!session) {
        const found = await findPublicSession(deps.db, companyId, tokenHash);
        if (!found) throw unauthorized('Sesión inválida o expirada');
        session = deps.cache.sessions.set(key, found);
      }
      if (session.origin !== req.pub!.origin) throw forbidden('La sesión pertenece a otro origen');
      req.pub!.session = session;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/* ---------------- errores ---------------- */
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: 'Ruta no encontrada' } });
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Solicitud demasiado grande' } });
    return;
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    res.status(400).json({ error: { code: 'bad_json', message: 'JSON inválido' } });
    return;
  }
  const mapped = mapDbError(err);
  if (mapped) {
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
    return;
  }
  console.error('[error]', err);
  res.status(500).json({ error: { code: 'internal', message: 'Error interno del servidor' } });
}
