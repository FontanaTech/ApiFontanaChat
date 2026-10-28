import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app';
import type { AppDeps } from '../src/app-types';
import { loadConfig, type Config } from '../src/config/env';
import type { Db, Queryable } from '../src/db';
import { runMigrations } from '../src/db/migrate';
import { createAdmin } from '../src/models/admins';
import { hashPassword } from '../src/services/password';
import type { ContentFetcher } from '../src/services/contentSync';
import type { LlmClient, LlmMessage } from '../src/services/ollama';
import { LlmUnavailableError } from '../src/services/ollama';

/** Base Postgres real (PGlite) en memoria; aplica las mismas migraciones SQL que Neon. */
export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  const wrap = (c: any): Queryable => ({
    async query(sql, params) {
      const r = await c.query(sql, params);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql) {
      await c.exec(sql);
    },
  });
  const db: Db = {
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
  await runMigrations(db);
  return db;
}

/** Números sintéticos solo para pruebas (nunca reales). */
export const fakePhone = (n: number) => `91${String(n).padStart(8, '0')}`;

export interface TestEnv {
  db: Db;
  app: ReturnType<typeof createApp>;
  cfg: Config;
  llm: { impl: (m: LlmMessage[]) => Promise<string>; calls: LlmMessage[][]; tokens: number };
  fetcher: { impl: ContentFetcher; calls: string[] };
}

export async function createEnv(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const db = await createTestDb();
  const cfg = loadConfig(
    { NODE_ENV: 'test', SESSION_SECRET: 'test-secret-test-secret-test-secret-123' } as any,
    { serveAdmin: false, chatFastScore: 0, rate: { windowMs: 60_000, general: 100000, sessions: 100000, chat: 100000, login: 100000 }, ...overrides },
  );
  const llm: TestEnv['llm'] = {
    calls: [],
    tokens: 1500,
    impl: async () => {
      throw new LlmUnavailableError('no configurado en prueba');
    },
  };
  const fetcher: TestEnv['fetcher'] = { calls: [], impl: async () => '{}' };
  const llmClient: LlmClient = {
    chatJson: async (m, meta) => {
      llm.calls.push(m);
      const out = await llm.impl(m);
      if (meta) meta.tokens = llm.tokens;
      return out;
    },
  };
  const deps: Omit<AppDeps, 'cache' | 'budget'> = {
    cfg, db, llm: llmClient,
    contentFetcher: (url) => {
      fetcher.calls.push(url);
      return fetcher.impl(url);
    },
  };
  return { db, app: createApp(deps), cfg, llm, fetcher };
}

export interface AdminSession {
  cookie: string;
  csrf: string;
}

export async function makeAdmin(
  env: TestEnv,
  d: { email: string; role: 'superadmin' | 'company_admin'; companyId?: string; password?: string },
) {
  const password = d.password ?? 'correct-horse-battery';
  await createAdmin(env.db, {
    email: d.email, name: d.email, passwordHash: await hashPassword(password), role: d.role, companyId: d.companyId ?? null,
  });
  return { email: d.email, password };
}

export async function login(env: TestEnv, email: string, password = 'correct-horse-battery'): Promise<AdminSession> {
  const res = await request(env.app).post('/api/v1/admin/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login falló: ${res.status} ${JSON.stringify(res.body)}`);
  return { cookie: String(res.headers['set-cookie'][0]).split(';')[0], csrf: res.body.csrfToken };
}

export function adminApi(env: TestEnv, s: AdminSession) {
  const base = '/api/v1/admin';
  const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: unknown) => {
    const r = (request(env.app) as any)[method](base + path).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
    return body === undefined ? r : r.send(body);
  };
  return {
    get: (p: string) => call('get', p),
    post: (p: string, b?: unknown) => call('post', p, b ?? {}),
    patch: (p: string, b: unknown) => call('patch', p, b),
    put: (p: string, b: unknown) => call('put', p, b),
    del: (p: string) => call('delete', p),
  };
}

/** Cliente público simulado: lleva Origin y token de sesión. */
export async function publicClient(env: TestEnv, slug: string, origin: string) {
  const base = `/api/v1/public/${slug}`;
  const res = await request(env.app).post(`${base}/sessions`).set('Origin', origin).send({ pagePath: '/' });
  if (res.status !== 201) throw new Error(`sesión pública falló: ${res.status} ${JSON.stringify(res.body)}`);
  const token: string = res.body.token;
  const withAuth = (r: request.Test) => r.set('Origin', origin).set('Authorization', `Bearer ${token}`);
  return {
    token,
    get: (p: string) => withAuth(request(env.app).get(base + p)),
    post: (p: string, b: unknown = {}, headers: Record<string, string> = {}) => {
      let r = withAuth(request(env.app).post(base + p));
      for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
      return r.send(b as object);
    },
  };
}

export interface Fixture {
  companyId: string;
  slug: string;
  origin: string;
  admin: ReturnType<typeof adminApi>;
  advisorIds: string[];
  phoneIds: string[];
  advisorId?: string;
  phoneId?: string;
}

/** Crea una empresa con origen y (opcional) N asesores con teléfono principal y un botón rotativo. */
export async function setupCompany(
  env: TestEnv,
  sup: ReturnType<typeof adminApi>,
  d: { slug: string; name: string; origin: string; advisors?: number; button?: string },
): Promise<Fixture> {
  const c = await sup.post('/companies', { slug: d.slug, name: d.name, origins: [d.origin] });
  if (c.status !== 201) throw new Error(`crear empresa: ${JSON.stringify(c.body)}`);
  const companyId = c.body.id as string;
  const fx: Fixture = { companyId, slug: d.slug, origin: d.origin, admin: sup, advisorIds: [], phoneIds: [] };
  let phoneSeq = Math.floor(Math.random() * 1000) * 10;
  for (let i = 0; i < (d.advisors ?? 0); i++) {
    const adv = await sup.post(`/companies/${companyId}/advisors`, { name: `Asesor ${d.slug} ${i}` });
    const ph = await sup.post(`/companies/${companyId}/phones`, { advisorId: adv.body.id, number: fakePhone(++phoneSeq), isPrimary: true });
    fx.advisorIds.push(adv.body.id);
    fx.phoneIds.push(ph.body.id);
  }
  fx.advisorId = fx.advisorIds[0];
  fx.phoneId = fx.phoneIds[0];
  if (d.button) await sup.post(`/companies/${companyId}/buttons`, { key: d.button, label: d.button });
  return fx;
}
