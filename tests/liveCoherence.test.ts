import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, createEnv, fakePhone, login, makeAdmin, publicClient, setupCompany, type Fixture, type TestEnv } from './helpers';
import { LlmUnavailableError } from '../src/services/ollama';
import { normalize } from '../src/utils/text';

/**
 * Coherencia del chat en vivo con los casos reales que fallaban en producción (AAgora, nov. 2026): el bot debe
 * responder a lo que el visitante dice, pedir datos solo cuando va a pasarlo con un asesor y nunca enviarlo a la
 * cola sin que lo pida. El modelo se simula con un guion por pregunta; sin guion, el modelo "no está disponible".
 */

const ORIGIN = 'https://coherencia.test';
const CONTENT = JSON.stringify({
  slug: 'coherencia',
  siteName: 'Cobranzas Demo',
  sections: [
    { slug: 'presentacion', title: 'Cobranzas Demo', route: '/', text: 'Gestión integral de cartera, asesoría legal y atención especializada.\nSede principal: Carrera 46 # 50-63, Edificio Playa Oriental, piso 11, Medellín, Colombia.' },
    { slug: 'servicios', title: 'Nuestros servicios', route: '/servicios', text: 'Recuperación de cartera, asesoría legal y call center.\nRecuperación de Cartera: Gestión de cobro de obligaciones por cuenta de clientes acreedores.' },
    { slug: 'servicio-asesoria-legal', title: 'Asesoría Legal', route: '/servicios/asesoria-legal', text: 'Acompañamiento jurídico a personas y empresas en los asuntos que gestiona nuestro equipo de abogados.' },
    {
      slug: 'contacto', title: 'Hablemos', route: '/contacto',
      text: 'Atención en Medellín y Bogotá.\nMedellín (Línea de atención general): Carrera 46 # 50-63, Edificio Playa Oriental, piso 11, Medellín. Línea 604 607 4101.\nBogotá (Línea de atención): Carrera 7 # 33-42, Edificio Corfivalle, Bogotá D. C.. Línea 604 607 4101.\nCorreo de contacto: gerencia@demo.test',
    },
    { slug: 'nosotros', title: 'Nosotros', route: '/nosotros', text: 'Quiénes somos: Cobranzas Demo S.A.S., identificada con NIT 901476289-2, tiene su sede principal en Medellín y atiende también en Bogotá.' },
  ],
});

let env: TestEnv;
let sup: ReturnType<typeof adminApi>;
let F: Fixture;
const script = new Map<string, object>();
const say = (question: string, out: object) => script.set(normalize(question), out);

beforeAll(async () => {
  // Igual que producción: atajo con el texto del sitio activo (CHAT_FAST_SCORE=2).
  env = await createEnv({ chatFastScore: 2 });
  env.llm.impl = async (messages) => {
    const out = script.get(normalize(messages.at(-1)!.content));
    if (!out) throw new LlmUnavailableError('sin guion en la prueba');
    return JSON.stringify(out);
  };
  await makeAdmin(env, { email: 'root-coh@test.local', role: 'superadmin' });
  sup = adminApi(env, await login(env, 'root-coh@test.local'));
  F = await setupCompany(env, sup, { slug: 'coherencia', name: 'Cobranzas Demo', origin: ORIGIN, advisors: 1 });
  await sup.patch(`/companies/${F.companyId}`, { contentUrl: `${ORIGIN}/chatbot-content.json` });
  env.fetcher.impl = async () => CONTENT;
  expect((await sup.post(`/companies/${F.companyId}/content/sync`)).status).toBe(200);
});
afterAll(async () => env.db.close());

async function talk(c: Awaited<ReturnType<typeof publicClient>>, ...messages: string[]) {
  const out: any[] = [];
  for (const message of messages) {
    const r = await c.post('/chat', { message, live: true });
    expect(r.status, message).toBe(200);
    out.push(r.body);
  }
  return out;
}

describe('coherencia del chat en vivo', () => {
  it('quien solo pide información nunca pasa a la cola; el nombre se pregunta una vez y la puntuación es correcta', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const calls = env.llm.calls.length;
    const r = await talk(c, 'hola', '¿qué servicios ofrecen?', '¿dónde están ubicados?', '¿cuál es el teléfono?', '¿tienen correo?', 'gracias');
    for (const x of r) expect(x).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(r.filter((x) => /Con quién tengo el gusto/.test(x.message))).toHaveLength(1);
    expect(r[1].message).toMatch(/^Nuestros servicios: Recuperación de cartera, asesoría legal y call center\./);
    // La misma línea para Medellín y Bogotá no se etiqueta con una sola sede.
    expect(r[3].message).toBe('Línea de atención: 604 607 4101');
    expect(r[2].message).toContain('Bogotá: Carrera 7 # 33-42');
    expect(r[2].message).not.toMatch(/\(Línea|\.\.|asesor/);
    expect(r[4].message).toBe('Correo de contacto: gerencia@demo.test');
    expect(r[5].message).toMatch(/^¡(Con gusto|Para servirte)!/);
    // Todo esto lo responde el sitio: no se gastó el modelo.
    expect(env.llm.calls.length).toBe(calls);
  });

  it('"ok" o "gracias" no se guardan como nombre', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [who, ok] = await talk(c, '¿eres un robot?', 'ok');
    expect(who.message).toMatch(/asistente virtual.*¿Con quién tengo el gusto\?$/s);
    expect(ok.message).not.toMatch(/Mucho gusto/);
    expect((await c.get('/conversation')).body.conversation.visitor_name).toBeNull();
  });

  it('una pregunta fuera de tema se redirige con amabilidad, sin pedir datos ni pasar a un asesor', async () => {
    say('¿cuál es la capital de Francia?', { intent: 'offtopic', answer: '' });
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [r] = await talk(c, '¿cuál es la capital de Francia?');
    expect(r).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(r.message).toContain('Cobranzas Demo');
    expect(r.message).not.toMatch(/nombre|documento|cartera/i);
  });

  it('no repite el mismo mensaje dos veces seguidas', async () => {
    say('¿cuál es la capital de Francia?', { intent: 'offtopic', answer: '' });
    say('cuéntame un chiste', { intent: 'offtopic', answer: '' });
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [a, b, t1, t2] = await talk(c, '¿cuál es la capital de Francia?', 'cuéntame un chiste', 'gracias', 'gracias');
    expect(b.message).not.toBe(a.message);
    expect(t2.message).not.toBe(t1.message);
  });

  it('lo que el sitio no dice: ofrece un asesor; "no" se respeta y "sí" pide solo nombre y documento', async () => {
    say('¿trabajan los sábados?', { intent: 'handoff', answer: 'Un asesor te confirmará el horario de atención.' });
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [offer, no, offer2, yes, name, doc] = await talk(c, '¿trabajan los sábados?', 'no gracias', '¿trabajan los sábados?', 'sí', 'Laura Pérez', 'cc 1.020.304.050');
    expect(offer.message).toBe('Un asesor te confirmará el horario de atención. ¿Quieres que te comunique con uno?');
    expect(no.message).toMatch(/^Está bien\. ¿Hay algo más/);
    expect(no.conversation.status).toBe('BOT_ACTIVO');
    expect(offer2.message).toMatch(/¿Quieres que te comunique con uno\?$/);
    // Una sola cartera activa: no se pregunta.
    expect(yes.message).toMatch(/¿me compartes tu nombre y tu número de documento\?$/);
    expect(yes.message).not.toMatch(/cartera/i);
    expect(name.message).toBe('Gracias, Laura. Para pasarte con el asesor solo me falta tu número de documento.');
    expect(doc).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    expect(doc.message).toMatch(/Ya tengo tus datos/);
    const snap = (await c.get('/conversation')).body.conversation;
    expect(snap).toMatchObject({ visitor_name: 'Laura Pérez', document: '1020304050' });
    expect(snap.portfolio_id).toBeTruthy();
  });

  it('sin modelo no cita frases del sitio que no responden la pregunta: ofrece un asesor', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [r] = await talk(c, '¿trabajan los domingos?');
    expect(r.message).toBe('En este momento no tengo esa respuesta a la mano. ¿Quieres que te comunique con un asesor?');
    expect(r.message).not.toMatch(/NIT/);
  });

  it('un asunto personal pide los datos y reconoce la cédula con puntos y el nombre en la misma frase', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [ask, data] = await talk(c, 'tengo una deuda y quiero hacer un acuerdo de pago', 'me llamo Ana Gómez, cédula 43.123.456');
    expect(ask.message).toMatch(/¿me compartes tu nombre y tu número de documento\?$/);
    expect(data).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    expect((await c.get('/conversation')).body.conversation).toMatchObject({ visitor_name: 'Ana Gómez', document: '43123456' });
  });

  it('preguntar por un servicio no es un asunto personal: se responde con el sitio', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [r] = await talk(c, '¿qué es la asesoría legal?');
    expect(r).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(r.message).toMatch(/^Asesoría Legal: Acompañamiento jurídico/);
  });

  it('cancelar la solicitud o negarse a dar datos se respeta', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [, cancel, after] = await talk(a, 'quiero hablar con un asesor', 'mejor no, ya no', '¿qué es la asesoría legal?');
    expect(cancel.message).toMatch(/no hay problema/);
    expect(after).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(after.message).not.toMatch(/compárteme|me compartes|me falta/);
    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, refuse] = await talk(b, 'necesito un abogado', 'prefiero no dar mis datos');
    expect(refuse).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    expect(refuse.message).not.toMatch(/te pedirá los datos/);
  });

  it('en espera explica la espera, agradece y no vuelve a pedir datos', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [queued, wait, thanks] = await talk(c, 'Hola, soy Carlos Ruiz, mi cédula es 71234567 y quiero hablar con un asesor', '¿cuánto se demora?', 'gracias');
    expect(queued).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    expect(queued.message).toBe('¡Claro, Carlos! Te comunico con un asesor. Ya tengo tus datos. Tu solicitud quedó en espera de un asesor, que continuará por este mismo chat.');
    expect(wait.message).toMatch(/fila de atención|sigue en espera/);
    expect(thanks.message).toMatch(/^¡Con gusto, Carlos!/);
    for (const x of [wait, thanks]) expect(x.message).not.toMatch(/documento|cartera|nombre/i);
  });

  it('un celular o un monto no se toman como cédula', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, phone, money, doc] = await talk(c, 'quiero hablar con un asesor', 'me llamo Sofía, mi celular es 3001234567', 'debo $1.500.000', 'mi cédula es 1.090.123.456');
    expect(phone.message).toBe('Gracias, Sofía. Para pasarte con el asesor solo me falta tu número de documento.');
    expect(money.message).toMatch(/compárteme tu número de documento\.$/);
    expect(money.message).not.toMatch(/asesor.*asesor/);
    expect(doc).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    expect((await c.get('/conversation')).body.conversation.document).toBe('1090123456');
  });

  it('el tema que verá el asesor es la consulta real, no la frase de pedir asesor', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    await talk(c, 'quiero hablar con un asesor');
    expect((await c.get('/conversation')).body.conversation.subject).toBe('');
    await talk(c, 'es por una deuda con Flamingo');
    expect((await c.get('/conversation')).body.conversation.subject).toBe('es por una deuda con Flamingo');
  });

  it('después de "¿Con quién tengo el gusto?" una pregunta corta se responde y no se guarda como nombre', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [ask, phone, vacantes] = await talk(c, '¿qué servicios ofrecen?', 'telefono', 'hay vacantes');
    expect(ask.message).toMatch(/¿Con quién tengo el gusto\?$/);
    expect(phone.message).toBe('Línea de atención: 604 607 4101');
    expect(vacantes.message).not.toMatch(/Mucho gusto/);
    expect((await c.get('/conversation')).body.conversation.visitor_name).toBeNull();
  });

  it('saludo + pregunta: saluda y responde la pregunta', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [r] = await talk(c, 'hola, ¿cuál es el teléfono?');
    expect(r.message).toMatch(/^¡Hola! Línea de atención: 604 607 4101/);
  });

  it('un número de la empresa en una pregunta se confirma y no se guarda como documento', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [r] = await talk(c, '¿El 604 607 4101 es de ustedes?');
    expect(r.message).toMatch(/^Sí, el 604 607 4101 es la línea de atención/);
    expect((await c.get('/conversation')).body.conversation.document).toBeNull();
  });

  it('montos y celulares mientras pide los datos no son la cédula; el celular se agradece como contacto', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, money, phone] = await talk(c, 'me estan cobrando 850.000 de una deuda que ya pague', 'debo 2.300.000', 'mi wsp 3104567890');
    expect(money.message).not.toMatch(/ya tengo tu número de documento/);
    expect(phone.message).toMatch(/^Gracias, el asesor verá tu número de contacto\./);
    expect((await c.get('/conversation')).body.conversation.document).toBeNull();
  });

  it('si el último dato llega con una pregunta, la responde y el aviso de la cola va aparte (sin agradecer dos veces)', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, name, last] = await talk(c, 'quiero hablar con un asesor', 'Laura Gómez', 'mi cédula es 1020304050, ¿cuál es el correo?');
    expect(name.message).toBe('Gracias, Laura. Para pasarte con el asesor solo me falta tu número de documento.');
    expect(last).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    const msgs = (await c.get('/conversation')).body.messages;
    const [bot, system] = msgs.slice(-2);
    expect(bot.sender_type).toBe('BOT');
    expect(bot.content).toMatch(/gerencia@demo\.test/);
    expect(system.sender_type).toBe('SYSTEM');
    expect(`${bot.content} ${system.content}`.match(/Gracias/g)).toHaveLength(1);
  });

  it('mientras pide los datos: "un momento" espera, "¿para qué?" se explica y "no" pasa sin datos', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, hold, why, no] = await talk(c, 'necesito hablar con un asesor', 'un momento', '¿para qué necesitan mis datos?', 'no');
    expect(hold.message).toMatch(/aquí te espero/);
    expect(why.message).toMatch(/identifique tu caso/);
    expect(no).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    expect(no.message).toMatch(/^Entiendo, no hay problema\./);
  });

  it('en la cola puede desistir; "no gracias" a "¿te ayudo con algo más?" no suelta la solicitud', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [queued, no, cancel, after] = await talk(c, 'Hola, soy Pedro Ruiz, cédula 52000112, quiero hablar con un asesor', 'no gracias', 'ya no necesito el asesor, gracias', '¿qué es la asesoría legal?');
    expect(queued.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect(no.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect(cancel).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(cancel.message).toMatch(/cancelé tu solicitud/);
    expect(after).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
  });

  it('negar el asesor o buscar empleo como asesor no inicia la toma de datos', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [neg, job] = await talk(c, 'no quiero hablar con un asesor, solo quiero saber dónde quedan', 'quiero trabajar como asesor de cobranza');
    expect(neg.message).toContain('Carrera 46 # 50-63');
    for (const r of [neg, job]) {
      expect(r.conversation.status).toBe('BOT_ACTIVO');
      expect(r.message).not.toMatch(/me compartes|compárteme|me falta/);
    }
  });

  it('cuando el asesor devuelve el chat al bot, un "gracias" no lo vuelve a poner en la cola', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [queued] = await talk(c, 'Hola, soy Rosa Gil, cédula 52000113, quiero hablar con un asesor');
    const id = queued.conversation.id;
    expect((await sup.post(`/companies/${F.companyId}/chat-sessions/${id}/take`, {})).status).toBe(200);
    expect((await sup.post(`/companies/${F.companyId}/chat-sessions/${id}/release`, { destination: 'bot' })).status).toBe(200);
    const [thanks, question] = await talk(c, 'muchas gracias', '¿cuál es el correo?');
    expect(thanks).toMatchObject({ type: 'answer', conversation: { status: 'BOT_ACTIVO' } });
    expect(thanks.message).toMatch(/^¡(Con gusto|Para servirte)/);
    expect(question).toMatchObject({ type: 'answer', message: 'Correo de contacto: gerencia@demo.test', conversation: { status: 'BOT_ACTIVO' } });
    const snap = (await c.get('/conversation')).body;
    expect(snap.messages.some((m: any) => m.sender_type === 'SYSTEM' && /finalizó la atención/.test(m.content))).toBe(true);
  });

  it('dos mensajes a la vez se atienden en orden: tras pasar a la cola no vuelve a pedir datos', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    await talk(c, 'quiero hablar con un asesor');
    await Promise.all([c.post('/chat', { message: 'Juan Pérez 1020304050', live: true }), c.post('/chat', { message: 'gracias', live: true })]);
    const msgs = (await c.get('/conversation')).body.messages;
    const queuedAt = msgs.findIndex((m: any) => m.sender_type === 'SYSTEM');
    expect(queuedAt).toBeGreaterThan(0);
    for (const m of msgs.slice(queuedAt + 1)) expect(m.content).not.toMatch(/me compartes|compárteme|me falta/);
  });

  it('revisión 2: nombres poco comunes y con tratamiento se guardan; términos y negativas no', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, wilmar, doc] = await talk(c, 'quiero hablar con un asesor', 'wilmar gomez', '1020304050');
    expect(wilmar.message).toBe('Gracias, Wilmar. Para pasarte con el asesor solo me falta tu número de documento.');
    expect(doc).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    expect((await c.get('/conversation')).body.conversation).toMatchObject({ visitor_name: 'Wilmar Gomez', document: '1020304050', subject: '' });

    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [, dr] = await talk(d, 'quiero hablar con un asesor', 'Dr. Jaime Ruiz 79123456');
    expect(dr.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect((await d.get('/conversation')).body.conversation.visitor_name).toBe('Jaime Ruiz');

    const e = await publicClient(env, 'coherencia', ORIGIN);
    const [, prices, refuse] = await talk(e, '¿qué servicios ofrecen?', 'precios', 'prefiero no decirlo');
    expect(prices.message).not.toMatch(/Mucho gusto/);
    expect(refuse.message).not.toMatch(/Mucho gusto/);
    expect((await e.get('/conversation')).body.conversation.visitor_name).toBeNull();
    const f = await publicClient(env, 'coherencia', ORIGIN);
    const [, no] = await talk(f, '¿qué servicios ofrecen?', 'prefiero no decirlo');
    expect(no.message).toBe('Está bien, no hay problema. ¿En qué te puedo ayudar?');
  });

  it('revisión 2: "¿eres una persona real?" se presenta; pedidos de asesor con otras palabras inician la toma de datos', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [who] = await talk(c, 'eres una persona real?');
    expect(who.message).toMatch(/^Soy el asistente virtual de Cobranzas Demo\./);
    expect(who.conversation.status).toBe('BOT_ACTIVO');
    for (const m of ['¿Me podrían comunicar con un asesor?', 'quiero hablar de nuevo con un asesor', 'Deseo ser atendido por un asesor']) {
      const d = await publicClient(env, 'coherencia', ORIGIN);
      const [r] = await talk(d, m);
      expect(r.message, m).toMatch(/^¡Claro! Te comunico con un asesor\. Para que te atienda desde el primer mensaje, ¿me compartes tu nombre y tu número de documento\?$/);
    }
  });

  it('revisión 2: "ya cancelé" no cancela; en la cola "mejor no" responde a la pregunta del bot', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, queued, paid] = await talk(c, 'tengo una deuda con ustedes', 'Ana Ruiz 43123456', 'ya cancelé');
    expect(queued.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect(paid.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect(paid.message).not.toMatch(/cancelé tu solicitud/);
    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [, , help, no] = await talk(d, 'quiero un asesor', 'Ana Ruiz 43123457', 'necesito ayuda', 'mejor no');
    expect(help.message).toMatch(/\?/);
    expect(no.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect(no.message).toMatch(/El asesor (te escribirá|continuará)/);
  });

  it('revisión 2: desistir con una pregunta suelta la toma de datos y la responde; despedirse no lo pasa a la cola', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, forget, thanks] = await talk(c, 'quiero hablar con un asesor', 'olvídalo, ¿cuál es el correo?', 'gracias');
    expect(forget.message).toMatch(/^Listo, no hay problema\. Correo de contacto: gerencia@demo\.test/);
    for (const r of [forget, thanks]) expect(r.conversation.status).toBe('BOT_ACTIVO');
    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [, , bye] = await talk(d, 'quiero un asesor', 'Juan Pérez', 'ya no me interesa');
    expect(bye.message).toMatch(/no hay problema/);
    const [after] = await talk(d, 'chao');
    expect(after.conversation.status).toBe('BOT_ACTIVO');
  });

  it('revisión 2: "por favor" acepta la oferta; "sí, ¿cuál es el correo?" se responde; "no quiero asesor, gracias" no ofrece uno', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [offer, yes] = await talk(c, '¿cuánto cuesta el servicio?', 'por favor');
    expect(offer.message).toMatch(/¿Quieres que te comunique con un asesor\?$/);
    expect(yes.message).toMatch(/^¡Listo! Te comunico con un asesor\./);
    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [, no, mail] = await talk(d, '¿cuánto cuesta el servicio?', 'no', 'sí, ¿cuál es el correo?');
    expect(no.message).toMatch(/¿Hay algo más en lo que te pueda ayudar\?$/);
    expect(mail.message).toContain('gerencia@demo.test');
    const e = await publicClient(env, 'coherencia', ORIGIN);
    const [, neg] = await talk(e, 'necesito ayuda', 'No quiero asesor, gracias');
    expect(neg.message).not.toMatch(/comunique con un asesor/);
  });

  it('revisión 2: saludo, nombre y respuesta sin repetir; quejas y ciudades sin sede sin "esa respuesta"', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [greet] = await talk(c, 'hola, me llamo Juan y quiero saber qué servicios ofrecen');
    expect(greet.message).toMatch(/^¡Hola, Juan! Mucho gusto\. Nuestros servicios: /);
    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [complaint, cali] = await talk(d, 'La línea 604 607 4101 no contesta', '¿tienen sede en Cali?');
    expect(complaint.message).toMatch(/^Lamento/);
    expect(complaint.message).not.toMatch(/esa respuesta/);
    expect(cali.message).toMatch(/^En el sitio no aparece una sede en Cali\. Nuestras sedes publicadas están en Medellín y Bogotá\./);
    const e = await publicClient(env, 'coherencia', ORIGIN);
    const [called] = await talk(e, 'Me llamaron del 604 607 4101, ¿es de ustedes?');
    expect(called.message).toMatch(/^Sí, el 604 607 4101 es la línea de atención publicada en nuestro sitio\. .*¿me compartes tu nombre y tu número de documento\?$/);
  });

  it('revisión 2: mientras pide los datos, un "sí" o una palabra suelta no reciben "Eso te lo resolverá el asesor"', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, yes, laugh] = await talk(c, 'quiero un asesor', 'si', 'jajaja');
    expect(yes.message).toBe('Perfecto. Para pasarte con el asesor solo me faltan tu nombre y tu número de documento.');
    expect(laugh.message).not.toMatch(/Eso te lo resolverá/);
    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [, id] = await talk(d, 'quiero hablar con un asesor', 'tarjeta de identidad 1001234567');
    expect(id.message).toBe('Gracias, ya tengo tu número de documento. Para pasarte con el asesor solo me falta tu nombre.');
    expect((await d.get('/conversation')).body.conversation.subject).toBe('');
  });

  it('revisión 2: en la cola los datos repetidos no reciben el mismo texto y un nombre claro se guarda', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, refused, , named, again1, again2] = await talk(c, 'necesito hablar con un asesor', 'prefiero no dar mis datos', 'ya',
      'bueno, Juan Pérez', '1020304050', '1020304050');
    expect(refused.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect(named.message).toMatch(/^Gracias, Juan\./);
    expect(again1.message).not.toBe(again2.message);
    expect((await c.get('/conversation')).body.conversation).toMatchObject({ visitor_name: 'Juan Pérez', document: '1020304050' });
  });

  it('revisión 3: al pedir los datos, la primera palabra de una frase, una condición o una marca no es el nombre', async () => {
    for (const m of ['cuentame un chiste', 'mira lo que pasa es que me llegó un mensaje', 'permítame un momento', 'soy viuda y no puedo pagar',
      'es con Sodimac', 'domingo te los mando', 'Comcel']) {
      const c = await publicClient(env, 'coherencia', ORIGIN);
      const [, r] = await talk(c, 'quiero un asesor', m);
      expect(r.message, m).not.toMatch(/Gracias, (Cuentame|Mira|Permítame|Permitame|Viuda|Sodimac|Domingo|Comcel)\b/i);
      expect((await c.get('/conversation')).body.conversation.visitor_name, m).toBeNull();
    }
    // "Permítame un momento" es una espera; "cuéntame un chiste" se sale del tema y no queda como nombre.
    const h = await publicClient(env, 'coherencia', ORIGIN);
    const [, hold] = await talk(h, 'quiero un asesor', 'permítame un momento');
    expect(hold.message).toMatch(/aquí te espero/);
  });

  it('revisión 3: el nombre después de "mis datos son…", junto a una negativa o antes del pasaporte se guarda', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [, queued] = await talk(a, 'quiero hablar con un asesor', 'mis datos son Juan Pérez cc 1020304050');
    expect(queued.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect((await a.get('/conversation')).body.conversation).toMatchObject({ visitor_name: 'Juan Pérez', document: '1020304050', subject: '' });

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, noDoc] = await talk(b, 'quiero hablar con un asesor', 'Juan Pérez, no tengo la cédula a la mano');
    expect(noDoc.message).toBe('Gracias, Juan. Entiendo, no hay problema. Tu solicitud quedó en espera de un asesor, que continuará por este mismo chat.');
    expect((await b.get('/conversation')).body.conversation.visitor_name).toBe('Juan Pérez');

    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, refused] = await talk(c, 'quiero hablar con un asesor', 'me llamo Juan Pérez, la cédula no te la doy');
    expect(refused.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect((await c.get('/conversation')).body.conversation.visitor_name).toBe('Juan Pérez');

    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [, passport] = await talk(d, 'quiero hablar con un asesor', 'pasaporte AB123456 Juan Pérez');
    expect(passport.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect((await d.get('/conversation')).body.conversation).toMatchObject({ visitor_name: 'Juan Pérez', document: 'AB123456' });

    // "No tengo cédula, tengo pasaporte…" entrega el documento: se pide el nombre, no se pasa a la cola sin él.
    const e = await publicClient(env, 'coherencia', ORIGIN);
    const [, onlyName] = await talk(e, 'quiero hablar con un asesor', 'no tengo cédula, tengo pasaporte AB123456');
    expect(onlyName.message).toBe('Gracias, ya tengo tu número de documento. Para pasarte con el asesor solo me falta tu nombre.');
  });

  it('revisión 3: corregir el nombre con "no es X, es Y" lo cambia', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, , fixed] = await talk(c, 'quiero un asesor', 'Ana Ruiz', 'no es Ana Ruiz, es Ana Rojas');
    expect(fixed.message).toBe('Listo, Ana, corregí tu nombre. Para pasarte con el asesor solo me falta tu número de documento.');
    expect((await c.get('/conversation')).body.conversation).toMatchObject({ visitor_name: 'Ana Rojas', subject: '' });
  });

  it('revisión 3: una pregunta sin signo junto a un dato se responde; "no, mejor dime…" suelta la toma y responde', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    await talk(a, 'quiero hablar con un asesor', 'Juan Pérez', '1020304050 y cual es el correo');
    const msgs = (await a.get('/conversation')).body.messages;
    expect(msgs.some((m: any) => m.sender_type === 'BOT' && /gerencia@demo\.test/.test(m.content))).toBe(true);
    expect(msgs.at(-1)).toMatchObject({ sender_type: 'SYSTEM' });

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, better, ok] = await talk(b, 'quiero hablar con un asesor', 'no, mejor dime el teléfono', 'ok');
    expect(better.message).toBe('Listo, no hay problema. Línea de atención: 604 607 4101. Si más adelante quieres hablar con un asesor, solo dímelo.');
    expect(ok.conversation.status).toBe('BOT_ACTIVO');
  });

  it('revisión 3: en la cola "ya no me interesa" cancela; desistir con una pregunta cancela y la responde', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [, , bye] = await talk(a, 'quiero un asesor', 'Juan Pérez 1020304050', 'ya no me interesa');
    expect(bye).toMatchObject({ conversation: { status: 'BOT_ACTIVO' } });
    expect(bye.message).toMatch(/^Listo, Juan, cancelé tu solicitud de asesor/);

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, , both] = await talk(b, 'quiero un asesor', 'Juan Pérez 1020304050', 'no quiero esperar, cual es el correo?');
    expect(both.conversation.status).toBe('BOT_ACTIVO');
    expect(both.message).toBe('Listo, Juan, cancelé tu solicitud de asesor. Correo de contacto: gerencia@demo.test. Si más adelante necesitas un asesor, solo dímelo.');
  });

  it('revisión 3: pedir un asesor con otra pregunta la responde; "no quiero que me llamen" no es pedir un asesor', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [both] = await talk(a, 'quiero un asesor, pero primero dime el correo');
    expect(both.message).toBe('Correo de contacto: gerencia@demo.test. Te comunico con un asesor. Para que te atienda desde el primer mensaje, ¿me compartes tu nombre y tu número de documento?');

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [calls] = await talk(b, 'no quiero que me llamen');
    expect(calls.message).not.toMatch(/Te comunico|nombre y tu número/);
    expect(calls.conversation.status).toBe('BOT_ACTIVO');

    const c = await publicClient(env, 'coherencia', ORIGIN);
    for (const [m, who] of [['quiero otro asesor', 'otro'], ['quiero hablar con el gerente', 'un']]) {
      const [r] = await talk(await publicClient(env, 'coherencia', ORIGIN), m);
      expect(r.message, m).toMatch(new RegExp(`^¡Claro! Te comunico con ${who} asesor\\.`));
    }
    const [phone] = await talk(c, '¿cuál es el teléfono para hablar con un asesor?');
    expect(phone.message).toBe('Línea de atención: 604 607 4101. Si prefieres, también te comunico por aquí con un asesor. ¿Quieres?');
  });

  it('revisión 3: nombre y cédula sin que se pidan, saludos, cierres y preguntas cortas junto al nombre', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [data] = await talk(a, 'Juan Pérez 1020304050');
    expect(data.message).toBe('Gracias, Juan, ya anoté tus datos. ¿En qué te puedo ayudar?');
    expect((await a.get('/conversation')).body.conversation).toMatchObject({ visitor_name: 'Juan Pérez', document: '1020304050', subject: '' });

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [hi] = await talk(b, 'hola como estan');
    expect(hi.message).toMatch(/^¡Hola! Muy bien, gracias\./);

    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, thanks, no] = await talk(c, '¿qué servicios ofrecen?', 'gracias, ya me quedó claro todo', 'no');
    expect(thanks.message).toMatch(/^¡(Con gusto|Para servirte)/);
    expect(no.message).toMatch(/^(Está bien|De acuerdo)\./);

    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [named] = await talk(d, 'me llamo Ana, el telefono?');
    expect(named.message).toBe('Mucho gusto, Ana. Línea de atención: 604 607 4101');

    const e = await publicClient(env, 'coherencia', ORIGIN);
    const [nit] = await talk(e, '¿el NIT 900123456-1 es de ustedes?');
    expect(nit.message).toMatch(/^Ese número no aparece en nuestro sitio\. El NIT que publicamos es 901476289-2\./);
    expect((await e.get('/conversation')).body.conversation.document).toBeNull();
  });

  it('revisión 3: sin modelo, una pregunta compuesta da lo publicado; "no necesito asesor" no recibe la oferta', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [both] = await talk(a, '¿cuál es el teléfono y el horario?');
    expect(both.message).toMatch(/^Línea de atención: 604 607 4101\. El horario de atención no aparece publicado en el sitio\. ¿Quieres que te comunique con un asesor\?$/);

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [neg] = await talk(b, 'no necesito asesor, ¿trabajan los sábados?');
    expect(neg.message).not.toMatch(/comunique con un asesor/);
    expect(neg.message).toMatch(/¿Te ayudo con algo más\?$/);

    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [city] = await talk(c, '¿Atienden en Bogotá?');
    expect(city.message).toContain('Carrera 7 # 33-42');
    const [mine] = await talk(c, 'Soy de Cali, ¿cuál es el correo?');
    expect(mine.message).toMatch(/gerencia@demo\.test/);
  });

  it('al tomar el control el aviso no nombra otra empresa', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [queued] = await talk(c, 'Hola, soy Marta Díaz, cédula 52000111, quiero hablar con un asesor');
    const taken = await sup.post(`/companies/${F.companyId}/chat-sessions/${queued.conversation.id}/take`, {});
    expect(taken.status).toBe(200);
    // El usuario de la prueba se llama con un correo: al visitante no se le muestra.
    expect(taken.body.message.content).toBe('Un asesor tomó tu conversación y te atenderá en vivo por este medio.');
    const snapshot = await c.get('/conversation');
    expect(snapshot.body.conversation.status).toBe('TOMADO_POR_ASESOR');
  });
});

describe('empresa con varias carteras', () => {
  it('pregunta la cartera con la lista y la reconoce por su alias', async () => {
    const G = await setupCompany(env, sup, { slug: 'coherencia-dos', name: 'Cobranzas Dos', origin: 'https://dos.test', advisors: 1 });
    const flamingo = await sup.post(`/companies/${G.companyId}/portfolios`, { key: 'flamingo', name: 'Flamingo', aliases: ['almacenes flamingo'] });
    expect(flamingo.status).toBe(201);
    const c = await publicClient(env, 'coherencia-dos', 'https://dos.test');
    const [ask, done] = await talk(c, 'quiero hablar con un asesor', 'Juan Pérez 1020304050, es con almacenes flamingo');
    expect(ask.message).toMatch(/la cartera de tu consulta \(.*Flamingo.*\)\?$/);
    expect(done).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    expect((await c.get('/conversation')).body.conversation.portfolio_id).toBe(flamingo.body.id);
    // Con un asesor al mando, nombrar otra cartera no la cambia (el asesor perdería el acceso al chat).
    const linked = await sup.post(`/companies/${G.companyId}/phones`, { advisorId: G.advisorIds[0], number: fakePhone(7770001), isPrimary: false, portfolioId: flamingo.body.id });
    expect(linked.status).toBe(201);
    expect((await sup.post(`/companies/${G.companyId}/chat-sessions/${done.conversation.id}/take`, {})).status).toBe(200);
    const [taken] = await talk(c, 'perdón, mi cartera es General');
    expect(taken.type).toBe('live');
    expect((await c.get('/conversation')).body.conversation.portfolio_id).toBe(flamingo.body.id);
    // Preguntar por un aliado no es dar la cartera.
    const d = await publicClient(env, 'coherencia-dos', 'https://dos.test');
    await talk(d, '¿trabajan con Flamingo?');
    expect((await d.get('/conversation')).body.conversation.portfolio_id).toBeNull();
  });

  it('revisión 2: "un asesor de X" anota la cartera; sin cartera pasa a la cola en la cartera por defecto; en la cola se puede dar después', async () => {
    const H = await setupCompany(env, sup, { slug: 'coherencia-tres', name: 'Cobranzas Tres', origin: 'https://tres.test', advisors: 1 });
    const flamingo = await sup.post(`/companies/${H.companyId}/portfolios`, { key: 'flamingo', name: 'Flamingo' });
    const general = (await sup.get(`/companies/${H.companyId}/portfolios`)).body.items.find((p: any) => p.key === 'general');
    const c = await publicClient(env, 'coherencia-tres', 'https://tres.test');
    const [ask, done] = await talk(c, 'quiero hablar con un asesor de flamingo', 'Juan Pérez 1020304050');
    expect(ask.message).toBe('¡Claro! Te comunico con un asesor. Ya anoté la cartera Flamingo. Para que te atienda desde el primer mensaje, ¿me compartes tu nombre y tu número de documento?');
    expect(done.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect((await c.get('/conversation')).body.conversation.portfolio_id).toBe(flamingo.body.id);
    // También en la cola: "también tengo una deuda con…" no cambia la cartera ya elegida.
    await talk(c, 'también tengo una deuda con general');
    expect((await c.get('/conversation')).body.conversation.portfolio_id).toBe(flamingo.body.id);

    const d = await publicClient(env, 'coherencia-tres', 'https://tres.test');
    const [, , unknown] = await talk(d, 'quiero hablar con un asesor', 'Ana Ruiz 43123456', 'no sé cuál es');
    expect(unknown).toMatchObject({ type: 'live', conversation: { status: 'EN_ESPERA_ASESOR' } });
    expect((await d.get('/conversation')).body.conversation.portfolio_id).toBe(general.id);

    const e = await publicClient(env, 'coherencia-tres', 'https://tres.test');
    const [, both] = await talk(e, 'quiero hablar con un asesor', 'Juan Pérez 1020304051 flamingo');
    expect(both.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect((await e.get('/conversation')).body.conversation.portfolio_id).toBe(flamingo.body.id);
  });

  it('revisión 3: la cartera por defecto se reemplaza con la que diga después; la negada no cuenta; un "claro" inicial es un sí', async () => {
    const H = await setupCompany(env, sup, { slug: 'coherencia-cuatro', name: 'Cobranzas Cuatro', origin: 'https://cuatro.test', advisors: 1 });
    const flamingo = await sup.post(`/companies/${H.companyId}/portfolios`, { key: 'flamingo', name: 'Flamingo' });
    const offcorss = await sup.post(`/companies/${H.companyId}/portfolios`, { key: 'offcorss', name: 'Offcorss' });
    const claro = await sup.post(`/companies/${H.companyId}/portfolios`, { key: 'claro', name: 'Claro' });
    const general = (await sup.get(`/companies/${H.companyId}/portfolios`)).body.items.find((p: any) => p.key === 'general');
    const site = 'https://cuatro.test';

    const c = await publicClient(env, 'coherencia-cuatro', site);
    await talk(c, 'quiero hablar con un asesor', 'Juan Pérez 1020304050', 'no sé');
    expect((await c.get('/conversation')).body.conversation.portfolio_id).toBe(general.id);
    const [later] = await talk(c, 'ah ya me acordé, mi cartera es flamingo');
    expect(later.message).toBe('Gracias, Juan, anoté la cartera Flamingo. Se lo paso al asesor, que continuará por este mismo chat.');
    expect((await c.get('/conversation')).body.conversation.portfolio_id).toBe(flamingo.body.id);
    // Ya elegida por el visitante, otra mención no la cambia; una corrección clara sí.
    await talk(c, 'es con offcorss');
    expect((await c.get('/conversation')).body.conversation.portfolio_id).toBe(flamingo.body.id);
    const [fixed] = await talk(c, 'perdón, es offcorss');
    expect(fixed.message).toMatch(/^Listo, Juan, corregí la cartera/);
    expect((await c.get('/conversation')).body.conversation.portfolio_id).toBe(offcorss.body.id);

    const d = await publicClient(env, 'coherencia-cuatro', site);
    await talk(d, 'quiero hablar con un asesor', 'Juan Pérez 1020304050', 'no es flamingo, es offcorss');
    expect((await d.get('/conversation')).body.conversation.portfolio_id).toBe(offcorss.body.id);

    const e = await publicClient(env, 'coherencia-cuatro', site);
    const [, yes] = await talk(e, 'quiero hablar con un asesor', 'claro, me llamo Pedro Pérez');
    expect(yes.message).toMatch(/^Gracias, Pedro\. Para pasarte con el asesor solo me faltan tu número de documento y la cartera de tu consulta \(/);
    expect((await e.get('/conversation')).body.conversation.portfolio_id).toBeNull();
    const [, picked] = await talk(e, '1020304050', 'claro');
    expect(picked.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect((await e.get('/conversation')).body.conversation.portfolio_id).toBe(claro.body.id);

    // Una pregunta sobre los asesores de una cartera no la anota.
    const f = await publicClient(env, 'coherencia-cuatro', site);
    const [asks] = await talk(f, '¿cuántos asesores de flamingo tienen?');
    expect(asks.message).not.toMatch(/anoté la cartera/);
    expect((await f.get('/conversation')).body.conversation.portfolio_id).toBeNull();
  });

  it('revisión 3: el panel devuelve a la cola una conversación sin cartera: queda en la cartera por defecto', async () => {
    const H = await setupCompany(env, sup, { slug: 'coherencia-cinco', name: 'Cobranzas Cinco', origin: 'https://cinco.test', advisors: 1 });
    await sup.post(`/companies/${H.companyId}/portfolios`, { key: 'flamingo', name: 'Flamingo' });
    const general = (await sup.get(`/companies/${H.companyId}/portfolios`)).body.items.find((p: any) => p.key === 'general');
    const c = await publicClient(env, 'coherencia-cinco', 'https://cinco.test');
    const [ask] = await talk(c, 'quiero un asesor');
    const id = ask.conversation.id;
    expect((await sup.post(`/companies/${H.companyId}/chat-sessions/${id}/take`, {})).status).toBe(200);
    expect((await sup.post(`/companies/${H.companyId}/chat-sessions/${id}/release`, { destination: 'queue' })).status).toBe(200);
    expect((await c.get('/conversation')).body.conversation).toMatchObject({ status: 'EN_ESPERA_ASESOR', portfolio_id: general.id });
  });
});

describe('widget sin chat en vivo', () => {
  it('sin modelo, desde el segundo mensaje una pregunta que el sitio responde se cita (no "no está publicado" ni WhatsApp)', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const first = await c.post('/chat', { message: 'hola' });
    expect(first.body.type).toBe('answer');
    const r = await c.post('/chat', { message: '¿qué servicios ofrecen?', history: [{ role: 'user', content: 'hola' }, { role: 'assistant', content: first.body.message }] });
    expect(r.body).toMatchObject({ type: 'answer' });
    expect(r.body.message).toMatch(/^Nuestros servicios: Recuperación de cartera/);
    expect(r.body.waUrl).toBeUndefined();
  });
});

describe('contenido del sitio', () => {
  it('si una re-sincronización falla, el bot sigue usando el último contenido bueno', async () => {
    env.fetcher.impl = async () => {
      throw new Error('sitio caído');
    };
    try {
      await sup.post(`/companies/${F.companyId}/content/sync`);
      expect((await env.db.query<{ content_status: string }>('SELECT content_status FROM companies WHERE id = $1', [F.companyId])).rows[0].content_status).toBe('error');
      const c = await publicClient(env, 'coherencia', ORIGIN);
      const [r] = await talk(c, '¿cuál es el correo?');
      expect(r.message).toMatch(/^Correo de contacto: gerencia@demo\.test/);
    } finally {
      env.fetcher.impl = async () => CONTENT;
    }
  });
});

describe('revisión 4: conversaciones', () => {
  const conv = async (c: Awaited<ReturnType<typeof publicClient>>) => (await c.get('/conversation')).body;

  it('negar un nombre no lo guarda; negar el guardado lo borra y se vuelve a pedir', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [r] = await talk(a, 'Me llaman cobrando a Juan Pérez, pero yo no soy Juan Pérez');
    expect(r.message).toMatch(/¿me compartes tu nombre y tu número de documento\?$/);
    expect((await conv(a)).conversation.visitor_name).toBeNull();

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, , denied] = await talk(b, 'quiero un asesor', 'Pedro Gómez', 'no me llamo Pedro');
    expect(denied.message).toBe('Disculpa la confusión. Para pasarte con el asesor, compárteme tu nombre y tu número de documento.');
    expect((await conv(b)).conversation.visitor_name).toBeNull();
    const [fixed] = await talk(b, 'no me llamo Pedro sino Juan Gómez');
    expect(fixed.message).toMatch(/^Gracias, Juan\./);
  });

  it('"la cédula correcta es…" corrige el documento sin tomar "Correcta" como nombre; "Con Pedro" es el nombre', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [, , fix] = await talk(a, 'quiero hablar con un asesor', '1020304050', 'disculpa, la cedula correcta es 1020304051');
    expect(fix.message).toBe('Listo, corregí tu número de documento. Para pasarte con el asesor solo me falta tu nombre.');
    expect((await conv(a)).conversation).toMatchObject({ visitor_name: null, document: '1020304051', status: 'BOT_ACTIVO' });

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, named] = await talk(b, 'quiero un asesor', 'Con Pedro');
    expect(named.message).toBe('Gracias, Pedro. Para pasarte con el asesor solo me falta tu número de documento.');
  });

  it('una queja sobre un asesor no es negarlo; "un asesor, no un robot" lo pide', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [r] = await talk(a, 'el asesor no me contestó ayer');
    expect(r.message).toMatch(/^Lamento (el inconveniente|lo ocurrido)/);
    expect(r.message).toMatch(/¿Quieres que te comunique con uno\?$/);
    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [h] = await talk(b, 'quiero un asesor, no un robot');
    expect(h.message).toMatch(/^¡Claro! Te comunico con un asesor\. Para que te atienda desde el primer mensaje/);
  });

  it('en la cola, "no quiero nada más" responde a "¿algo más?" sin cancelar; preguntar la espera al completar los datos no se contradice', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [, , more, none] = await talk(a, 'quiero un asesor', 'Ana Ruiz 43123456', '¿cuánto debo?', 'no quiero nada más, gracias');
    expect(more.message).toMatch(/¿te ayudo con algo más\?|¿Te ayudo con algo más mientras tanto\?/);
    expect(none.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect(none.message).toMatch(/El asesor (continuará contigo|te escribirá)/);

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, , waited] = await talk(b, 'necesito un asesor', 'Juan Pérez', '1020304050 y cuanto se demoran');
    expect(waited.conversation.status).toBe('EN_ESPERA_ASESOR');
    const bot = (await conv(b)).messages.filter((m: any) => m.sender_type === 'BOT').at(-1);
    expect(bot.content).not.toMatch(/En cuanto me compartas/);
    expect(bot.content).toMatch(/el asesor te escribirá por este mismo chat/);
  });

  it('al pedir los datos: preguntas sin signo, imperativos y desistir con "y" se responden', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [, where] = await talk(a, 'quiero un asesor', '1020304050 dónde quedan');
    expect(where.message).toContain('Carrera 46 # 50-63');
    expect(where.message).toMatch(/compárteme tu nombre\.$/);

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, mail] = await talk(b, 'quiero un asesor', 'dame el correo');
    expect(mail.message).toMatch(/^Correo de contacto: gerencia@demo\.test\. Para pasarte con el asesor, compárteme tu nombre y tu número de documento\.$/);

    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [, phone] = await talk(c, 'quiero hablar con un asesor', 'olvídalo y dime el teléfono');
    expect(phone.message).toMatch(/^Listo, no hay problema\. .*604 607 4101.*Si más adelante quieres hablar con un asesor, solo dímelo\.$/);

    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [, doc] = await talk(d, 'quiero un asesor', '¿y si no tengo cédula?');
    expect(doc.message).toMatch(/^Puedes darme el número de otro documento de identidad/);
    expect(doc.conversation.status).toBe('BOT_ACTIVO');
  });

  it('pedir un asesor o cancelar con una pregunta sin respuesta publicada no la ignora', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [r] = await talk(a, 'quiero un asesor, pero antes dime el horario');
    expect(r.message).toMatch(/^El horario de atención no aparece publicado en el sitio\..*Te comunico con un asesor/);
    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, c] = await talk(b, 'quiero un asesor', 'mejor no, dime el horario');
    expect(c.message).toMatch(/^Listo, no hay problema\. El horario de atención no aparece publicado en el sitio\./);
  });

  it('respuestas a la oferta: "estoy de acuerdo", "no gracias, chao", "no entiendo" y "quiero preguntar otra cosa"', async () => {
    const offer = async (answer: string) => {
      const c = await publicClient(env, 'coherencia', ORIGIN);
      const [o, r] = await talk(c, '¿trabajan los domingos?', answer);
      expect(o.message).toMatch(/¿Quieres que te comunique con un asesor\?$/);
      return r.message as string;
    };
    expect(await offer('estoy de acuerdo')).toMatch(/^¡Listo! Te comunico con un asesor\./);
    expect(await offer('no gracias, chao')).toMatch(/^¡(Con gusto|Para servirte)!/);
    expect(await offer('no entiendo')).toMatch(/^(Te explico|Me refiero)/);
    expect(await offer('quiero preguntar otra cosa')).toMatch(/^(¡Claro! Dime, ¿qué quieres preguntar\?|Claro, cuéntame\.)/);
  });

  it('cierres y saludos: "gracias" repetido, "gracias" con valoración, "hola, gracias" y el saludo social con el nombre', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    for (const r of await talk(a, 'gracias', 'gracias', 'gracias')) expect(r.message).toMatch(/^¡(Con gusto|Para servirte)!/);
    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, v] = await talk(b, '¿qué es el call center?', 'muy clara la información, gracias');
    expect(v.message).toMatch(/^¡(Con gusto|Para servirte)!/);
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [h] = await talk(c, 'Hola, gracias');
    expect(h.message).toMatch(/^¡Hola!/);
    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [s] = await talk(d, 'hola, ¿qué tal? soy Luisa');
    expect(s.message).toBe('¡Hola, Luisa! Muy bien, gracias; mucho gusto. ¿En qué te puedo ayudar?');
  });

  it('identidad con otra pregunta, ciudad del visitante, nombre con la consulta y el saludo del modelo', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    const [id] = await talk(a, '¿eres un bot? ¿cuál es el teléfono?');
    expect(id.message).toMatch(/^Soy el asistente virtual de Cobranzas Demo\..*604 607 4101/);
    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [svc] = await talk(b, 'Soy de Medellín, ¿qué servicios tienen?');
    expect(svc.message).toMatch(/^Nuestros servicios: Recuperación de cartera/);
    const c = await publicClient(env, 'coherencia', ORIGIN);
    await talk(c, 'Juan Pérez quiero saber mi saldo, cc 1020304050');
    expect((await conv(c)).conversation).toMatchObject({ visitor_name: 'Juan Pérez', document: '1020304050', subject: 'quiero saber mi saldo' });
    say('hola, que hacen?', { intent: 'answer', answer: 'Hola, gestionamos la recuperación de cartera, la asesoría legal y el call center.', sectionSlug: 'servicios' });
    const d = await publicClient(env, 'coherencia', ORIGIN);
    const [g] = await talk(d, 'hola, que hacen?');
    expect(g.message).toMatch(/^¡Hola! Gestionamos la recuperación de cartera, la asesoría legal y el call center\./);
  });

  it('un nombre suelto raro guardado se reemplaza con uno completo; "de parte de Pedro Pérez" es el nombre', async () => {
    const a = await publicClient(env, 'coherencia', ORIGIN);
    await talk(a, '¿qué servicios ofrecen?', 'Xyzzo');
    expect((await conv(a)).conversation.visitor_name).toBe('Xyzzo');
    const [, done] = await talk(a, 'quiero hablar con un asesor', 'Juan Pérez 1020304050');
    expect(done.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect((await conv(a)).conversation.visitor_name).toBe('Juan Pérez');

    const b = await publicClient(env, 'coherencia', ORIGIN);
    const [, named] = await talk(b, 'quiero un asesor', 'de parte de Pedro Pérez');
    expect(named.message).toBe('Gracias, Pedro. Para pasarte con el asesor solo me falta tu número de documento.');
    expect((await conv(b)).conversation.subject).toBe('');
  });

  it('varias carteras: el "claro" de acuse, "claro, general", "no, es X", dos a la vez, una negada y una ajena', async () => {
    const H = await setupCompany(env, sup, { slug: 'coherencia-seis', name: 'Cobranzas Seis', origin: 'https://seis.test', advisors: 1 });
    const claro = await sup.post(`/companies/${H.companyId}/portfolios`, { key: 'claro', name: 'Claro' });
    const flamingo = await sup.post(`/companies/${H.companyId}/portfolios`, { key: 'flamingo', name: 'Flamingo' });
    const offcorss = await sup.post(`/companies/${H.companyId}/portfolios`, { key: 'offcorss', name: 'Offcorss' });
    const general = (await sup.get(`/companies/${H.companyId}/portfolios`)).body.items.find((p: any) => p.key === 'general');
    const site = 'https://seis.test';
    const client = () => publicClient(env, 'coherencia-seis', site);

    const a = await client();
    await talk(a, 'quiero un asesor', 'Juan Pérez 1020304050', 'no sé');
    const [ack] = await talk(a, 'claro, gracias');
    expect(ack.message).not.toMatch(/anoté la cartera/);
    expect((await conv(a)).conversation).toMatchObject({ status: 'EN_ESPERA_ASESOR', portfolio_id: general.id });

    const b = await client();
    const [, , gen] = await talk(b, 'quiero un asesor', 'Juan Pérez 1020304050', 'claro, general');
    expect(gen.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect((await conv(b)).conversation.portfolio_id).toBe(general.id);

    const c = await client();
    const [, fixed] = await talk(c, 'quiero un asesor de flamingo', 'no, es Offcorss');
    expect(fixed.message).toMatch(/^Listo, corregí la cartera\./);
    expect((await conv(c)).conversation.portfolio_id).toBe(offcorss.body.id);

    const d = await client();
    const [, , two] = await talk(d, 'quiero un asesor', 'Juan Pérez 1020304050', 'Offcorss y Flamingo');
    expect(two.message).toBe('¿Tu consulta es de Offcorss o de Flamingo?');
    const [chosen] = await talk(d, 'flamingo');
    expect(chosen.conversation.status).toBe('EN_ESPERA_ASESOR');
    expect((await conv(d)).conversation.portfolio_id).toBe(flamingo.body.id);

    const e = await client();
    const [, , neg] = await talk(e, 'quiero un asesor', 'Juan Pérez 1020304050', 'no es flamingo');
    expect(neg.message).toMatch(/^Entendido, no es Flamingo\. ¿Es de (General, Claro u Offcorss|Claro, Offcorss o General|General, Claro, Offcorss)/);

    const f = await client();
    const [, foreign] = await talk(f, 'quiero un asesor', 'es de dupree');
    expect(foreign.message).toMatch(/^No encuentro esa cartera entre las nuestras .*el asesor la confirma contigo\. Para pasarte con él, compárteme tu nombre y tu número de documento\.$/);
    const [done] = await talk(f, 'Juan Pérez 1020304050');
    expect(done.conversation.status).toBe('EN_ESPERA_ASESOR');

    const g = await client();
    const [advisors] = await talk(g, 'Quiero hablar con los asesores de Flamingo');
    expect(advisors.message).toMatch(/Ya anoté la cartera Flamingo\./);
    expect((await conv(g)).conversation.portfolio_id).toBe(flamingo.body.id);
    void claro;
  });
});
