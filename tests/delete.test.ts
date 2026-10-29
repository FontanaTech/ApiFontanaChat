import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, createEnv, fakePhone, login, makeAdmin, publicClient, setupCompany, type Fixture, type TestEnv } from './helpers';

let env: TestEnv;
let sup: ReturnType<typeof adminApi>;
let X: Fixture;
const ORIGIN = 'https://borrar-x.test';

beforeAll(async () => {
  env = await createEnv();
  await makeAdmin(env, { email: 'root@test.local', role: 'superadmin' });
  sup = adminApi(env, await login(env, 'root@test.local'));
  X = await setupCompany(env, sup, { slug: 'co-del', name: 'Empresa Del', origin: ORIGIN, advisors: 1 });
});
afterAll(async () => {
  await env.db.close();
});

describe('eliminar dominios y teléfonos', () => {
  it('elimina un dominio: el sitio deja de poder crear sesiones y queda auditado', async () => {
    const extra = await sup.post(`/companies/${X.companyId}/origins`, { origin: 'https://viejo.test' });
    expect(extra.status).toBe(201);
    expect((await publicClient(env, X.slug, 'https://viejo.test')).token).toBeTruthy();
    expect((await sup.del(`/companies/${X.companyId}/origins/${extra.body.id}`)).status).toBe(204);
    const list = (await sup.get(`/companies/${X.companyId}/origins`)).body.items.map((o: any) => o.origin);
    expect(list).not.toContain('https://viejo.test');
    await expect(publicClient(env, X.slug, 'https://viejo.test')).rejects.toThrow();
    expect((await sup.del(`/companies/${X.companyId}/origins/${extra.body.id}`)).status).toBe(404);
    const a = await env.db.query(`SELECT 1 FROM audit_log WHERE entity = 'origin' AND action = 'delete'`);
    expect(a.rows.length).toBe(1);
  });

  it('elimina un teléfono sin uso y promueve otro como principal', async () => {
    const second = await sup.post(`/companies/${X.companyId}/phones`, { advisorId: X.advisorIds[0], number: fakePhone(8200001), isPrimary: false });
    expect(second.status).toBe(201);
    expect((await sup.del(`/companies/${X.companyId}/phones/${X.phoneId}`)).status).toBe(204);
    const phones = (await sup.get(`/companies/${X.companyId}/advisors`)).body.items[0].phones;
    expect(phones).toHaveLength(1);
    expect(phones[0].id).toBe(second.body.id);
    expect(phones[0].is_primary).toBe(true);
  });

  it('elimina un teléfono con derivaciones: el historial conserva el número', async () => {
    const c = await publicClient(env, X.slug, ORIGIN);
    const h = await c.post('/handoffs', { name: 'Ana' }, { 'Idempotency-Key': 'del-handoff-0001' });
    expect(h.status).toBe(201);
    const row = (await env.db.query<{ phone_id: string; phone_number: string }>('SELECT phone_id, phone_number FROM handoffs')).rows[0];
    expect((await sup.del(`/companies/${X.companyId}/phones/${row.phone_id}`)).status).toBe(204);
    const after = (await env.db.query<{ phone_id: string | null; phone_number: string }>('SELECT phone_id, phone_number FROM handoffs')).rows[0];
    expect(after.phone_id).toBeNull();
    expect(after.phone_number).toBe(row.phone_number);
    const rec = await sup.get(`/companies/${X.companyId}/handoffs`);
    expect(rec.status).toBe(200);
    expect(JSON.stringify(rec.body)).toContain(row.phone_number);
  });

  it('no elimina datos de otra empresa', async () => {
    const Y = await setupCompany(env, sup, { slug: 'co-del-y', name: 'Empresa Y', origin: 'https://borrar-y.test', advisors: 1 });
    expect((await sup.del(`/companies/${X.companyId}/phones/${Y.phoneId}`)).status).toBe(404);
    const yOrigin = (await sup.get(`/companies/${Y.companyId}/origins`)).body.items[0];
    expect((await sup.del(`/companies/${X.companyId}/origins/${yOrigin.id}`)).status).toBe(404);
  });
});
