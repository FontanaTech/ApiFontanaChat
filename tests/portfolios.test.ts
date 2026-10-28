import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, createEnv, fakePhone, login, makeAdmin, publicClient, setupCompany, type Fixture, type TestEnv } from './helpers';

let env: TestEnv;
let sup: ReturnType<typeof adminApi>;
let X: Fixture; // empresa con cartera por defecto + una cartera "finandina"
const ORIGIN = 'https://cartera-x.test';
let finandinaId: string;
let advGeneral: string; // asesor de la cartera por defecto
let advFin: string; // asesor de la cartera finandina
let numGeneral: string;
let numFin: string;

const waNumber = (url: string) => /^https:\/\/wa\.me\/(\d+)\?/.exec(url)?.[1];

beforeAll(async () => {
  env = await createEnv();
  await makeAdmin(env, { email: 'root@test.local', role: 'superadmin' });
  sup = adminApi(env, await login(env, 'root@test.local'));
  X = await setupCompany(env, sup, { slug: 'co-x', name: 'Empresa X', origin: ORIGIN, advisors: 1 });
  advGeneral = X.advisorIds[0];
  numGeneral = (await env.db.query<{ number: string }>('SELECT number FROM phones WHERE id = $1', [X.phoneId])).rows[0].number;
});
afterAll(async () => {
  await env.db.close();
});

describe('carteras: administración', () => {
  it('toda empresa nace con una cartera por defecto y los teléfonos nuevos van a ella', async () => {
    const list = (await sup.get(`/companies/${X.companyId}/portfolios`)).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: 'general', is_default: true, active: true, phone_count: 1 });
    const phone = (await sup.get(`/companies/${X.companyId}/advisors`)).body.items[0].phones[0];
    expect(phone.portfolio_id).toBe(list[0].id);
  });

  it('crea una cartera con palabras que la identifican (se guardan normalizadas) y le asigna un teléfono', async () => {
    const c = await sup.post(`/companies/${X.companyId}/portfolios`, {
      key: 'finandina', name: 'Finandina', aliases: ['Finandina', 'Banco  Finandína', 'finandina'],
    });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ is_default: false, aliases: ['finandina', 'banco finandina'] });
    finandinaId = c.body.id;
    const adv = await sup.post(`/companies/${X.companyId}/advisors`, { name: 'Asesor Finandina' });
    advFin = adv.body.id;
    numFin = fakePhone(8123456);
    const ph = await sup.post(`/companies/${X.companyId}/phones`, { advisorId: advFin, number: numFin, isPrimary: true, portfolioId: finandinaId });
    expect(ph.status).toBe(201);
    expect(ph.body.portfolio_id).toBe(finandinaId);
    const list = (await sup.get(`/companies/${X.companyId}/portfolios`)).body.items;
    expect(list.map((p: any) => [p.key, p.phone_count])).toEqual([['general', 1], ['finandina', 1]]);
    // clave repetida → conflicto
    expect((await sup.post(`/companies/${X.companyId}/portfolios`, { key: 'finandina', name: 'Otra' })).status).toBe(409);
  });

  it('la cartera por defecto no se desactiva; hacer otra por defecto deja una sola', async () => {
    const general = (await sup.get(`/companies/${X.companyId}/portfolios`)).body.items.find((p: any) => p.key === 'general');
    const r = await sup.patch(`/companies/${X.companyId}/portfolios/${general.id}`, { active: false });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/por defecto/);
    const mk = await sup.post(`/companies/${X.companyId}/portfolios`, { key: 'otra', name: 'Otra', isDefault: true });
    expect(mk.body.is_default).toBe(true);
    const defaults = (await sup.get(`/companies/${X.companyId}/portfolios`)).body.items.filter((p: any) => p.is_default);
    expect(defaults.map((p: any) => p.key)).toEqual(['otra']);
    // se devuelve la condición a "general" y la sobrante se puede desactivar
    expect((await sup.patch(`/companies/${X.companyId}/portfolios/${general.id}`, { isDefault: true })).body.is_default).toBe(true);
    const otra = mk.body.id;
    expect((await sup.patch(`/companies/${X.companyId}/portfolios/${otra}`, { active: false })).body.active).toBe(false);
  });

  it('no se puede usar la cartera de otra empresa', async () => {
    const Y = await setupCompany(env, sup, { slug: 'co-y', name: 'Empresa Y', origin: 'https://cartera-y.test', advisors: 1 });
    await makeAdmin(env, { email: 'adm-y@test.local', role: 'company_admin', companyId: Y.companyId });
    const admY = adminApi(env, await login(env, 'adm-y@test.local'));
    expect((await admY.get(`/companies/${X.companyId}/portfolios`)).status).toBe(404);
    expect((await admY.patch(`/companies/${X.companyId}/portfolios/${finandinaId}`, { name: 'robada' })).status).toBe(404);
    expect((await admY.patch(`/companies/${Y.companyId}/portfolios/${finandinaId}`, { name: 'robada' })).status).toBe(404);
    const advY = (await sup.get(`/companies/${Y.companyId}/advisors`)).body.items[0];
    expect((await admY.post(`/companies/${Y.companyId}/phones`, { advisorId: advY.id, number: fakePhone(77), portfolioId: finandinaId })).status).toBe(404);
    expect((await admY.post(`/companies/${Y.companyId}/buttons`, { key: 'cruz', label: 'X', portfolioId: finandinaId })).status).toBe(404);
    // la base también lo impide (FK compuesta)
    await expect(
      env.db.query('UPDATE phones SET portfolio_id = $1 WHERE advisor_id = $2', [finandinaId, advY.id]),
    ).rejects.toThrow();
  });
});

describe('carteras: reparto de derivaciones', () => {
  let c: Awaited<ReturnType<typeof publicClient>>;
  beforeAll(async () => {
    c = await publicClient(env, 'co-x', ORIGIN);
  });

  it('el chat pasa con la cartera que el visitante nombra; sin cartera, con la cartera por defecto', async () => {
    const fin = await c.post('/chat', { message: 'quiero hablar con un asesor sobre mi obligación con Finandina' });
    expect(fin.body.type).toBe('handoff_offer');
    expect(waNumber(fin.body.waUrl)).toBe(numFin);
    const gen = await c.post('/chat', { message: 'quiero hablar con un asesor' });
    expect(waNumber(gen.body.waUrl)).toBe(numGeneral);
    // insistir en la misma conversación no cambia de asesor ni duplica la derivación
    const again = await c.post('/chat', { message: 'necesito un asesor de finandina por favor' });
    expect(again.body.handoffId).toBe(fin.body.handoffId);
    const row = (await env.db.query<{ portfolio_id: string }>('SELECT portfolio_id FROM handoffs WHERE id = $1', [fin.body.handoffId])).rows[0];
    expect(row.portfolio_id).toBe(finandinaId);
  });

  it('un botón o la API pueden pedir la cartera de forma explícita; una cartera inexistente es un error', async () => {
    const byKey = await c.post('/handoffs', { portfolioKey: 'finandina' }, { 'Idempotency-Key': 'port-key-0001' });
    expect(byKey.status).toBe(201);
    expect(waNumber(byKey.body.waUrl)).toBe(numFin);
    expect((await c.post('/handoffs', { portfolioKey: 'no-existe' }, { 'Idempotency-Key': 'port-key-0002' })).status).toBe(400);
    const btn = await sup.post(`/companies/${X.companyId}/buttons`, { key: 'fin', label: 'Finandina', portfolioId: finandinaId });
    expect(btn.status).toBe(201);
    expect(btn.body.portfolio_id).toBe(finandinaId);
    const byButton = await c.post('/handoffs', { buttonKey: 'fin' }, { 'Idempotency-Key': 'port-key-0003' });
    expect(waNumber(byButton.body.waUrl)).toBe(numFin);
    // sin cartera ni botón → cartera por defecto
    const def = await c.post('/handoffs', {}, { 'Idempotency-Key': 'port-key-0004' });
    expect(waNumber(def.body.waUrl)).toBe(numGeneral);
  });

  it('cada cartera rota por turnos solo entre sus propios asesores', async () => {
    const adv2 = await sup.post(`/companies/${X.companyId}/advisors`, { name: 'Segundo Finandina' });
    const num2 = fakePhone(8999999);
    await sup.post(`/companies/${X.companyId}/phones`, { advisorId: adv2.body.id, number: num2, isPrimary: true, portfolioId: finandinaId });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await c.post('/handoffs', { portfolioKey: 'finandina' }, { 'Idempotency-Key': `port-rr-000${i}` });
      seen.push(waNumber(r.body.waUrl)!);
    }
    expect(new Set(seen)).toEqual(new Set([numFin, num2]));
    expect(seen[0]).toBe(seen[2]);
    expect(seen[1]).toBe(seen[3]);
    expect(seen).not.toContain(numGeneral); // nunca se sale de su cartera
    await sup.patch(`/companies/${X.companyId}/advisors/${adv2.body.id}`, { active: false });
  });

  it('cartera desactivada o sin asesores: el chat cae a la cartera por defecto; la API explícita falla', async () => {
    await sup.patch(`/companies/${X.companyId}/portfolios/${finandinaId}`, { active: false });
    const c2 = await publicClient(env, 'co-x', ORIGIN);
    const chat = await c2.post('/chat', { message: 'quiero hablar con un asesor de Finandina' });
    expect(chat.body.type).toBe('handoff_offer');
    expect(waNumber(chat.body.waUrl)).toBe(numGeneral);
    expect((await c2.post('/handoffs', { portfolioKey: 'finandina' }, { 'Idempotency-Key': 'port-off-0001' })).status).toBe(400);
    const cfg = (await c2.get('/config')).body;
    expect(cfg.portfolios.map((p: any) => p.key)).toEqual(['general']);
    await sup.patch(`/companies/${X.companyId}/portfolios/${finandinaId}`, { active: true });
  });

  it('la configuración pública lista las carteras con asesores (solo nombres, sin teléfonos)', async () => {
    const cfg = (await c.get('/config')).body;
    expect(cfg.portfolios.map((p: any) => p.key).sort()).toEqual(['finandina', 'general']);
    expect(JSON.stringify(cfg)).not.toMatch(/\d{8,}/);
  });

  it('los registros y las métricas muestran la cartera de cada derivación', async () => {
    const hs = (await sup.get(`/companies/${X.companyId}/handoffs`)).body.items;
    expect(hs.map((h: any) => h.portfolio_name)).toContain('Finandina');
    expect(hs.map((h: any) => h.portfolio_name)).toContain('General');
    const m = (await sup.get(`/companies/${X.companyId}/metrics`)).body;
    expect(m.byPortfolio.map((p: any) => p.portfolio)).toEqual(expect.arrayContaining(['Finandina', 'General']));
    expect(m.byPortfolio.find((p: any) => p.portfolio === 'Finandina').handoffs).toBeGreaterThan(1);
  });
});

describe('datos de contacto en el chat', () => {
  const content = {
    slug: 'co-z',
    sections: [
      { slug: 'presentacion', title: 'Quiénes somos', route: '/', text: 'Gestión de cartera y asesoría legal.\nSede principal: Carrera 46 # 50-63, Piso 11, Medellín.' },
      { slug: 'protecion-datos', title: 'Protección de datos', route: '/datos', text: 'Razón social S.A.S., NIT 901476289-2.\nPara reclamos escribe a la línea PQR.' },
      {
        slug: 'contacto', title: 'Hablemos', route: '/contacto',
        text: 'Elige la sede o la línea que necesites.\nMedellín (Línea de atención general): Carrera 46 # 50-63, Edificio Playa, piso 11, Medellín. Línea 604 607 4101.\nBogotá (Línea de atención): Carrera 7 # 33-42, Edificio Corfi, Bogotá D. C.. Línea 604 607 4101.\nCorreo de contacto: gerencia@aagora.test',
      },
    ],
  };
  let c: Awaited<ReturnType<typeof publicClient>>;
  beforeAll(async () => {
    const Z = await setupCompany(env, sup, { slug: 'co-z', name: 'Empresa Z', origin: 'https://cartera-z.test', advisors: 1 });
    await sup.patch(`/companies/${Z.companyId}`, { contentUrl: 'https://cartera-z.test/chatbot-content.json' });
    env.fetcher.impl = async () => JSON.stringify(content);
    expect((await sup.post(`/companies/${Z.companyId}/content/sync`)).status).toBe(200);
    c = await publicClient(env, 'co-z', 'https://cartera-z.test');
  });
  const ask = async (message: string) => {
    const before = env.llm.calls.length;
    const r = await c.post('/chat', { message });
    expect(env.llm.calls.length, `sin modelo: ${message}`).toBe(before); // nunca depende del modelo
    return r.body;
  };

  it.each([
    '¿Cuál es el teléfono de la empresa?',
    'ME REFIERO AL NUMERO FIJO DE LA EMPRESA NO LO TIENES ?',
    'NO ME DISTE EL NUMERO ESTA EN LA PAGINA',
    'a qué número los puedo llamar',
  ])('responde el teléfono publicado: %s', async (q) => {
    const r = await ask(q);
    expect(r.type).toBe('answer');
    expect(r.message).toContain('604 607 4101');
    expect(r.message).not.toContain('901476289'); // un NIT no es un teléfono
    expect(r.waUrl).toBeUndefined();
    expect(r.link.url).toBe('https://cartera-z.test/contacto');
  });

  it('el mismo número no se repite por cada sede', async () => {
    const r = await ask('¿Cómo los contacto?');
    expect(r.message.match(/604 607 4101/g)).toHaveLength(1);
    expect(r.message).toContain('gerencia@aagora.test'); // contacto genérico: teléfono y correo
  });

  it('correo, dirección y sede concreta', async () => {
    expect((await ask('¿Cuál es el correo?')).message).toBe('Correo de contacto: gerencia@aagora.test');
    const dir = await ask('¿Cuál es la dirección de la oficina de Bogotá?');
    expect(dir.message).toContain('Carrera 7 # 33-42');
    expect(dir.message).not.toContain('Carrera 46'); // prefiere la sede que nombra
    expect((await ask('¿Dónde están ubicados?')).message).toContain('Carrera 46 # 50-63');
  });

  it('si el sitio no publica el dato (horario) no inventa: pasa a un asesor', async () => {
    const r = await c.post('/chat', { message: '¿Cuál es el horario de atención?' });
    expect(r.body.message).not.toMatch(/\d{2}:\d{2}|\d\s?(am|pm)/i);
    expect(['handoff_offer', 'fallback']).toContain(r.body.type);
  });
});
