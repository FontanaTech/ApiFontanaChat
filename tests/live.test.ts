import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLiveBus, type LiveBus } from '../src/services/liveEvents';
import { adminApi, createEnv, login, makeAdmin, publicClient, setupCompany, type Fixture, type TestEnv } from './helpers';

let env: TestEnv;
let server: http.Server;
let port: number;
let cookie: string;
let A: Fixture;
let B: Fixture;

/** Conexión SSE real: acumula el texto recibido. */
function openStream(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: () => string; ended: () => boolean; close: () => void }>((resolve, reject) => {
    let body = '';
    let done = false;
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => (done = true));
      res.on('close', () => (done = true));
      resolve({ status: res.statusCode ?? 0, text: () => body, ended: () => done, close: () => req.destroy() });
    });
    req.on('error', (e) => (done ? undefined : reject(e)));
  });
}
const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};
/** Eventos `data:` recibidos, ya interpretados. */
const parsed = (text: string) => [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]));

beforeAll(async () => {
  env = await createEnv();
  await makeAdmin(env, { email: 'root@test.local', role: 'superadmin' });
  const s = await login(env, 'root@test.local');
  cookie = s.cookie;
  const sup = adminApi(env, s);
  A = await setupCompany(env, sup, { slug: 'co-live-a', name: 'Live A', origin: 'https://live-a.test', advisors: 1 });
  B = await setupCompany(env, sup, { slug: 'co-live-b', name: 'Live B', origin: 'https://live-b.test', advisors: 1 });
  server = env.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  (env.app.locals.live as LiveBus).closeAll();
  server.close();
  await env.db.close();
});

const livePath = (f: Fixture) => `/api/v1/admin/companies/${f.companyId}/live`;

describe('canal en vivo (SSE)', () => {
  it('exige sesión de administrador y acceso a la empresa', async () => {
    expect((await openStream(livePath(A))).status).toBe(401);
    await makeAdmin(env, { email: 'b@test.local', role: 'company_admin', companyId: B.companyId });
    const other = (await login(env, 'b@test.local')).cookie;
    const r = await openStream(livePath(A), { Cookie: other });
    expect(r.status).not.toBe(200);
    r.close();
  });

  it('entrega al instante los eventos de la empresa, sin los de otra', async () => {
    const stream = await openStream(livePath(A), { Cookie: cookie });
    expect(stream.status).toBe(200);
    await until(() => stream.text().includes(': conectado'));

    const a = await publicClient(env, 'co-live-a', A.origin);
    const b = await publicClient(env, 'co-live-b', B.origin);
    await b.post('/events', { type: 'chat_open' }); // otra empresa: no debe llegar
    await a.post('/events', { type: 'page_view', path: '/servicios' });
    await a.post('/events', { type: 'chat_open' });
    const h = await a.post('/handoffs', { name: 'Ana' }, { 'Idempotency-Key': 'live-handoff-0001' });
    await a.post(`/handoffs/${h.body.handoffId}/whatsapp-click`, {});
    await until(() => parsed(stream.text()).length >= 4);

    const events = parsed(stream.text());
    expect(events.map((e) => e.type)).toEqual(['page_view', 'chat_open', 'handoff_created', 'whatsapp_click']);
    expect(events[0]).toMatchObject({ data: { path: '/servicios', isVisit: true, device: 'desktop', browser: 'Chrome', os: 'Windows' } });
    expect(events[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stream.text()).toContain('event: page_view');
    expect(JSON.stringify(events)).not.toMatch(/wa\.me/); // nunca el teléfono del asesor
    stream.close();
  });

  it('un segundo page_view del mismo visitante llega como vista, no como ingreso', async () => {
    const stream = await openStream(livePath(A), { Cookie: cookie });
    await until(() => stream.text().includes(': conectado'));
    await (await publicClient(env, 'co-live-a', A.origin)).post('/events', { type: 'page_view', path: '/nosotros' });
    await until(() => parsed(stream.text()).length >= 1);
    expect(parsed(stream.text())[0].data).toMatchObject({ path: '/nosotros', isVisit: false });
    stream.close();
  });

  it('publicar no consulta la base de datos', async () => {
    const stream = await openStream(livePath(A), { Cookie: cookie });
    await until(() => stream.text().includes(': conectado'));
    let queries = 0;
    const original = env.db.query.bind(env.db);
    env.db.query = ((...args: Parameters<typeof original>) => (queries++, original(...args))) as typeof env.db.query;
    (env.app.locals.live as LiveBus).publish(A.companyId, 'chat_open', { path: '/' });
    await until(() => parsed(stream.text()).some((e) => e.type === 'chat_open'));
    env.db.query = original;
    expect(queries).toBe(0);
    stream.close();
  });

  it('al apagar el servidor las conexiones se cierran', async () => {
    const stream = await openStream(livePath(A), { Cookie: cookie });
    await until(() => stream.text().includes(': conectado'));
    (env.app.locals.live as LiveBus).closeAll();
    await until(() => stream.ended());
  });
});

describe('bus de eventos', () => {
  it('respeta el tope de conexiones y libera el cupo al darse de baja', () => {
    const bus = createLiveBus(2, 1);
    const sub = { send: () => undefined, close: () => undefined };
    const off = bus.subscribe('c1', sub);
    expect(off).toBeTypeOf('function');
    expect(bus.subscribe('c1', sub)).toBeNull(); // tope por empresa
    expect(bus.subscribe('c2', { ...sub })).toBeTypeOf('function');
    expect(bus.subscribe('c3', { ...sub })).toBeNull(); // tope total
    off!();
    expect(bus.count()).toBe(1);
    expect(bus.subscribe('c3', { ...sub })).toBeTypeOf('function');
  });

  it('publicar sin suscriptores no hace nada', () => {
    expect(() => createLiveBus().publish('nadie', 'chat_open', {})).not.toThrow();
  });
});
