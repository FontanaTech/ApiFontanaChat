import { describe, expect, it } from 'vitest';
import { ApiError, FontanaChatClient, buildChatbotContent } from '../src';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const client = new FontanaChatClient({ baseUrl: 'https://api.test/', slug: 'aagora-bpo', fetch: f, storage, pagePath: () => '/' });
  return { client, calls, store };
}
const future = () => new Date(Date.now() + 3600_000).toISOString();

describe('FontanaChatClient', () => {
  it('crea una sesión por pestaña, la reutiliza y manda Bearer', async () => {
    const { client, calls, store } = setup((url) =>
      url.endsWith('/sessions') ? json(201, { token: 'tok1', expiresAt: future() }) : json(200, { company: { slug: 'aagora-bpo', name: 'A' }, available: true, buttons: [] }),
    );
    await client.getConfig();
    await client.getConfig();
    expect(calls.filter((c) => c.url.endsWith('/sessions'))).toHaveLength(1);
    expect((calls.at(-1)!.init.headers as any).authorization).toBe('Bearer tok1');
    expect(calls[0].url).toBe('https://api.test/api/v1/public/aagora-bpo/sessions');
    expect(store.get('fontanachat:session:aagora-bpo')).toContain('tok1');
  });

  it('si el token expira (401) crea una sesión nueva y reintenta una vez', async () => {
    let n = 0;
    const { client, calls } = setup((url) => {
      if (url.endsWith('/sessions')) return json(201, { token: `tok${++n}`, expiresAt: future() });
      const auth = (calls.at(-1)!.init.headers as any).authorization;
      return auth === 'Bearer tok1' ? json(401, { error: { message: 'expirada' } }) : json(200, { type: 'answer', message: 'hola' });
    });
    const r = await client.chat('hola');
    expect(r.message).toBe('hola');
    expect(calls.filter((c) => c.url.endsWith('/sessions'))).toHaveLength(2);
  });

  it('la clave de idempotencia se conserva entre reintentos y se renueva tras el éxito', async () => {
    let fail = true;
    const { client, calls } = setup((url) => {
      if (url.endsWith('/sessions')) return json(201, { token: 't', expiresAt: future() });
      if (fail) return json(503, { error: { message: 'caída' } });
      return json(201, { handoffId: 'h1', replayed: false, advisorName: 'X', waUrl: 'https://wa.me/1?text=a', summary: { name: 'Ana', reason: 'motivo' } });
    });
    const input = { buttonKey: 'asesor', name: 'Ana', reason: 'motivo' };
    await expect(client.createHandoff(input)).rejects.toMatchObject({ retryable: true, status: 503 });
    fail = false;
    const ok = await client.createHandoff(input);
    const keys = calls.filter((c) => c.url.endsWith('/handoffs')).map((c) => (c.init.headers as any)['idempotency-key']);
    expect(keys[0]).toBe(keys[1]);
    expect(ok.waUrl).toBe('https://wa.me/1?text=a');
    await client.createHandoff(input);
    const keys2 = calls.filter((c) => c.url.endsWith('/handoffs')).map((c) => (c.init.headers as any)['idempotency-key']);
    expect(keys2[2]).not.toBe(keys[1]);
  });

  it('errores de red y timeout son retryable y no inventan datos', async () => {
    const { client } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const e = await client.chat('hola').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe('network');
    expect(e.retryable).toBe(true);

    const slow = new FontanaChatClient({
      baseUrl: 'https://api.test', slug: 's', timeoutMs: 20, storage: null,
      fetch: ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))) as any,
    });
    const t = await slow.chat('x').catch((x) => x);
    expect(t.kind).toBe('timeout');
  });

  it('409 no_advisor_available no es reintentable', async () => {
    const { client } = setup((url) =>
      url.endsWith('/sessions') ? json(201, { token: 't', expiresAt: future() }) : json(409, { error: { code: 'no_advisor_available', message: 'sin asesor' } }),
    );
    const e = await client.createHandoff({ name: 'Ana', reason: 'motivo' }).catch((x) => x);
    expect(e.noAdvisor).toBe(true);
    expect(e.retryable).toBe(false);
  });

  it('el handoff sin botón no envía buttonKey ni areaKey', async () => {
    const { client, calls } = setup((url) =>
      url.endsWith('/sessions')
        ? json(201, { token: 't', expiresAt: future() })
        : json(201, { handoffId: 'h1', replayed: false, advisorName: 'X', waUrl: 'https://wa.me/1?text=a', summary: { name: 'Ana', reason: 'motivo' } }),
    );
    await client.createHandoff({ name: 'Ana', reason: 'motivo' });
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/handoffs'))!.init.body));
    expect(body).toEqual({ name: 'Ana', reason: 'motivo' });
  });

  it('track nunca lanza', async () => {
    const { client } = setup(() => json(500, {}));
    await expect(client.track('page_view')).resolves.toBeUndefined();
  });
});

describe('buildChatbotContent', () => {
  it('genera secciones con slug, título, ruta y texto limpio; descarta vacías', () => {
    const c = buildChatbotContent('aagora-bpo', [
      { slug: 'inicio', title: 'Inicio', route: '/', texts: ['Hola  <b>mundo</b>', false, null, 'Segundo'] },
      { slug: 'vacia', title: 'Vacía', route: '/v', texts: [] },
      { slug: 'x', title: 'X', route: 'x', texts: ['t'] },
    ]);
    expect(c.sections.map((s) => s.slug)).toEqual(['inicio', 'x']);
    expect(c.sections[0].text).toBe('Hola mundo\nSegundo');
    expect(c.sections[1].route).toBe('/x');
    expect(() => buildChatbotContent('s', [])).toThrow();
  });
});
