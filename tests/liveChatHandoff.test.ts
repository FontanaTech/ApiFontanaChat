import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { adminApi, createEnv, login, makeAdmin, publicClient, setupCompany, type Fixture, type TestEnv } from './helpers';
import { attachLiveWebSocket } from '../src/services/liveWebSocket';
import type { LiveBus } from '../src/services/liveEvents';
import { seedLiveDemo } from '../src/scripts/seedLiveDemo';

let env: TestEnv;
let fixture: Fixture;
let manager: ReturnType<typeof adminApi>;
let visitor: Awaited<ReturnType<typeof publicClient>>;
let conversationId = '';

beforeAll(async () => {
  env = await createEnv();
  await makeAdmin(env, { email: 'root-live@test.local', role: 'superadmin' });
  const root = adminApi(env, await login(env, 'root-live@test.local'));
  fixture = await setupCompany(env, root, { slug: 'live-handoff', name: 'Live Handoff', origin: 'https://live-handoff.test', advisors: 2 });
  await makeAdmin(env, { email: 'manager-live@test.local', role: 'company_admin', companyId: fixture.companyId });
  manager = adminApi(env, await login(env, 'manager-live@test.local'));
  visitor = await publicClient(env, fixture.slug, fixture.origin);
});
afterAll(async () => env.db.close());

describe('toma de control del chatbot', () => {
  it('persiste el diálogo del bot y escala dentro del mismo chat web', async () => {
    const hello = await visitor.post('/chat', { message: 'hola', live: true, name: 'Visitante Demo', document: '10000001' });
    expect(hello.status).toBe(200);
    expect(hello.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });

    const human = await visitor.post('/chat', { message: 'Quiero hablar con un asesor', live: true });
    expect(human.body).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    conversationId = human.body.conversation.id;
    const snapshot = await visitor.get('/conversation');
    expect(snapshot.body.conversation).toMatchObject({ id: conversationId, visitor_name: 'Visitante Demo', document: '10000001' });
    expect(snapshot.body.messages.map((m: any) => m.sender_type)).toEqual(['USER', 'BOT', 'USER']);
  });

  it('un asesor toma el chat de forma exclusiva y el bot queda pausado', async () => {
    const list = await manager.get(`/companies/${fixture.companyId}/chat-sessions?pending=true`);
    expect(list.body.items.map((x: any) => x.id)).toContain(conversationId);
    const taken = await manager.post(`/companies/${fixture.companyId}/chat-sessions/${conversationId}/take`, { advisorId: fixture.advisorIds[0] });
    expect(taken.status).toBe(200);
    expect(taken.body.conversation).toMatchObject({ status: 'TOMADO_POR_ASESOR', current_advisor_id: fixture.advisorIds[0] });

    const second = await manager.post(`/companies/${fixture.companyId}/chat-sessions/${conversationId}/take`, { advisorId: fixture.advisorIds[1] });
    expect(second.status).toBe(409);
    const userMessage = await visitor.post('/chat', { message: 'Sigo pendiente', live: true });
    expect(userMessage.body.type).toBe('live');
    const snapshot = await visitor.get('/conversation');
    expect(snapshot.body.messages.at(-1).sender_type).toBe('USER');
  });

  it('entrega en ambos sentidos los mensajes del asesor y conserva auditoría', async () => {
    const sent = await manager.post(`/companies/${fixture.companyId}/chat-sessions/${conversationId}/messages`, { message: 'Hola, continuaré tu atención por este medio.' });
    expect(sent.status).toBe(201);
    const snapshot = await visitor.get('/conversation');
    expect(snapshot.body.messages.at(-1)).toMatchObject({ sender_type: 'ADVISOR', content: 'Hola, continuaré tu atención por este medio.' });
    const audit = await env.db.query<any>('SELECT action FROM chat_audit_logs WHERE chat_session_id = $1 ORDER BY created_at', [conversationId]);
    expect(audit.rows.map((x) => x.action)).toContain('TAKE_CONTROL');
  });

  it('empuja la respuesta del asesor al widget mediante WebSocket autenticado', async () => {
    const server = env.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const channel = attachLiveWebSocket(server, { cfg: env.cfg, db: env.db, live: env.app.locals.live as LiveBus });
    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/public/${fixture.slug}/live`, ['fontanachat', `fc-token.${visitor.token}`], { headers: { Origin: fixture.origin } });
    await once(ws, 'open');
    const received = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No llegó el mensaje por WebSocket')), 3000);
      ws.on('message', (raw) => {
        const packet = JSON.parse(String(raw));
        if (packet.data?.messages?.some((m: any) => m.content === 'Mensaje instantáneo')) { clearTimeout(timeout); resolve(packet); }
      });
    });
    await manager.post(`/companies/${fixture.companyId}/chat-sessions/${conversationId}/messages`, { message: 'Mensaje instantáneo' });
    expect((await received).type).toBe('snapshot');
    ws.close(); channel.close(); server.close();
  });

  it('remite solo al WhatsApp de la cartera y cierra el flujo', async () => {
    const portfolios = await manager.get(`/companies/${fixture.companyId}/portfolios`);
    const general = portfolios.body.items.find((x: any) => x.key === 'general');
    const changed = await manager.patch(`/companies/${fixture.companyId}/chat-sessions/${conversationId}/portfolio`, { portfolioId: general.id });
    expect(changed.status).toBe(200);
    const routed = await manager.post(`/companies/${fixture.companyId}/chat-sessions/${conversationId}/whatsapp`, { summary: 'Consulta de prueba' });
    expect(routed.status).toBe(200);
    expect(routed.body.waUrl).toMatch(/^https:\/\/wa\.me\//);
    expect(routed.body.conversation.status).toBe('REMITIDO_WHATSAPP');
    const snapshot = await visitor.get('/conversation');
    expect(snapshot.body.messages.at(-1).metadata.waUrl).toBe(routed.body.waUrl);
  });
});

describe('seed de demostración', () => {
  it('crea los datos ficticios y se puede ejecutar de nuevo sin duplicarlos', async () => {
    await seedLiveDemo(env.db, 'DemoPassword2026!');
    await seedLiveDemo(env.db, 'DemoPassword2026!');
    const company = await env.db.query<any>(`SELECT id FROM companies WHERE slug = 'fontanaweb-demo'`);
    const portfolios = await env.db.query<{ total: number }>('SELECT count(*)::int AS total FROM portfolios WHERE company_id = $1', [company.rows[0].id]);
    const advisors = await env.db.query<{ total: number }>('SELECT count(*)::int AS total FROM advisors WHERE company_id = $1', [company.rows[0].id]);
    const users = await env.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM admins WHERE email LIKE '%@fontanaweb.demo'`);
    expect(portfolios.rows[0].total).toBe(4);
    expect(advisors.rows[0].total).toBe(8);
    expect(users.rows[0].total).toBe(4);
    const advisorApi = adminApi(env, await login(env, 'flamingo@fontanaweb.demo', 'DemoPassword2026!'));
    expect((await advisorApi.get(`/companies/${company.rows[0].id}/portfolios`)).status).toBe(200);
    expect((await advisorApi.get(`/companies/${company.rows[0].id}/origins`)).status).toBe(403);
  });
});

