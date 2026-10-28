import { createServer } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminApi, createEnv, fakePhone, login, makeAdmin, publicClient, setupCompany, type Fixture, type TestEnv,
} from './helpers';
import { loadConfig } from '../src/config/env';
import { LlmUnavailableError, createOllamaClient } from '../src/services/ollama';
import { createLlmClient, createOpenAiCompatClient } from '../src/services/llm';

const ORIGIN_A = 'https://site-a.test';
const ORIGIN_B = 'https://site-b.test';

let env: TestEnv;
let sup: ReturnType<typeof adminApi>;
let A: Fixture;
let B: Fixture;

const contentFor = (slug: string) =>
  JSON.stringify({
    slug,
    siteName: slug,
    sections: [
      { slug: 'servicios', title: 'Nuestros servicios', route: '/servicios', text: 'Ofrecemos gestión de cartera y atención telefónica de lunes a viernes.' },
      { slug: 'nosotros', title: 'Quiénes somos', route: '/nosotros', text: 'Somos una empresa dedicada a la recuperación de cartera.' },
    ],
  });

beforeAll(async () => {
  env = await createEnv();
  await makeAdmin(env, { email: 'root@test.local', role: 'superadmin' });
  sup = adminApi(env, await login(env, 'root@test.local'));
  A = await setupCompany(env, sup, { slug: 'co-a', name: 'Empresa A', origin: ORIGIN_A, advisors: 2, button: 'contacto' });
  B = await setupCompany(env, sup, { slug: 'co-b', name: 'Empresa B', origin: ORIGIN_B, advisors: 1, button: 'contacto-b' });
});
afterAll(async () => {
  await env.db.close();
});

describe('salud y base', () => {
  it('GET /health responde ok', async () => {
    const r = await request(env.app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', db: 'up' });
  });
  it('rechaza cuerpos demasiado grandes', async () => {
    const big = { name: 'x'.repeat(40_000) };
    const r = await request(env.app).post('/api/v1/admin/auth/login').send(big);
    expect(r.status).toBe(413);
  });
});

describe('autenticación administrativa', () => {
  it('no existe alta pública de administradores', async () => {
    const r = await request(env.app).post('/api/v1/admin/admins').send({ email: 'x@y.co', name: 'x', password: 'abcdefghijkl', role: 'superadmin' });
    expect(r.status).toBe(401);
  });
  it('login inválido da 401 y mensaje genérico', async () => {
    const r = await request(env.app).post('/api/v1/admin/auth/login').send({ email: 'root@test.local', password: 'incorrecta-12345' });
    expect(r.status).toBe(401);
    const r2 = await request(env.app).post('/api/v1/admin/auth/login').send({ email: 'no@existe.co', password: 'incorrecta-12345' });
    expect(r2.body.error.message).toBe(r.body.error.message);
  });
  it('las mutaciones exigen token CSRF', async () => {
    const s = await login(env, 'root@test.local');
    const r = await request(env.app).post('/api/v1/admin/companies').set('Cookie', s.cookie).send({ slug: 'zz', name: 'ZZ' });
    expect(r.status).toBe(403);
  });
  it('bloquea la cuenta tras intentos fallidos', async () => {
    await makeAdmin(env, { email: 'lock@test.local', role: 'superadmin' });
    for (let i = 0; i < 5; i++) await request(env.app).post('/api/v1/admin/auth/login').send({ email: 'lock@test.local', password: 'mala-mala-mala-1' });
    const r = await request(env.app).post('/api/v1/admin/auth/login').send({ email: 'lock@test.local', password: 'correct-horse-battery' });
    expect(r.status).toBe(429);
  });
  it('guarda contraseñas con Argon2id', async () => {
    const r = await env.db.query<{ password_hash: string }>("SELECT password_hash FROM admins WHERE email = 'root@test.local'");
    expect(r.rows[0].password_hash.startsWith('$argon2id$')).toBe(true);
  });
  it('company_admin no puede crear empresas ni administradores', async () => {
    await makeAdmin(env, { email: 'adm-a@test.local', role: 'company_admin', companyId: A.companyId });
    const a = adminApi(env, await login(env, 'adm-a@test.local'));
    expect((await a.post('/companies', { slug: 'nueva', name: 'Nueva' })).status).toBe(403);
    expect((await a.get('/admins')).status).toBe(403);
    expect((await a.patch(`/companies/${A.companyId}`, { active: false })).status).toBe(403);
  });
});

describe('aislamiento entre empresas', () => {
  let adminA: ReturnType<typeof adminApi>;
  beforeAll(async () => {
    await makeAdmin(env, { email: 'iso-a@test.local', role: 'company_admin', companyId: A.companyId });
    adminA = adminApi(env, await login(env, 'iso-a@test.local'));
  });

  it('el admin de A solo lista su empresa', async () => {
    const r = await adminA.get('/companies');
    expect(r.body.items.map((c: any) => c.slug)).toEqual(['co-a']);
  });
  it('el admin de A no lee ni modifica datos de B (404)', async () => {
    for (const path of ['', '/advisors', '/buttons', '/origins', '/handoffs', '/events', '/metrics', '/audit', '/setup']) {
      expect((await adminA.get(`/companies/${B.companyId}${path}`)).status, path).toBe(404);
    }
    expect((await adminA.patch(`/companies/${B.companyId}`, { name: 'hackeada' })).status).toBe(404);
    expect((await adminA.post(`/companies/${B.companyId}/buttons`, { key: 'x1', label: 'X' })).status).toBe(404);
    expect((await adminA.post(`/companies/${B.companyId}/advisors`, { name: 'Intruso' })).status).toBe(404);
  });
  it('no se puede usar un id de otra empresa dentro de la propia', async () => {
    const advB = (await sup.get(`/companies/${B.companyId}/advisors`)).body.items[0];
    const btnB = (await sup.get(`/companies/${B.companyId}/buttons`)).body.items[0];
    // botón de B referenciado desde la ruta de A
    expect((await adminA.patch(`/companies/${A.companyId}/buttons/${btnB.id}`, { label: 'robado' })).status).toBe(404);
    // asesor de B usado en un botón o teléfono de A
    expect((await adminA.post(`/companies/${A.companyId}/buttons`, { key: 'cruzado', advisorId: advB.id, label: 'X' })).status).toBe(404);
    expect((await adminA.post(`/companies/${A.companyId}/phones`, { advisorId: advB.id, number: fakePhone(77), isPrimary: false })).status).toBe(404);
    expect((await adminA.patch(`/companies/${A.companyId}/phones/${advB.phones[0].id}`, { label: 'x' })).status).toBe(404);
    expect((await sup.get(`/companies/${B.companyId}/buttons`)).body.items[0].label).toBe('contacto-b');
  });
  it('FK compuestas de la base impiden cruzar empresas aunque falle la app', async () => {
    const advB = (await sup.get(`/companies/${B.companyId}/advisors`)).body.items[0];
    await expect(
      env.db.query('INSERT INTO buttons (company_id, key, advisor_id, label) VALUES ($1, $2, $3, $4)', [A.companyId, 'sql-cruzado', advB.id, 'X']),
    ).rejects.toThrow();
  });
  it('la sesión pública de A no sirve en B ni expone botones de B', async () => {
    const a = await publicClient(env, 'co-a', ORIGIN_A);
    const cross = await request(env.app).get('/api/v1/public/co-b/config').set('Origin', ORIGIN_B).set('Authorization', `Bearer ${a.token}`);
    expect(cross.status).toBe(401);
    const cfg = await a.get('/config');
    expect(cfg.body.buttons.map((b: any) => b.label)).not.toContain('contacto-b');
    const wrongOrigin = await request(env.app).get('/api/v1/public/co-a/config').set('Origin', ORIGIN_B).set('Authorization', `Bearer ${a.token}`);
    expect(wrongOrigin.status).toBe(403);
  });
  it('un handoff en A nunca asigna un teléfono de B', async () => {
    const phonesB = (await sup.get(`/companies/${B.companyId}/advisors`)).body.items.flatMap((x: any) => x.phones.map((p: any) => p.number));
    const a = await publicClient(env, 'co-a', ORIGIN_A);
    const r = await a.post('/handoffs', { name: 'Persona Uno', reason: 'consulta de prueba' }, { 'Idempotency-Key': 'iso-key-0001' });
    expect(r.status).toBe(201);
    for (const p of phonesB) expect(r.body.waUrl).not.toContain(p);
    // un botón de B no se puede usar desde A
    const rb = await a.post('/handoffs', { buttonKey: 'contacto-b', name: 'Persona Uno', reason: 'x'.repeat(5) }, { 'Idempotency-Key': 'iso-key-0002' });
    expect(rb.status).toBe(400);
  });
  it('métricas y registros de A no incluyen datos de B', async () => {
    const b = await publicClient(env, 'co-b', ORIGIN_B);
    await b.post('/events', { type: 'page_view' });
    const mA = (await sup.get(`/companies/${A.companyId}/metrics`)).body;
    const mB = (await sup.get(`/companies/${B.companyId}/metrics`)).body;
    expect(mB.counts.page_view).toBe(1);
    expect(mA.counts.page_view ?? 0).toBe(0);
  });
});

describe('derivación a WhatsApp', () => {
  let F: Fixture;
  beforeAll(async () => {
    F = await setupCompany(env, sup, { slug: 'co-h', name: 'Empresa H', origin: 'https://site-h.test', advisors: 1 });
  });

  it('usa el teléfono vigente de la base: un cambio aplica sin recompilar el sitio', async () => {
    const c = await publicClient(env, 'co-h', F.origin);
    const first = await c.post('/handoffs', { name: 'Ana', reason: 'quiero información' }, { 'Idempotency-Key': 'tel-key-0001' });
    const oldNumber = (await env.db.query<{ number: string }>('SELECT number FROM phones WHERE id = $1', [F.phoneId])).rows[0].number;
    expect(first.body.waUrl.startsWith(`https://wa.me/${oldNumber}?text=`)).toBe(true);

    const newNumber = fakePhone(424242);
    const up = await sup.patch(`/companies/${F.companyId}/phones/${F.phoneId}`, { number: `+${newNumber.slice(0, 2)} ${newNumber.slice(2)}` });
    expect(up.status).toBe(200);

    const second = await c.post('/handoffs', { name: 'Ana', reason: 'quiero información' }, { 'Idempotency-Key': 'tel-key-0002' });
    expect(second.body.waUrl.startsWith(`https://wa.me/${newNumber}?text=`)).toBe(true);
    expect(decodeURIComponent(second.body.waUrl)).toContain('Ana');
    // la derivación anterior conserva el número con el que se creó (historial)
    const hist = await env.db.query('SELECT phone_number FROM handoffs WHERE idempotency_key = $1', ['tel-key-0001']);
    expect(hist.rows[0].phone_number).toBe(oldNumber);
  });

  it('asesor inactivo: no se asigna, el contacto queda no disponible y el chat no ofrece números', async () => {
    const G = await setupCompany(env, sup, { slug: 'co-i', name: 'Empresa I', origin: 'https://site-i.test', advisors: 1, button: 'contacto' });
    const c = await publicClient(env, 'co-i', G.origin);
    const cfg = (await c.get('/config')).body;
    expect(cfg.available).toBe(true);
    expect(cfg.buttons[0].available).toBe(true);
    await sup.patch(`/companies/${G.companyId}/advisors/${G.advisorId}`, { active: false });
    const h = await c.post('/handoffs', { name: 'Luis', reason: 'quiero pagar' }, { 'Idempotency-Key': 'inact-key-001' });
    expect(h.status).toBe(409);
    expect(h.body.error.code).toBe('no_advisor_available');
    const cfg2 = (await c.get('/config')).body;
    expect(cfg2.available).toBe(false);
    expect(cfg2.buttons[0].available).toBe(false);
    const chat = await c.post('/chat', { message: 'quiero hablar con un asesor' });
    expect(chat.body.type).toBe('fallback');
    expect(chat.body.waUrl).toBeUndefined();
    expect(JSON.stringify(chat.body)).not.toMatch(/\d{8,}/);
    // teléfono inactivo también excluye
    await sup.patch(`/companies/${G.companyId}/advisors/${G.advisorId}`, { active: true });
    await sup.patch(`/companies/${G.companyId}/phones/${G.phoneId}`, { active: false });
    const h2 = await c.post('/handoffs', { name: 'Luis', reason: 'quiero pagar' }, { 'Idempotency-Key': 'inact-key-002' });
    expect(h2.status).toBe(409);
  });

  it('doble handoff con la misma clave es idempotente (también en paralelo)', async () => {
    const c = await publicClient(env, 'co-a', ORIGIN_A);
    const body = { name: 'Marta', reason: 'consulta idempotente' };
    const cursor = async () => (await env.db.query<{ rr_cursor: number }>('SELECT rr_cursor FROM companies WHERE id = $1', [A.companyId])).rows[0].rr_cursor;
    const cursorBefore = await cursor();
    const [r1, r2] = await Promise.all([
      c.post('/handoffs', body, { 'Idempotency-Key': 'idem-key-0001' }),
      c.post('/handoffs', body, { 'Idempotency-Key': 'idem-key-0001' }),
    ]);
    const r3 = await c.post('/handoffs', body, { 'Idempotency-Key': 'idem-key-0001' });
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(r1.body.handoffId).toBe(r2.body.handoffId);
    expect(r3.body.handoffId).toBe(r1.body.handoffId);
    expect(r3.body.waUrl).toBe(r1.body.waUrl);
    const rows = await env.db.query("SELECT count(*)::int AS n FROM handoffs WHERE idempotency_key = 'idem-key-0001'");
    expect(rows.rows[0].n).toBe(1);
    const ev = await env.db.query("SELECT count(*)::int AS n FROM events WHERE type = 'handoff_created' AND handoff_id = $1", [r1.body.handoffId]);
    expect(ev.rows[0].n).toBe(1);
    expect((await cursor()) - cursorBefore).toBe(1); // el round robin avanzó una sola vez
  });

  it('requiere Idempotency-Key y valida datos', async () => {
    const c = await publicClient(env, 'co-a', ORIGIN_A);
    expect((await c.post('/handoffs', { name: 'Ana', reason: 'motivo' })).status).toBe(400);
    expect((await c.post('/handoffs', { name: 'A', reason: 'motivo' }, { 'Idempotency-Key': 'valid-key-001' })).status).toBe(400);
    expect((await c.post('/handoffs', { buttonKey: 'inexistente', name: 'Ana', reason: 'motivo' }, { 'Idempotency-Key': 'valid-key-002' })).status).toBe(400);
  });

  it('round robin alterna entre los asesores de la empresa', async () => {
    const c = await publicClient(env, 'co-a', ORIGIN_A);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await c.post('/handoffs', { buttonKey: 'contacto', name: 'Rota', reason: 'prueba rotación' }, { 'Idempotency-Key': `rr-key-000${i}` });
      seen.push(r.body.advisorName);
    }
    expect(new Set(seen).size).toBe(2);
    expect(seen[0]).toBe(seen[2]);
    expect(seen[1]).toBe(seen[3]);
  });

  it('botón con asesor fijo: siempre el mismo; sin asesor vuelve a rotar', async () => {
    const phone = (await sup.get(`/companies/${A.companyId}/advisors`)).body.items.find((x: any) => x.id === A.advisorIds[1]).phones[0];
    const created = await sup.post(`/companies/${A.companyId}/buttons`, { key: 'directo', label: 'Con Asesor 1', advisorId: A.advisorIds[1] });
    expect(created.status).toBe(201);
    expect(created.body.advisor_id).toBe(A.advisorIds[1]);
    const c = await publicClient(env, 'co-a', ORIGIN_A);
    for (let i = 0; i < 3; i++) {
      const r = await c.post('/handoffs', { buttonKey: 'directo', name: 'Fijo', reason: 'prueba fijo' }, { 'Idempotency-Key': `fix-key-000${i}` });
      expect(r.body.waUrl).toContain(`https://wa.me/${phone.number}?`);
    }
    // si ese asesor no está disponible, su botón no lo está pero el rotativo sí
    await sup.patch(`/companies/${A.companyId}/advisors/${A.advisorIds[1]}`, { active: false });
    const cfg = (await c.get('/config')).body;
    expect(cfg.buttons.find((b: any) => b.key === 'directo').available).toBe(false);
    expect(cfg.buttons.find((b: any) => b.key === 'contacto').available).toBe(true);
    const blocked = await c.post('/handoffs', { buttonKey: 'directo', name: 'Fijo', reason: 'prueba fijo' }, { 'Idempotency-Key': 'fix-key-0099' });
    expect(blocked.status).toBe(409);
    await sup.patch(`/companies/${A.companyId}/advisors/${A.advisorIds[1]}`, { active: true });
    const unpinned = await sup.patch(`/companies/${A.companyId}/buttons/${created.body.id}`, { advisorId: null });
    expect(unpinned.body.advisor_id).toBeNull();
    await sup.patch(`/companies/${A.companyId}/buttons/${created.body.id}`, { active: false });
  });
});

describe('eventos y métricas', () => {
  it('registra page_view, chat_open, button_click, handoff_created y whatsapp_click', async () => {
    const F = await setupCompany(env, sup, { slug: 'co-e', name: 'Empresa E', origin: 'https://site-e.test', advisors: 1, button: 'ventas' });
    const c = await publicClient(env, 'co-e', F.origin);
    expect((await c.post('/events', { type: 'page_view', path: '/' })).status).toBe(202);
    expect((await c.post('/events', { type: 'chat_open' })).status).toBe(202);
    expect((await c.post('/events', { type: 'button_click', buttonKey: 'ventas' })).status).toBe(202);
    expect((await c.post('/events', { type: 'whatsapp_click' })).status).toBe(400); // solo vía endpoint del handoff
    const h = await c.post('/handoffs', { buttonKey: 'ventas', name: 'Eva', reason: 'cotización' }, { 'Idempotency-Key': 'evt-key-0001' });
    expect((await c.post(`/handoffs/${h.body.handoffId}/whatsapp-click`)).status).toBe(202);
    expect((await c.post(`/handoffs/${h.body.handoffId}/whatsapp-click`)).status).toBe(202); // repetido: no duplica
    const m = (await sup.get(`/companies/${F.companyId}/metrics`)).body;
    expect(m.counts).toMatchObject({ page_view: 1, chat_open: 1, button_click: 1, handoff_created: 1, whatsapp_click: 1 });
    const hs = (await sup.get(`/companies/${F.companyId}/handoffs`)).body.items;
    expect(hs[0].status).toBe('whatsapp_clicked');
    expect(hs[0].button_label).toBe('ventas');
    expect(m.byAdvisor[0]).toMatchObject({ advisor: 'Asesor co-e 0', handoffs: 1, whatsapp_clicks: 1 });
    // un clic no es un mensaje enviado: no existe ningún evento con ese nombre
    const types = (await sup.get(`/companies/${F.companyId}/events`)).body.items.map((e: any) => e.type);
    expect(types.some((t: string) => /sent|enviado/i.test(t))).toBe(false);
  });
});

describe('CORS y rate limit', () => {
  it('rechaza orígenes no registrados y acepta los registrados', async () => {
    const bad = await request(env.app).post('/api/v1/public/co-a/sessions').set('Origin', 'https://evil.test').send({});
    expect(bad.status).toBe(403);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const noOrigin = await request(env.app).post('/api/v1/public/co-a/sessions').send({});
    expect(noOrigin.status).toBe(403);
    const pre = await request(env.app).options('/api/v1/public/co-a/chat').set('Origin', ORIGIN_A).set('Access-Control-Request-Method', 'POST');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(ORIGIN_A);
    const unknownSlug = await request(env.app).post('/api/v1/public/nope/sessions').set('Origin', ORIGIN_A).send({});
    expect(unknownSlug.status).toBe(404);
  });
  it('limita la tasa de peticiones al chat', async () => {
    const e2 = await createEnv({ rate: { windowMs: 60_000, general: 1000, sessions: 1000, chat: 2, login: 1000 } });
    await makeAdmin(e2, { email: 'r@test.local', role: 'superadmin' });
    const s = adminApi(e2, await login(e2, 'r@test.local'));
    const F = await setupCompany(e2, s, { slug: 'co-r', name: 'R', origin: 'https://r.test', advisors: 1 });
    const c = await publicClient(e2, 'co-r', F.origin);
    const codes = [] as number[];
    for (let i = 0; i < 4; i++) codes.push((await c.post('/chat', { message: 'hola' })).status);
    expect(codes).toEqual([200, 200, 429, 429]);
    await e2.db.close();
  });
  it('valida tamaño del mensaje de chat', async () => {
    const c = await publicClient(env, 'co-a', ORIGIN_A);
    expect((await c.post('/chat', { message: 'a'.repeat(env.cfg.chatMessageMaxChars + 1) })).status).toBe(400);
    expect((await c.post('/chat', { message: '' })).status).toBe(400);
  });
});

describe('chatbot', () => {
  let F: Fixture;
  let c: Awaited<ReturnType<typeof publicClient>>;
  const say = (answer: string, extra: object = {}) => {
    env.llm.impl = async () => JSON.stringify({ intent: 'answer', answer, sectionSlug: null, ...extra });
  };
  beforeAll(async () => {
    F = await setupCompany(env, sup, { slug: 'co-c', name: 'Empresa C', origin: 'https://site-c.test', advisors: 2, button: 'contacto' });
    await sup.patch(`/companies/${F.companyId}`, { contentUrl: 'https://site-c.test/chatbot-content.json' });
    env.fetcher.impl = async () => contentFor('co-c');
    const s = await sup.post(`/companies/${F.companyId}/content/sync`);
    expect(s.status).toBe(200);
    expect(s.body.company).toMatchObject({ content_status: 'ok' });
    expect(s.body.company.content_hash).toMatch(/^[0-9a-f]{64}$/);
    c = await publicClient(env, 'co-c', F.origin);
  });

  it('responde una pregunta clara con base en el contenido sincronizado y un enlace de su propia web', async () => {
    say('Ofrecemos gestión de cartera y atención telefónica.', { sectionSlug: 'servicios' });
    const r = await c.post('/chat', { message: '¿Qué servicios ofrecen?' });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('answer');
    expect(r.body.waUrl).toBeUndefined();
    expect(r.body.link).toEqual({ title: 'Nuestros servicios', url: 'https://site-c.test/servicios' });
    // el prompt contiene solo contenido de esta empresa
    const prompt = env.llm.calls.at(-1)![0].content;
    expect(prompt).toContain('Nuestros servicios');
    expect(prompt).not.toContain('Empresa A');
  });

  it('el modelo recibe TODA la información del sitio, no solo la sección que coincide con la pregunta', async () => {
    say('Somos una empresa de recuperación de cartera.');
    await c.post('/chat', { message: '¿Quién está detrás de este sitio?' }); // ninguna palabra coincide con una sección
    const prompt = env.llm.calls.at(-1)![0].content;
    expect(prompt).toContain('gestión de cartera y atención telefónica');
    expect(prompt).toContain('dedicada a la recuperación de cartera');
  });

  it('una respuesta sin sección citada igual se publica (sin enlace)', async () => {
    say('Atendemos de lunes a viernes.');
    const r = await c.post('/chat', { message: '¿Qué días atienden?' });
    expect(r.body.type).toBe('answer');
    expect(r.body.link).toBeUndefined();
  });

  it('sin información publicada: ofrece un asesor, sin inventar nada', async () => {
    env.llm.impl = async () => JSON.stringify({ intent: 'unknown', answer: '' });
    const r = await c.post('/chat', { message: 'jugadores famosos de ajedrez' });
    expect(r.body.type).toBe('handoff_offer');
    expect(r.body.message).toMatch(/No tengo esa información/);
    expect(r.body.waUrl).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(r.body.message).not.toMatch(/\d{8,}/);
  });

  it('si el modelo no devuelve JSON válido, deriva a un asesor', async () => {
    env.llm.impl = async () => 'esto no es json';
    const r = await c.post('/chat', { message: '¿Qué servicios ofrecen los domingos?' });
    expect(r.body.type).toBe('handoff_offer');
    expect(r.body.message).toMatch(/No tengo esa información/);
  });

  it('descarta respuestas con teléfonos, correos o enlaces que el sitio no publica', async () => {
    for (const invented of ['Llámanos al 3001234567.', 'Escríbenos a ventas@inventado.test', 'Mira https://otro-sitio.test/oferta']) {
      say(invented);
      const r = await c.post('/chat', { message: '¿Cómo los contacto?' });
      expect(r.body.type, invented).toBe('handoff_offer');
      expect(JSON.stringify(r.body)).not.toMatch(/3001234567|inventado|otro-sitio/);
    }
  });

  it('si el modelo afirma algo que la página no dice, no se publica: pasa con un asesor', async () => {
    say('El servicio no ofrece cobro por WhatsApp ni atención los domingos.');
    const r = await c.post('/chat', { message: '¿Atienden por whatsapp los domingos?' });
    expect(r.body.type).toBe('handoff_offer');
    expect(r.body.message).toMatch(/No tengo esa información/);
    expect(r.body.waUrl).toMatch(/^https:\/\/wa\.me\//);
  });

  it('un proveedor que devuelve answer:null al pasar con un asesor se acepta igual', async () => {
    env.llm.impl = async () => JSON.stringify({ intent: 'handoff', answer: null, sectionSlug: null });
    const r = await c.post('/chat', { message: '¿Quién es el representante legal?' });
    expect(r.body.type).toBe('handoff_offer');
    expect(r.body.waUrl).toMatch(/^https:\/\/wa\.me\//);
  });

  it('el modelo decide pasar con un asesor cuando no sabe', async () => {
    env.llm.impl = async () => JSON.stringify({ intent: 'handoff', answer: '' });
    const r = await c.post('/chat', { message: '¿Cuánto cuesta el servicio premium?' });
    expect(r.body.type).toBe('handoff_offer');
    expect(r.body.message).toMatch(/asesor/i);
    expect(r.body.waUrl).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
  });

  it('saludos, temas sensibles y petición de humano se resuelven sin consultar al modelo', async () => {
    const before = env.llm.calls.length;
    const hi = await c.post('/chat', { message: 'hola' });
    expect(hi.body.type).toBe('answer');
    const r = await c.post('/chat', { message: 'Quiero un paz y salvo de mi cuenta' });
    expect(r.body.type).toBe('handoff_offer');
    expect(r.body.message).toMatch(/no puedo darte esa información/);
    const h = await c.post('/chat', { message: 'quiero hablar con una persona' });
    expect(h.body.type).toBe('handoff_offer');
    expect(h.body.waUrl).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(env.llm.calls.length).toBe(before);
  });

  it('pasar con un asesor no pide datos y es una sola derivación por sesión (insistir no la duplica)', async () => {
    const cc = await publicClient(env, 'co-c', F.origin);
    const a = await cc.post('/chat', { message: 'quiero hablar con un asesor' });
    const b = await cc.post('/chat', { message: 'necesito una persona real, por favor' });
    expect(a.body.waUrl).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(b.body.handoffId).toBe(a.body.handoffId);
    expect(b.body.waUrl).toBe(a.body.waUrl);
    const text = decodeURIComponent(a.body.waUrl.split('text=')[1]);
    expect(text).toContain('Quiero hablar con un asesor');
    expect(text).not.toMatch(/soy |sobre:/); // no lleva nombre ni motivo del visitante
    const rows = await env.db.query(
      "SELECT visitor_name, reason FROM handoffs WHERE id = $1 AND idempotency_key = 'chat-handoff'", [a.body.handoffId],
    );
    expect(rows.rows).toEqual([{ visitor_name: '', reason: '' }]);
    // el clic en WhatsApp se registra igual que en un botón
    expect((await cc.post(`/handoffs/${a.body.handoffId}/whatsapp-click`)).status).toBe(202);
  });

  it('un botón de contacto también va directo a WhatsApp sin nombre ni motivo', async () => {
    const cc = await publicClient(env, 'co-c', F.origin);
    const r = await cc.post('/handoffs', { buttonKey: 'contacto' }, { 'Idempotency-Key': 'btn-nodata-001' });
    expect(r.status).toBe(201);
    expect(r.body.waUrl).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(decodeURIComponent(r.body.waUrl)).toContain('Quiero hablar con un asesor');
  });

  it('Ollama caído o sin modelo: responde con lo que dice el sitio sobre la pregunta', async () => {
    env.llm.impl = async () => {
      throw new LlmUnavailableError('caído');
    };
    const r = await c.post('/chat', { message: '¿Cuáles servicios tienen?' });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('answer');
    expect(r.body.message).toContain('gestión de cartera');
    expect(r.body.link).toEqual({ title: 'Nuestros servicios', url: 'https://site-c.test/servicios' });
    const q = await c.post('/chat', { message: '¿Quiénes son ustedes?' });
    expect(q.body.type).toBe('answer');
    expect(q.body.message).toContain('recuperación de cartera');
  });

  it('atajo rápido: si el sitio responde con claridad, contesta al instante sin consultar al modelo', async () => {
    env.cfg.chatFastScore = 2;
    try {
      const before = env.llm.calls.length;
      const r = await c.post('/chat', { message: '¿Qué servicios ofrecen?' });
      expect(r.body.type).toBe('answer');
      expect(r.body.message).toContain('gestión de cartera');
      expect(r.body.link).toEqual({ title: 'Nuestros servicios', url: 'https://site-c.test/servicios' });
      expect(env.llm.calls.length).toBe(before);
      // una pregunta que la sección solo cubre a medias (precio) NO se contesta con ella: va al modelo
      say('No tengo ese dato.');
      await c.post('/chat', { message: '¿Cuánto cuesta el servicio premium?' });
      expect(env.llm.calls.length).toBe(before + 1);
      // con historial (pregunta de seguimiento) sí se usa el modelo
      say('Claro, en horario de oficina.');
      await c.post('/chat', { message: '¿Qué servicios ofrecen?', history: [{ role: 'user', content: 'hola' }] });
      expect(env.llm.calls.length).toBe(before + 2);
    } finally {
      env.cfg.chatFastScore = 0;
    }
  });

  it('una pregunta repetida se responde desde caché, sin volver a consultar al modelo', async () => {
    say('Ofrecemos gestión de cartera y atención telefónica.');
    const first = await c.post('/chat', { message: '¿En qué ciudades hay oficinas?' });
    const calls = env.llm.calls.length;
    const again = await c.post('/chat', { message: '¿En qué ciudades hay oficinas?' });
    expect(again.body).toEqual(first.body);
    expect(env.llm.calls.length).toBe(calls);
    // una respuesta de asesor nunca se guarda en caché
    env.llm.impl = async () => JSON.stringify({ intent: 'handoff', answer: '' });
    await c.post('/chat', { message: '¿Cuánto cuesta la suscripción mensual?' });
    const n = env.llm.calls.length;
    await c.post('/chat', { message: '¿Cuánto cuesta la suscripción mensual?' });
    expect(env.llm.calls.length).toBe(n + 1);
  });

  it('Ollama caído y la pregunta no está en el sitio: fallback a formulario/WhatsApp sin teléfonos', async () => {
    env.llm.impl = async () => {
      throw new LlmUnavailableError('caído');
    };
    const r = await c.post('/chat', { message: 'jugadores famosos de ajedrez' });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('fallback');
    expect(r.body.waUrl).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(r.body.message).not.toMatch(/\d{8,}/);
  });

  it('cliente Ollama real contra un puerto cerrado falla rápido con LlmUnavailableError', async () => {
    const llm = createOllamaClient({ ollamaBaseUrl: 'http://127.0.0.1:1', ollamaModel: 'x', ollamaTimeoutMs: 1500 });
    await expect(llm.chatJson([{ role: 'user', content: 'hola' }])).rejects.toBeInstanceOf(LlmUnavailableError);
    const noModel = createOllamaClient({ ollamaBaseUrl: 'http://127.0.0.1:1', ollamaModel: '', ollamaTimeoutMs: 100 });
    await expect(noModel.chatJson([])).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('el cliente Ollama mantiene el modelo cargado y fija el contexto', async () => {
    let sent: any;
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        sent = JSON.parse(b);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: { content: '{"intent":"unknown"}' } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const llm = createOllamaClient({
        ollamaBaseUrl: `http://127.0.0.1:${(srv.address() as any).port}`, ollamaModel: 'm', ollamaTimeoutMs: 2000, ollamaKeepAlive: '45m', ollamaNumCtx: 4096,
      });
      await llm.chatJson([{ role: 'user', content: 'x' }]);
      expect(sent).toMatchObject({ model: 'm', keep_alive: '45m', options: { num_ctx: 4096 } });
    } finally {
      srv.close();
    }
  });

  it('los números largos que escribe el visitante no se envían al modelo', async () => {
    say('Ofrecemos gestión de cartera y atención telefónica.');
    await c.post('/chat', { message: 'mi referencia es 1234567890, ¿qué gestionan en la cartera?' });
    const sent = env.llm.calls.at(-1)!.map((m) => m.content).join('\n');
    expect(sent).not.toContain('1234567890');
    expect(sent).toContain('[número]');
  });

  it('cliente de proveedor compatible con OpenAI: clave, formato y errores', async () => {
    const seen: any[] = [];
    let mode: 'ok' | '429' | 'empty' = 'ok';
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
        res.setHeader('content-type', 'application/json');
        if (mode === '429') {
          res.statusCode = 429;
          res.setHeader('retry-after', '30');
          return res.end('{}');
        }
        res.end(JSON.stringify({ choices: [{ message: { content: mode === 'empty' ? '' : '{"intent":"answer","answer":"ok"}' } }] }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as any).port}/openai/v1/`;
    try {
      const llm = createOpenAiCompatClient({ llmBaseUrl: base, llmApiKey: 'k-secreta', llmModel: 'm1', llmTimeoutMs: 2000 });
      expect(await llm.chatJson([{ role: 'user', content: 'hola' }])).toContain('"answer":"ok"');
      expect(seen[0].url).toBe('/openai/v1/chat/completions');
      expect(seen[0].auth).toBe('Bearer k-secreta');
      expect(seen[0].body).toMatchObject({ model: 'm1', response_format: { type: 'json_object' } });
      // respuesta vacía → no disponible
      mode = 'empty';
      await expect(llm.chatJson([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(LlmUnavailableError);
      // límite de uso (429) → no disponible y pausa sin volver a llamar al proveedor
      mode = '429';
      await expect(llm.chatJson([{ role: 'user', content: 'x' }])).rejects.toThrow(/429/);
      const calls = seen.length;
      await expect(llm.chatJson([{ role: 'user', content: 'x' }])).rejects.toThrow(/pausa/);
      expect(seen.length).toBe(calls);
      // sin clave o sin modelo → no disponible, sin hacer ninguna llamada
      const noKey = createOpenAiCompatClient({ llmBaseUrl: base, llmApiKey: '', llmModel: 'm1', llmTimeoutMs: 500 });
      await expect(noKey.chatJson([])).rejects.toBeInstanceOf(LlmUnavailableError);
      expect(seen.length).toBe(calls);
    } finally {
      srv.close();
    }
  });

  it('la configuración elige el proveedor y exige todos sus datos para considerarlo activo', () => {
    const base = { NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) } as any;
    expect(loadConfig({ ...base }).llmEnabled).toBe(false);
    expect(loadConfig({ ...base, OLLAMA_MODEL: 'qwen2.5:3b' }).llmEnabled).toBe(true);
    expect(loadConfig({ ...base, LLM_PROVIDER: 'openai', LLM_MODEL: 'm' }).llmEnabled).toBe(false); // falta clave y URL
    const ok = loadConfig({ ...base, LLM_PROVIDER: 'openai', LLM_BASE_URL: 'https://x.test/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm' });
    expect(ok.llmEnabled).toBe(true);
    expect(createLlmClient(ok)).toHaveProperty('chatJson');
  });

  it('el visitante no puede inyectar una URL de contenido', async () => {
    const calls = env.fetcher.calls.length;
    const r = await c.post('/chat', { message: 'hola', contentUrl: 'http://127.0.0.1/x.json' });
    expect(r.status).toBe(200);
    expect(env.fetcher.calls.length).toBe(calls);
  });

  it('sin asesores disponibles no inventa teléfono: mensaje claro', async () => {
    const E = await setupCompany(env, sup, { slug: 'co-n', name: 'N', origin: 'https://site-n.test' });
    const cn = await publicClient(env, 'co-n', E.origin);
    const r = await cn.post('/chat', { message: 'quiero hablar con un asesor' });
    expect(r.body.type).toBe('fallback');
    expect(r.body.waUrl).toBeUndefined();
    expect(r.body.message).toMatch(/no hay asesores disponibles/i);
  });
});

describe('puesta en marcha (checklist)', () => {
  it('indica qué falta y marca listo cuando están los pasos requeridos', async () => {
    const created = await sup.post('/companies', { slug: 'co-s', name: 'Empresa S' });
    const id = created.body.id as string;
    const step = (body: any, key: string) => body.steps.find((x: any) => x.key === key);

    let r = (await sup.get(`/companies/${id}/setup`)).body;
    expect(r.ready).toBe(false);
    expect(['origin', 'advisor', 'content'].every((k) => !step(r, k).done && step(r, k).required)).toBe(true);
    expect(step(r, 'ai').required).toBe(false);
    expect(step(r, 'origin').hint).toMatch(/Dominios/);

    await sup.post(`/companies/${id}/origins`, { origin: 'https://site-s.test' });
    const adv = await sup.post(`/companies/${id}/advisors`, { name: 'Sofía' });
    await sup.post(`/companies/${id}/phones`, { advisorId: adv.body.id, number: fakePhone(555), isPrimary: true });
    r = (await sup.get(`/companies/${id}/setup`)).body;
    expect(r.ready).toBe(false); // falta el contenido
    expect(step(r, 'origin').done && step(r, 'advisor').done).toBe(true);

    await sup.patch(`/companies/${id}`, { contentUrl: 'https://site-s.test/chatbot-content.json' });
    env.fetcher.impl = async () => contentFor('co-s');
    expect((await sup.post(`/companies/${id}/content/sync`)).status).toBe(200);
    r = (await sup.get(`/companies/${id}/setup`)).body;
    expect(r.ready).toBe(true); // lo opcional (IA, botón) no bloquea
    expect(step(r, 'ai').done).toBe(false);
  });
});

describe('caché de empresa y orígenes', () => {
  it('un cambio de dominio hecho en el panel aplica al instante a las peticiones públicas', async () => {
    const F = await setupCompany(env, sup, { slug: 'co-k', name: 'K', origin: 'https://site-k.test', advisors: 1 });
    const c = await publicClient(env, 'co-k', F.origin);
    expect((await c.get('/config')).status).toBe(200);
    const origin = (await sup.get(`/companies/${F.companyId}/origins`)).body.items[0];
    await sup.patch(`/companies/${F.companyId}/origins/${origin.id}`, { active: false });
    expect((await c.get('/config')).status).toBe(403);
    await sup.patch(`/companies/${F.companyId}/origins/${origin.id}`, { active: true });
    expect((await c.get('/config')).status).toBe(200);
    await sup.patch(`/companies/${F.companyId}`, { active: false });
    expect((await c.get('/config')).status).toBe(404);
  });
});

describe('contenido del chatbot: URL no permitida', () => {
  let F: Fixture;
  beforeAll(async () => {
    F = await setupCompany(env, sup, { slug: 'co-u', name: 'U', origin: 'https://site-u.test' });
  });
  const sync = async (url: string | null) => {
    await sup.patch(`/companies/${F.companyId}`, { contentUrl: url });
    const before = env.fetcher.calls.length;
    const r = await sup.post(`/companies/${F.companyId}/content/sync`);
    return { r, fetched: env.fetcher.calls.length - before };
  };

  it.each([
    ['dominio no registrado', 'https://evil.test/chatbot-content.json'],
    ['http sin TLS', 'http://site-u.test/chatbot-content.json'],
    ['localhost', 'http://localhost:3000/chatbot-content.json'],
    ['IP privada', 'http://192.168.1.10/chatbot-content.json'],
    ['metadatos cloud', 'http://169.254.169.254/latest/meta-data'],
    ['loopback IPv6', 'http://[::1]/chatbot-content.json'],
    ['credenciales en URL', 'https://user:pass@site-u.test/chatbot-content.json'],
    ['puerto no estándar', 'https://site-u.test:8443/chatbot-content.json'],
  ])('rechaza %s sin llegar a descargar', async (_n, url) => {
    const { r, fetched } = await sync(url);
    expect(r.status).toBe(422);
    expect(r.body.company.content_status).toBe('error');
    expect(fetched).toBe(0);
  });

  it('registra estado/fecha/hash en éxito y error de esquema', async () => {
    env.fetcher.impl = async () => '{"sections": []}';
    let { r } = await sync('https://site-u.test/chatbot-content.json');
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/Esquema inválido/);
    env.fetcher.impl = async () => contentFor('otra-empresa');
    ({ r } = await sync('https://site-u.test/chatbot-content.json'));
    expect(r.body.error).toMatch(/slug/);
    env.fetcher.impl = async () => 'no es json';
    ({ r } = await sync('https://site-u.test/chatbot-content.json'));
    expect(r.body.error).toMatch(/JSON/);
    env.fetcher.impl = async () => contentFor('co-u');
    ({ r } = await sync('https://site-u.test/chatbot-content.json'));
    expect(r.status).toBe(200);
    expect(r.body.company.content_synced_at).toBeTruthy();
    const summary = await sup.get(`/companies/${F.companyId}/content`);
    expect(summary.body.sections.map((s: any) => s.slug)).toEqual(['servicios', 'nosotros']);
  });

  it('un company_admin de otra empresa no puede sincronizar esta', async () => {
    await makeAdmin(env, { email: 'adm-a2@test.local', role: 'company_admin', companyId: A.companyId });
    const a = adminApi(env, await login(env, 'adm-a2@test.local'));
    expect((await a.post(`/companies/${F.companyId}/content/sync`)).status).toBe(404);
  });
});

describe('auditoría', () => {
  it('registra cambios con before/after y sin secretos', async () => {
    await sup.patch(`/companies/${A.companyId}`, { name: 'Empresa A (renombrada)' });
    const log = (await sup.get(`/companies/${A.companyId}/audit`)).body.items;
    const upd = log.find((l: any) => l.entity === 'company' && l.action === 'update');
    expect(upd.before_data.name).toBe('Empresa A');
    expect(upd.after_data.name).toBe('Empresa A (renombrada)');
    expect(upd.admin_email).toBe('root@test.local');
    expect(JSON.stringify(log)).not.toMatch(/argon2|password/i);
    const deact = await sup.patch(`/companies/${A.companyId}/buttons/${(await sup.get(`/companies/${A.companyId}/buttons`)).body.items[0].id}`, { active: false });
    expect(deact.body.active).toBe(false);
    const log2 = (await sup.get(`/companies/${A.companyId}/audit`)).body.items;
    expect(log2.some((l: any) => l.entity === 'button' && l.action === 'deactivate')).toBe(true);
  });
  it('no hay endpoint de borrado para entidades con historial', async () => {
    expect((await sup.del(`/companies/${A.companyId}/buttons/${(await sup.get(`/companies/${A.companyId}/buttons`)).body.items[0].id}`)).status).toBe(404);
    expect((await sup.del(`/companies/${A.companyId}/advisors/${A.advisorId}`)).status).toBe(404);
  });
});
