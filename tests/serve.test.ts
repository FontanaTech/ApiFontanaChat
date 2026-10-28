import { existsSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createEnv } from './helpers';

const built = existsSync(path.resolve(__dirname, '..', 'admin', 'dist', 'index.html'));

describe.skipIf(!built)('panel en /admin (requiere npm run build)', async () => {
  const env = await createEnv({ serveAdmin: true });
  afterAll(() => env.db.close());

  it('sirve el panel y el fallback de SPA', async () => {
    const r = await request(env.app).get('/admin');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<div id="root">');
    const deep = await request(env.app).get('/admin/companies/123');
    expect(deep.status).toBe(200);
    expect(deep.headers['cache-control']).toBe('no-cache');
  });
  it('no filtra la API ni rutas desconocidas como HTML', async () => {
    const r = await request(env.app).get('/api/v1/nada');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });
  it('envía cabeceras de seguridad', async () => {
    const r = await request(env.app).get('/admin');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBeTruthy();
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});
