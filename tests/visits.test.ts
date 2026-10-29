import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseUserAgent } from '../src/utils/userAgent';
import { adminApi, createEnv, login, makeAdmin, setupCompany, type Fixture, type TestEnv } from './helpers';

const UA_CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let env: TestEnv;
let sup: ReturnType<typeof adminApi>;
let F: Fixture;
const ORIGIN = 'https://site-visitas.test';
const base = '/api/v1/public/co-v';

/** Un visitante: misma IP y user-agent; cada `tab()` abre una sesión nueva (otra pestaña o recarga). */
const visitor = (ip: string, ua: string) => ({
  async tab() {
    const s = await request(env.app).post(`${base}/sessions`).set('Origin', ORIGIN).set('User-Agent', ua).set('X-Forwarded-For', ip).send({ pagePath: '/' });
    expect(s.status).toBe(201);
    const auth = (r: request.Test) => r.set('Origin', ORIGIN).set('User-Agent', ua).set('X-Forwarded-For', ip).set('Authorization', `Bearer ${s.body.token}`);
    return { event: (type: string, path = '/') => auth(request(env.app).post(`${base}/events`)).send({ type, path }) };
  },
});
const metrics = async () => (await sup.get(`/companies/${F.companyId}/metrics`)).body;

beforeAll(async () => {
  env = await createEnv({ trustProxy: 1 } as any);
  await makeAdmin(env, { email: 'root@test.local', role: 'superadmin' });
  sup = adminApi(env, await login(env, 'root@test.local'));
  F = await setupCompany(env, sup, { slug: 'co-v', name: 'Empresa V', origin: ORIGIN, advisors: 1 });
});
afterAll(async () => {
  await env.db.close();
});

describe('user-agent', () => {
  it('identifica navegador, sistema y dispositivo', () => {
    expect(parseUserAgent(UA_CHROME_WIN)).toEqual({ browser: 'Chrome', os: 'Windows', device: 'desktop' });
    expect(parseUserAgent(UA_EDGE).browser).toBe('Edge');
    expect(parseUserAgent(UA_SAFARI_IPHONE)).toEqual({ browser: 'Safari', os: 'iOS', device: 'mobile' });
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/126.0 Safari/537.36').device).toBe('tablet');
    expect(parseUserAgent(UA_BOT).device).toBe('bot');
    expect(parseUserAgent(undefined).device).toBe('bot');
  });
});

describe('ingresos únicos', () => {
  it('cambiar de vista, recargar o abrir otra pestaña no es un ingreso nuevo', async () => {
    const v = visitor('203.0.113.10', UA_CHROME_WIN);
    const tab1 = await v.tab();
    for (const path of ['/', '/servicios', '/nosotros', '/contacto']) expect((await tab1.event('page_view', path)).status).toBe(202);
    const tab2 = await v.tab(); // otra pestaña, misma IP y navegador
    await tab2.event('page_view', '/servicios');
    const m = await metrics();
    expect(m.counts.page_view).toBe(5); // vistas de página
    expect(m.counts.visit).toBe(1); // un solo ingreso
    expect(m.sessions.visit).toBe(1); // un solo visitante
  });

  it('otro navegador o dispositivo (u otra IP) sí es otro ingreso, y se desglosa por dispositivo y navegador', async () => {
    await (await visitor('203.0.113.10', UA_EDGE).tab()).event('page_view'); // misma IP, otro navegador
    await (await visitor('198.51.100.7', UA_SAFARI_IPHONE).tab()).event('page_view'); // otra IP, un celular
    const m = await metrics();
    expect(m.counts.visit).toBe(3);
    expect(m.sessions.visit).toBe(3);
    expect(Object.fromEntries(m.byDevice.map((x: any) => [x.name, x.visits]))).toEqual({ desktop: 2, mobile: 1 });
    expect(Object.fromEntries(m.byBrowser.map((x: any) => [x.name, x.visits]))).toEqual({ Chrome: 1, Edge: 1, Safari: 1 });
    expect(m.byDay.find((d: any) => d.type === 'visit').total).toBe(3);
  });

  it('el chat y los botones cuentan como actividad: no abren otro ingreso', async () => {
    const tab = await visitor('203.0.113.10', UA_CHROME_WIN).tab();
    await tab.event('chat_open');
    await tab.event('page_view', '/otra');
    expect((await metrics()).counts.visit).toBe(3);
  });

  it('tras 30 minutos sin actividad vuelve a contarse como ingreso', async () => {
    await env.db.query(`UPDATE events SET created_at = now() - interval '31 minutes' WHERE visitor_hash IS NOT NULL`);
    const tab = await visitor('203.0.113.10', UA_CHROME_WIN).tab();
    await tab.event('page_view');
    expect((await metrics()).counts.visit).toBe(4);
  });

  it('los bots no cuentan como ingresos', async () => {
    const before = (await metrics()).counts.visit;
    await (await visitor('192.0.2.99', UA_BOT).tab()).event('page_view');
    expect((await metrics()).counts.visit).toBe(before);
  });

  it('no guarda la IP en claro: solo una huella irreversible distinta en cada empresa', async () => {
    const row = (await env.db.query<Record<string, string>>(`SELECT * FROM public_sessions WHERE visitor_hash IS NOT NULL LIMIT 1`)).rows[0];
    expect(JSON.stringify(row)).not.toContain('203.0.113');
    expect(row.visitor_hash).toMatch(/^[0-9a-f]{32}$/);
    const expected = createHmac('sha256', env.cfg.sessionSecret).update(`visitor|${F.companyId}|203.0.113.10|${UA_CHROME_WIN}`).digest('hex').slice(0, 32);
    expect((await env.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public_sessions WHERE visitor_hash = $1`, [expected])).rows[0].n).toBeGreaterThan(0);
  });

  it('el listado de eventos muestra navegador, sistema, dispositivo e ingreso', async () => {
    const items = (await sup.get(`/companies/${F.companyId}/events?limit=50`)).body.items;
    const visit = items.find((e: any) => e.is_visit && e.device === 'mobile');
    expect(visit).toMatchObject({ browser: 'Safari', os: 'iOS', type: 'page_view' });
  });
});
