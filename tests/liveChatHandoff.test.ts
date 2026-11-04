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
  it('persiste el diálogo del bot y remite a WhatsApp con el número de un asesor de la cartera', async () => {
    const hello = await visitor.post('/chat', { message: 'hola', live: true, name: 'Visitante Demo', document: '10000001' });
    expect(hello.status).toBe(200);
    expect(hello.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });

    // La empresa tiene una sola cartera activa: pedir un asesor remite directo a WhatsApp, sin preguntar una cartera que
    // no hay que elegir. El chat sigue abierto (el panel puede tomarlo), pero el visitante no cuenta con eso.
    const human = await visitor.post('/chat', { message: 'Quiero hablar con un asesor', live: true });
    expect(human.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(human.body.waUrl).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(human.body.message).toMatch(/WhatsApp/);
    expect(human.body.message).not.toMatch(/cartera|en espera|este mismo chat/i);
    // Sin una consulta concreta, el mensaje es uno base que pide la información.
    expect(decodeURIComponent(human.body.waUrl)).toContain('Quiero hablar con un asesor para solicitar información');
    conversationId = human.body.conversation.id;
    const snapshot = await visitor.get('/conversation');
    expect(snapshot.body.conversation).toMatchObject({ id: conversationId, visitor_name: 'Visitante Demo', document: '10000001' });
    // La única cartera queda asignada: el panel la muestra y se puede remitir a WhatsApp sin elegirla.
    expect(snapshot.body.conversation.portfolio_id).toBeTruthy();
    expect(snapshot.body.messages.map((m: any) => m.sender_type)).toEqual(['USER', 'BOT', 'USER', 'BOT']);
    expect(snapshot.body.messages.at(-1).metadata.waUrl).toBe(human.body.waUrl);
  });

  it('un asesor toma el chat de forma exclusiva y el bot queda pausado', async () => {
    const list = await manager.get(`/companies/${fixture.companyId}/chat-sessions?view=live`);
    expect(list.body.items.map((x: any) => x.id)).toContain(conversationId);
    const taken = await manager.post(`/companies/${fixture.companyId}/chat-sessions/${conversationId}/take`, { advisorId: fixture.advisorIds[0] });
    expect(taken.status).toBe(200);
    // Toma el control el usuario del panel que pulsa el botón (los asesores de WhatsApp solo reciben remisiones).
    expect(taken.body.conversation).toMatchObject({ status: 'TOMADO_POR_ASESOR', current_advisor_id: null });
    expect(taken.body.conversation.current_admin_id).toBeTruthy();

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
    const routed = await manager.post(`/companies/${fixture.companyId}/chat-sessions/${conversationId}/whatsapp`, {});
    expect(routed.status).toBe(200);
    expect(routed.body.waUrl).toMatch(/^https:\/\/wa\.me\//);
    expect(routed.body.conversation.status).toBe('REMITIDO_WHATSAPP');
    const text = decodeURIComponent(routed.body.waUrl);
    expect(text).toContain('Vengo del chat de la página');
    expect(text).toContain('documento 10000001');
    expect(text).not.toMatch(/nota|resumen/i);
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


describe('bandeja en vivo e historial', () => {
  it('separa lo activo de lo remitido o abandonado', async () => {
    const live = await manager.get(`/companies/${fixture.companyId}/chat-sessions?view=live`);
    const history = await manager.get(`/companies/${fixture.companyId}/chat-sessions?view=history`);
    expect(live.status).toBe(200);
    expect(live.body.items.every((x: any) => ['BOT_ACTIVO', 'EN_ESPERA_ASESOR', 'TOMADO_POR_ASESOR'].includes(x.status))).toBe(true);
    expect(history.body.items.every((x: any) => ['REMITIDO_WHATSAPP', 'CERRADO', 'ABANDONADO'].includes(x.status))).toBe(true);
    expect(history.body.items.map((x: any) => x.id)).toContain(conversationId);
  });
});

describe('tomar control sin elegir asesor', () => {
  it('un gestor sin asesor vinculado toma el chat y puede responder', async () => {
    const guest = await publicClient(env, fixture.slug, fixture.origin);
    const first = await guest.post('/chat', { message: 'hola', live: true, name: 'Cliente Dos', document: '20000002', portfolioKey: 'general' });
    const id = first.body.conversation.id;
    const taken = await manager.post(`/companies/${fixture.companyId}/chat-sessions/${id}/take`, {});
    expect(taken.status).toBe(200);
    expect(taken.body.conversation.status).toBe('TOMADO_POR_ASESOR');
    const reply = await manager.post(`/companies/${fixture.companyId}/chat-sessions/${id}/messages`, { message: 'Hola, te atiendo' });
    expect(reply.status).toBe(201);
  });
});

describe('el bot sigue ayudando hasta que un asesor toma el chat', () => {
  it('si no sabe responder ofrece un asesor; si el visitante da su cartera lo remite a WhatsApp y sigue conversando', async () => {
    const guest = await publicClient(env, fixture.slug, fixture.origin);
    // Una pregunta que no puede responder (a lo que no se entiende, como "Skdjbdd", le pide que cuente más).
    const unknown = await guest.post('/chat', { message: '¿Atienden los domingos?', live: true });
    expect(unknown.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    // Ofrece, no obliga: no pide datos ni lo pasa a la cola sin que el visitante quiera.
    expect(unknown.body.message).toMatch(/¿Quieres que te comunique con un asesor\?$/);
    expect(unknown.body.message).not.toMatch(/nombre|documento/i);
    const data = await guest.post('/chat', { message: 'Pedro Gómez 30000003 general', live: true });
    expect(data.body.conversation.status).toBe('BOT_ACTIVO');
    expect(data.body.waUrl).toMatch(/^https:\/\/wa\.me\//);
    const snap = await guest.get('/conversation');
    expect(snap.body.conversation).toMatchObject({ visitor_name: 'Pedro Gómez', document: '30000003' });
    const more = await guest.post('/chat', { message: 'hola', live: true });
    expect(more.status).toBe(200);
    expect(more.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(more.body.message).not.toMatch(/documento|cartera/i);
  });
});

describe('consistencia de las respuestas del bot', () => {
  it('responde quién es sin pedir datos ni pasar a un asesor', async () => {
    const guest = await publicClient(env, fixture.slug, fixture.origin);
    for (const q of ['que eres', 'Quién eres tú?', 'eres una persona?']) {
      const r = await guest.post('/chat', { message: q, live: true });
      expect(r.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
      expect(r.body.message).toMatch(/asistente virtual/i);
    }
  });
});

describe('continuidad al pedir los datos', () => {
  it('pregunta el nombre una sola vez y agradece los datos que el visitante da por su cuenta, sin insistir ni pasar a un asesor', async () => {
    const guest = await publicClient(env, fixture.slug, fixture.origin);
    const who = await guest.post('/chat', { message: 'que eres', live: true });
    expect(who.body.message).toMatch(/asistente virtual/i);
    expect(who.body.message).toMatch(/¿Con quién tengo el gusto\?$/);

    const name = await guest.post('/chat', { message: 'soy juan', live: true });
    expect(name.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(name.body.message).toMatch(/^Mucho gusto, Juan\./);
    // Solo quería información: no se le pide la cédula ni la cartera por iniciativa del bot.
    expect(name.body.message).not.toMatch(/documento|cartera|asesor/i);

    const doc = await guest.post('/chat', { message: '1002003004', live: true });
    expect(doc.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(doc.body.message).toMatch(/ya tengo tu número de documento/i);

    // "ok" nunca es un nombre y el bot no vuelve a preguntar el nombre.
    const ok = await guest.post('/chat', { message: 'ok', live: true });
    expect(ok.body.message).toMatch(/Con gusto|Para servirte/);
    const again = await guest.post('/chat', { message: 'que eres', live: true });
    expect(again.body.message).not.toMatch(/Con quién tengo el gusto/);
    const snap = await guest.get('/conversation');
    expect(snap.body.conversation).toMatchObject({ visitor_name: 'Juan', document: '1002003004', status: 'BOT_ACTIVO' });
  });

  it('con una sola cartera, pedir un asesor remite directo a WhatsApp sin pedir nombre ni documento', async () => {
    const guest = await publicClient(env, fixture.slug, fixture.origin);
    const ask = await guest.post('/chat', { message: 'quiero hablar con un asesor', live: true });
    expect(ask.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(ask.body.waUrl).toMatch(/^https:\/\/wa\.me\//);
    expect(ask.body.message).toMatch(/Te remito con un asesor por WhatsApp/);
    expect(ask.body.message).not.toMatch(/nombre|documento|cartera/i);
  });
});

describe('reglas ordenadas: el bot entiende los datos aunque vengan en frases largas', () => {
  it('caso real: corrige el nombre, toma documento y "cartera de prueba" (plural/singular) y remite a WhatsApp sin repetir', async () => {
    await manager.post(`/companies/${fixture.companyId}/portfolios`, { key: 'pruebas', name: 'Cartera de pruebas' });
    const guest = await publicClient(env, fixture.slug, fixture.origin);
    const ask = await guest.post('/chat', { message: 'necesito hablar con un asesor', live: true });
    expect(ask.body.message).toMatch(/Te comunico con un asesor/);
    expect(ask.body.waUrl).toBeUndefined(); // todavía falta la cartera
    const name = await guest.post('/chat', { message: 'te estoy diciendo que mi nombre es Juan ESTEBAN', live: true });
    expect(name.body.message).toMatch(/^Gracias, Juan\./);
    expect(name.body.message).not.toMatch(/tu nombre/);
    expect(name.body.message).not.toMatch(/Esa consulta la atiende mejor/);
    const done = await guest.post('/chat', { message: '1021803088 NUMERO DE DOCUMENTO Y MI CARTERA ES CARTERA DE PRUEBA', live: true });
    expect(done.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(done.body.waUrl).toMatch(/^https:\/\/wa\.me\//);
    const snap = await guest.get('/conversation');
    expect(snap.body.conversation).toMatchObject({ visitor_name: 'Juan Esteban', document: '1021803088' });
    const portfolios = await manager.get(`/companies/${fixture.companyId}/portfolios`);
    expect(snap.body.conversation.portfolio_id).toBe(portfolios.body.items.find((p: any) => p.key === 'pruebas').id);
    // El tema para el asesor/WhatsApp no es un dato ("mi nombre es…").
    expect(snap.body.conversation.subject).not.toMatch(/nombre es/i);
    // El chat sigue abierto y el bot sigue atendiendo sin volver a pedir datos.
    const more = await guest.post('/chat', { message: 'hola', live: true });
    expect(more.body).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(more.body.message).not.toMatch(/documento|cartera/i);
  });

});

describe('cerrar desde el panel', () => {
  it('se puede cerrar un chat que atiende el bot y uno que tomó el panel', async () => {
    const withBot = await publicClient(env, fixture.slug, fixture.origin);
    const first = await withBot.post('/chat', { message: 'hola', live: true });
    const botChat = first.body.conversation.id;
    expect(first.body.conversation.status).toBe('BOT_ACTIVO');
    const closedBot = await manager.post(`/companies/${fixture.companyId}/chat-sessions/${botChat}/close`, { reason: 'resuelto' });
    expect(closedBot.status).toBe(200);
    expect(closedBot.body.status).toBe('CERRADO');

    const taken = await publicClient(env, fixture.slug, fixture.origin);
    const second = await taken.post('/chat', { message: 'hola', live: true });
    const takenChat = second.body.conversation.id;
    expect((await manager.post(`/companies/${fixture.companyId}/chat-sessions/${takenChat}/take`, {})).status).toBe(200);
    const closedTaken = await manager.post(`/companies/${fixture.companyId}/chat-sessions/${takenChat}/close`, { reason: 'informacion_entregada' });
    expect(closedTaken.body.status).toBe('CERRADO');
    expect((await manager.post(`/companies/${fixture.companyId}/chat-sessions/${takenChat}/close`, { reason: 'otro' })).status).toBe(409);
  });
});
