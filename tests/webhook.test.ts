import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, createEnv, login, makeAdmin, publicClient, setupCompany, type Fixture, type TestEnv } from './helpers';

let env: TestEnv;
let sup: ReturnType<typeof adminApi>;
let F: Fixture;
let secret: string;
const ORIGIN = 'https://site-hook.test';
const HOOK = 'https://crm.example.com/hooks/fontanachat';

const until = async (cond: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};
const events = () => env.webhook.calls.map((c) => c.body.event);

beforeAll(async () => {
  env = await createEnv();
  await makeAdmin(env, { email: 'root@test.local', role: 'superadmin' });
  sup = adminApi(env, await login(env, 'root@test.local'));
  F = await setupCompany(env, sup, { slug: 'co-hook', name: 'Empresa Hook', origin: ORIGIN, advisors: 1 });
});
afterAll(async () => {
  await env.db.close();
});

describe('webhook de salida', () => {
  it('sin webhook configurado no se envía nada', async () => {
    const c = await publicClient(env, 'co-hook', ORIGIN);
    await c.post('/events', { type: 'chat_open' });
    await new Promise((r) => setTimeout(r, 100));
    expect(env.webhook.calls).toHaveLength(0);
  });

  it('solo un superadmin lo configura; la URL debe ser https y pública', async () => {
    for (const bad of ['http://crm.example.com/x', 'https://127.0.0.1/x', 'https://user:pw@crm.example.com/x', 'no-es-url']) {
      expect((await sup.patch(`/companies/${F.companyId}`, { webhookUrl: bad })).status).toBe(400);
    }
    await makeAdmin(env, { email: 'co@test.local', role: 'company_admin', companyId: F.companyId });
    const co = adminApi(env, await login(env, 'co@test.local'));
    expect((await co.patch(`/companies/${F.companyId}`, { webhookUrl: HOOK })).status).toBe(403);
    expect((await co.post(`/companies/${F.companyId}/webhook/test`)).status).toBe(403);
  });

  it('al configurarlo genera un secreto que se muestra una sola vez y no vuelve a salir', async () => {
    const r = await sup.patch(`/companies/${F.companyId}`, { webhookUrl: HOOK });
    expect(r.status).toBe(200);
    expect(r.body.webhookSecret).toMatch(/^whsec_[\w-]{40,}$/);
    secret = r.body.webhookSecret;
    const g = (await sup.get(`/companies/${F.companyId}`)).body;
    expect(g).toMatchObject({ webhook_url: HOOK, webhook_secret_set: true });
    expect(JSON.stringify(g)).not.toContain(secret);
    // cambiar la URL conserva el secreto; regenerar lo cambia
    const same = await sup.patch(`/companies/${F.companyId}`, { webhookUrl: `${HOOK}?v=2` });
    expect(same.body.webhookSecret).toBeUndefined();
    const regen = await sup.patch(`/companies/${F.companyId}`, { regenerateWebhookSecret: true });
    expect(regen.body.webhookSecret).toMatch(/^whsec_/);
    expect(regen.body.webhookSecret).not.toBe(secret);
    secret = regen.body.webhookSecret;
    await sup.patch(`/companies/${F.companyId}`, { webhookUrl: HOOK });
  });

  it('el evento de prueba llega firmado y se puede verificar con el secreto', async () => {
    const r = await sup.post(`/companies/${F.companyId}/webhook/test`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 200 });
    const call = env.webhook.calls.at(-1)!;
    expect(call.url).toBe(HOOK);
    expect(call.body).toMatchObject({ event: 'test', company: { slug: 'co-hook', name: 'Empresa Hook' } });
    const h = call.headers;
    expect(h['x-fontanachat-event']).toBe('test');
    expect(h['x-fontanachat-signature']).toBe(`sha256=${createHmac('sha256', secret).update(`${h['x-fontanachat-timestamp']}.${call.raw}`).digest('hex')}`);
    env.webhook.calls.length = 0;
  });

  it('avisa en vivo: un ingreso, el chat, el botón, la derivación y el clic en WhatsApp (no cada cambio de vista)', async () => {
    // La actividad anterior de estas pruebas (misma IP y navegador) ya quedó fuera de la ventana de 30 min.
    await env.db.query(`UPDATE events SET created_at = now() - interval '2 hours'`);
    const c = await publicClient(env, 'co-hook', ORIGIN);
    await c.post('/events', { type: 'page_view', path: '/' });
    await c.post('/events', { type: 'page_view', path: '/servicios' });
    await c.post('/events', { type: 'page_view', path: '/contacto' });
    await c.post('/events', { type: 'chat_open' });
    const h = await c.post('/handoffs', { name: 'Ana' }, { 'Idempotency-Key': 'hook-handoff-0001' });
    expect(h.status).toBe(201);
    await c.post(`/handoffs/${h.body.handoffId}/whatsapp-click`, {});
    await until(() => env.webhook.calls.length >= 4);
    expect(events()).toEqual(['visit', 'chat_open', 'handoff_created', 'whatsapp_click']);
    const visit = env.webhook.calls[0].body.data;
    expect(visit).toMatchObject({ path: '/', origin: ORIGIN });
    const handoff = env.webhook.calls.find((x) => x.body.event === 'handoff_created')!.body.data;
    expect(handoff.handoffId).toBe(h.body.handoffId);
    const sent = JSON.stringify(env.webhook.calls.map((x) => x.body));
    const numbers = (await env.db.query<{ number: string }>('SELECT number FROM phones')).rows.map((r) => r.number);
    expect(sent).not.toContain('wa.me'); // nunca el teléfono del asesor
    for (const num of numbers) expect(sent).not.toContain(num);
  });

  it('un destino que falla se reintenta una vez y el estado queda visible en el panel', async () => {
    env.webhook.calls.length = 0;
    env.webhook.fail = true;
    const c = await publicClient(env, 'co-hook', ORIGIN);
    await c.post('/events', { type: 'chat_open' });
    await until(() => /error: No se pudo conectar/.test((await_status() ?? '')), 8000);
    env.webhook.fail = false;
    const r = await sup.post(`/companies/${F.companyId}/webhook/test`);
    expect(r.status).toBe(200);
    expect((await sup.get(`/companies/${F.companyId}`)).body.webhook_status).toBe('ok (HTTP 200)');
  });

  it('un 4xx del destino no se reintenta y se informa', async () => {
    env.webhook.calls.length = 0;
    env.webhook.status = 410;
    const r = await sup.post(`/companies/${F.companyId}/webhook/test`);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ ok: false, status: 410 });
    expect(env.webhook.calls).toHaveLength(1);
    env.webhook.status = 200;
  });

  it('desactivarlo borra la URL y el secreto', async () => {
    const r = await sup.patch(`/companies/${F.companyId}`, { webhookUrl: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ webhook_url: null, webhook_secret_set: false });
    env.webhook.calls.length = 0;
    await (await publicClient(env, 'co-hook', ORIGIN)).post('/events', { type: 'chat_open' });
    await new Promise((r2) => setTimeout(r2, 100));
    expect(env.webhook.calls).toHaveLength(0);
    expect((await sup.post(`/companies/${F.companyId}/webhook/test`)).status).toBe(400);
  });
});

// El estado del webhook se guarda en la base: se consulta de forma síncrona con la última lectura.
let lastStatus: string | null = null;
function await_status(): string | null {
  void env.db.query<{ webhook_status: string | null }>('SELECT webhook_status FROM companies WHERE slug = $1', ['co-hook']).then((r) => {
    lastStatus = r.rows[0]?.webhook_status ?? null;
  });
  return lastStatus;
}
