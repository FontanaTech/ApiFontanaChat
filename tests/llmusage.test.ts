import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUsage } from '../src/models/usage';
import { adminApi, createEnv, login, makeAdmin, setupCompany, type Fixture, type TestEnv } from './helpers';

let env: TestEnv;
let sup: ReturnType<typeof adminApi>;
let A: Fixture;
let B: Fixture;
let day: string;

beforeAll(async () => {
  env = await createEnv({ llmDailyTokenLimit: 180000 });
  await makeAdmin(env, { email: 'root@test.local', role: 'superadmin' });
  sup = adminApi(env, await login(env, 'root@test.local'));
  A = await setupCompany(env, sup, { slug: 'co-usage-a', name: 'Uso A', origin: 'https://uso-a.test', advisors: 1 });
  B = await setupCompany(env, sup, { slug: 'co-usage-b', name: 'Uso B', origin: 'https://uso-b.test', advisors: 1 });
  day = new Date().toISOString().slice(0, 10);
});
afterAll(async () => {
  await env.db.close();
});

describe('uso general del modelo de IA', () => {
  it('suma el consumo de todas las empresas frente al límite general y detalla cada una', async () => {
    await sup.patch(`/companies/${A.companyId}`, { llmDailyTokens: 50000 });
    await addUsage(env.db, A.companyId, day, 40000);
    await addUsage(env.db, A.companyId, day, 5000);
    await addUsage(env.db, B.companyId, day, 20000);

    const r = await sup.get('/llm-usage');
    expect(r.status).toBe(200);
    expect(r.body.global).toEqual({ tokens: 65000, requests: 3, limit: 180000 });
    const byName = Object.fromEntries(r.body.companies.map((c: any) => [c.name, c]));
    expect(byName['Uso A']).toMatchObject({ tokens: 45000, requests: 2, limit: 50000 });
    expect(byName['Uso B']).toMatchObject({ tokens: 20000, requests: 1, limit: null });
    expect(r.body.days[0]).toMatchObject({ day, tokens: 65000, requests: 3 });
  });

  it('indica cuándo se reinicia el conteo: la medianoche UTC siguiente', async () => {
    const r = (await sup.get('/llm-usage')).body;
    const next = new Date(Date.parse(`${r.day}T00:00:00Z`) + 86_400_000).toISOString();
    expect(r.resetsAt).toBe(next);
    expect(new Date(r.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('solo el superadmin ve el uso general; un administrador de empresa no recibe el total de las demás', async () => {
    await makeAdmin(env, { email: 'a@test.local', role: 'company_admin', companyId: A.companyId });
    const a = adminApi(env, await login(env, 'a@test.local'));
    expect((await a.get('/llm-usage')).status).toBe(403);
    const own = (await a.get(`/companies/${A.companyId}/llm-usage`)).body;
    expect(own.today.tokens).toBe(45000);
    expect(own.globalToday).toBeNull(); // dato de las demás empresas
    expect(own.globalLimit).toBe(180000);
    expect(own.resetsAt).toMatch(/T00:00:00\.000Z$/);
    // el superadmin sí recibe el total general en la tarjeta de la empresa
    expect((await sup.get(`/companies/${A.companyId}/llm-usage`)).body.globalToday).toBe(65000);
  });
});

describe('tope general por defecto', () => {
  const base = { NODE_ENV: 'test', SESSION_SECRET: 'test-secret-test-secret-test-secret-123' };
  it('con un proveedor alojado el tope es 180000 aunque no se defina; 0 lo desactiva; con Ollama no hay tope', async () => {
    const { loadConfig } = await import('../src/config/env');
    expect(loadConfig({ ...base, LLM_PROVIDER: 'openai' } as any).llmDailyTokenLimit).toBe(180000);
    expect(loadConfig({ ...base, LLM_PROVIDER: 'openai', LLM_DAILY_TOKEN_LIMIT: '90000' } as any).llmDailyTokenLimit).toBe(90000);
    expect(loadConfig({ ...base, LLM_PROVIDER: 'openai', LLM_DAILY_TOKEN_LIMIT: '0' } as any).llmDailyTokenLimit).toBe(0);
    expect(loadConfig({ ...base, LLM_PROVIDER: 'ollama' } as any).llmDailyTokenLimit).toBe(0);
  });
});
