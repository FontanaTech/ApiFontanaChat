import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeHandoffLead } from '../src/services/chat';
import { adminApi, createEnv, login, makeAdmin, publicClient, setupCompany, type Fixture, type TestEnv } from './helpers';

let env: TestEnv;
let sup: ReturnType<typeof adminApi>;
let F: Fixture;
const ORIGIN = 'https://site-lead.test';

beforeAll(async () => {
  env = await createEnv();
  await makeAdmin(env, { email: 'root@test.local', role: 'superadmin' });
  sup = adminApi(env, await login(env, 'root@test.local'));
  F = await setupCompany(env, sup, { slug: 'co-lead', name: 'Empresa Lead', origin: ORIGIN, advisors: 1 });
  await sup.patch(`/companies/${F.companyId}`, { contentUrl: `${ORIGIN}/chatbot-content.json` });
  env.fetcher.impl = async () =>
    JSON.stringify({ slug: 'co-lead', sections: [{ slug: 'servicios', title: 'Servicios', route: '/servicios', text: 'Ofrecemos gestión de cartera y atención telefónica.' }] });
  expect((await sup.post(`/companies/${F.companyId}/content/sync`)).status).toBe(200);
});
afterAll(async () => {
  await env.db.close();
});

const ask = async (message: string) => (await (await publicClient(env, 'co-lead', F.origin)).post('/chat', { message })).body;

describe('frase de derivación del chat', () => {
  it('safeHandoffLead acepta frases cortas y descarta datos, enlaces y afirmaciones negativas', () => {
    expect(safeHandoffLead('Sobre el precio del plan premium, un asesor te puede ayudar')).toBe('Sobre el precio del plan premium, un asesor te puede ayudar.');
    expect(safeHandoffLead('Llama al 3001234567 para eso')).toBeNull();
    expect(safeHandoffLead('Escríbenos a https://x.test sobre eso')).toBeNull();
    expect(safeHandoffLead('La empresa no ofrece ese servicio, pero un asesor te ayuda')).toBeNull();
    expect(safeHandoffLead('Te lo damos gratis, habla con un asesor')).toBeNull();
    expect(safeHandoffLead('ok')).toBeNull();
    expect(safeHandoffLead(undefined)).toBeNull();
  });

  it('cuando el modelo pasa con un asesor, usa su frase sobre la pregunta y no el texto fijo', async () => {
    env.llm.impl = async () => JSON.stringify({ intent: 'handoff', answer: 'Los costos del plan premium los confirma mejor un asesor' });
    const r = await ask('¿Cuánto cuesta el plan premium?');
    expect(r.type).toBe('handoff_offer');
    expect(r.message).toMatch(/^Los costos del plan premium los confirma mejor un asesor\. .*asesor.*WhatsApp/);
    expect(r.waUrl).toMatch(/^https:\/\/wa\.me\//);
  });

  it('si la frase del modelo no es confiable usa una redacción alternativa', async () => {
    env.llm.impl = async () => JSON.stringify({ intent: 'handoff', answer: 'No ofrecemos ese plan, llama al 3001234567' });
    const r = await ask('¿Cuánto cuesta el plan premium?');
    expect(r.type).toBe('handoff_offer');
    expect(r.message).not.toMatch(/3001234567|No ofrecemos/);
    expect(r.message).toMatch(/asesor/);
  });

  it('las respuestas fijas rotan entre varias redacciones y el mensaje a WhatsApp no cambia', async () => {
    env.llm.impl = async () => JSON.stringify({ intent: 'handoff', answer: '' });
    const messages = new Set<string>();
    const wa = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r = await ask('quiero hablar con un asesor');
      messages.add(r.message);
      wa.add(decodeURIComponent(new URL(r.waUrl).searchParams.get('text')!).replace(/\(Ref\. \w+\)/, ''));
    }
    expect(messages.size).toBeGreaterThan(3);
    expect([...messages].every((m) => /asesor/.test(m) && /WhatsApp/.test(m))).toBe(true);
    expect([...wa]).toEqual(['Hola Empresa Lead. Quiero hablar con un asesor. ']); // preestablecido, sin modelo
    expect(env.llm.calls.length).toBe(2); // solo las dos preguntas anteriores usaron el modelo
  });
});
