import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, createEnv, login, makeAdmin, publicClient, setupCompany, type Fixture, type TestEnv } from './helpers';

let env: TestEnv;
let sup: ReturnType<typeof adminApi>;
let F: Fixture;

const content = JSON.stringify({
  slug: 'co-wa',
  sections: [{ slug: 'servicios', title: 'Nuestros servicios', route: '/servicios', text: 'Ofrecemos gestión de cartera y atención telefónica.' }],
});
/** Texto de WhatsApp que recibiría el asesor (el enlace lo trae codificado). */
const waText = (url: string) => decodeURIComponent(new URL(url).searchParams.get('text') ?? '');
const isWriter = (m: { role: string; content: string }[]) => m[0].content.includes('primer mensaje de WhatsApp');

/** Modelo simulado: responde `handoff` al chat y, al redactor, el mensaje indicado. */
const model = (compose: () => string | Promise<string>) => {
  env.llm.impl = async (m) => (isWriter(m) ? compose() : JSON.stringify({ intent: 'handoff', answer: '' }));
};

beforeAll(async () => {
  env = await createEnv();
  await makeAdmin(env, { email: 'root@test.local', role: 'superadmin' });
  sup = adminApi(env, await login(env, 'root@test.local'));
  F = await setupCompany(env, sup, { slug: 'co-wa', name: 'Empresa WA', origin: 'https://site-wa.test', advisors: 1 });
  await sup.patch(`/companies/${F.companyId}`, { contentUrl: 'https://site-wa.test/chatbot-content.json' });
  env.fetcher.impl = async () => content;
  expect((await sup.post(`/companies/${F.companyId}/content/sync`)).status).toBe(200);
});
afterAll(async () => {
  await env.db.close();
});

describe('mensaje de WhatsApp personalizado', () => {
  it('el modelo redacta el mensaje según la consulta y se guarda como motivo', async () => {
    model(() => JSON.stringify({ mensaje: 'Quisiera saber cuánto cuesta el servicio premium y cómo contratarlo.' }));
    const c = await publicClient(env, 'co-wa', F.origin);
    const r = await c.post('/chat', { message: '¿Cuánto cuesta el servicio premium?' });
    expect(r.body.type).toBe('handoff_offer');
    const t = waText(r.body.waUrl);
    expect(t).toMatch(/^Hola Empresa WA\. Quisiera saber cuánto cuesta el servicio premium y cómo contratarlo\. \(Ref\. \w+\)$/);
    const h = (await env.db.query<{ reason: string }>('SELECT reason FROM handoffs WHERE id = $1', [r.body.handoffId])).rows[0];
    expect(h.reason).toContain('servicio premium');
  });

  it('insistir no vuelve a llamar al modelo ni cambia el mensaje', async () => {
    model(() => JSON.stringify({ mensaje: 'Quiero información sobre la gestión de cartera para mi empresa.' }));
    const c = await publicClient(env, 'co-wa', F.origin);
    const first = await c.post('/chat', { message: '¿Cuánto cuesta el servicio premium?' });
    const writerCalls = () => env.llm.calls.filter(isWriter).length;
    const before = writerCalls();
    const again = await c.post('/chat', { message: 'quiero hablar con un asesor' });
    expect(writerCalls()).toBe(before);
    expect(again.body.waUrl).toBe(first.body.waUrl);
  });

  it('con "quiero un asesor" usa la consulta anterior del historial', async () => {
    model(() => JSON.stringify({ mensaje: 'Necesito ayuda con la atención telefónica que ofrecen.' }));
    const c = await publicClient(env, 'co-wa', F.origin);
    const r = await c.post('/chat', {
      message: 'quiero hablar con un asesor',
      history: [{ role: 'user', content: '¿Me ayudan con la atención telefónica?' }, { role: 'assistant', content: 'Sí, ofrecemos atención telefónica.' }],
    });
    expect(waText(r.body.waUrl)).toContain('Necesito ayuda con la atención telefónica');
    const writer = env.llm.calls.filter(isWriter).at(-1)!;
    expect(writer[1].content).toContain('Visitante: ¿Me ayudan con la atención telefónica?');
  });

  it('sin consulta (solo pide un asesor) el mensaje es el genérico y no se consulta al modelo', async () => {
    model(() => JSON.stringify({ mensaje: 'no debería usarse' }));
    const before = env.llm.calls.filter(isWriter).length;
    const c = await publicClient(env, 'co-wa', F.origin);
    const r = await c.post('/chat', { message: 'quiero hablar con un asesor' });
    expect(waText(r.body.waUrl)).toMatch(/Quiero hablar con un asesor\./);
    expect(env.llm.calls.filter(isWriter).length).toBe(before);
  });

  it('si el modelo falla, tarda o devuelve algo no confiable, cita la consulta del visitante', async () => {
    for (const bad of [() => 'esto no es json', () => JSON.stringify({ mensaje: 'Escríbeme a https://malo.test o al 3001234567' }), () => { throw new Error('caído'); }]) {
      model(bad);
      const c = await publicClient(env, 'co-wa', F.origin);
      const r = await c.post('/chat', { message: '¿Cuánto cuesta el servicio premium?' });
      expect(r.body.type).toBe('handoff_offer');
      expect(waText(r.body.waUrl)).toMatch(/Quiero consultar sobre: Cuánto cuesta el servicio premium\./);
    }
  });

  it('los temas sensibles nunca se envían al modelo para redactar el mensaje', async () => {
    model(() => JSON.stringify({ mensaje: 'no debería usarse' }));
    const before = env.llm.calls.length;
    const c = await publicClient(env, 'co-wa', F.origin);
    const r = await c.post('/chat', { message: 'Quiero un paz y salvo de mi cuenta' });
    expect(r.body.type).toBe('handoff_offer');
    expect(env.llm.calls.length).toBe(before);
    expect(waText(r.body.waUrl)).toMatch(/Quiero hablar con un asesor\./);
  });
});
