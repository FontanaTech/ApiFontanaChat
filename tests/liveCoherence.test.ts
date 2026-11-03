import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, createEnv, login, makeAdmin, publicClient, setupCompany, type Fixture, type TestEnv } from './helpers';
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
    expect(r[5].message).toMatch(/^¡Con gusto!/);
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
    expect(queued.message).toMatch(/^Gracias, Carlos\. Ya tengo tus datos\./);
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

  it('al tomar el control el aviso no nombra otra empresa', async () => {
    const c = await publicClient(env, 'coherencia', ORIGIN);
    const [queued] = await talk(c, 'Hola, soy Marta Díaz, cédula 52000111, quiero hablar con un asesor');
    const taken = await sup.post(`/companies/${F.companyId}/chat-sessions/${queued.conversation.id}/take`, {});
    expect(taken.status).toBe(200);
    expect(taken.body.message.content).toBe('Un asesor tomó tu solicitud y continuará la atención por este medio.');
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
  });
});
