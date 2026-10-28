import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate';
import { buildKnowledge, extractiveAnswer, isGrounded } from '../src/services/chat';
import { ContentError, createContentFetcher, validateContentUrl } from '../src/services/contentSync';
import { isPrivateIp } from '../src/utils/ssrf';
import { createTestDb } from './helpers';
import { loadConfig } from '../src/config/env';

describe('isPrivateIp', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.5', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '100.64.0.1'])(
    '%s es privada',
    (ip) => expect(isPrivateIp(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'])('%s es pública', (ip) => expect(isPrivateIp(ip)).toBe(false));
});

describe('validateContentUrl', () => {
  const allowed = ['https://sitio.test', 'http://localhost:5173'];
  it('acepta https del origen permitido', () => {
    expect(validateContentUrl('https://sitio.test/chatbot-content.json', allowed, false).pathname).toBe('/chatbot-content.json');
  });
  it('localhost solo en modo desarrollo', () => {
    expect(() => validateContentUrl('http://localhost:5173/chatbot-content.json', allowed, false)).toThrow(ContentError);
    expect(validateContentUrl('http://localhost:5173/chatbot-content.json', allowed, true).hostname).toBe('localhost');
  });
  it('en desarrollo sigue exigiendo origen permitido', () => {
    expect(() => validateContentUrl('http://localhost:9999/x.json', allowed, true)).toThrow(/orígenes permitidos/);
  });
  it('no permite http para hosts públicos aunque sea desarrollo', () => {
    expect(() => validateContentUrl('http://sitio.test/x.json', ['http://sitio.test'], true)).toThrow(/https/);
  });
  it('ALLOW_LOCAL_CONTENT_URLS se ignora en producción', () => {
    const cfg = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), ALLOW_LOCAL_CONTENT_URLS: 'true' } as any);
    expect(cfg.allowLocalContentUrls).toBe(false);
  });
});

describe('createContentFetcher (servidor local real, modo desarrollo)', () => {
  const cfg = { contentMaxBytes: 2000, contentFetchTimeoutMs: 1500, allowLocalContentUrls: true };
  const start = () =>
    new Promise<{ url: string; close: () => void }>((resolve) => {
      const srv = createServer((req, res) => {
        if (req.url === '/ok') {
          res.setHeader('content-type', 'application/json');
          res.end('{"sections":[]}');
        } else if (req.url === '/redirect') {
          res.statusCode = 302;
          res.setHeader('location', 'http://example.com/');
          res.end();
        } else if (req.url === '/big') {
          res.setHeader('content-type', 'application/json');
          res.write('{"x":"');
          res.end('a'.repeat(5000) + '"}');
        } else if (req.url === '/html') {
          res.setHeader('content-type', 'text/html');
          res.end('<html></html>');
        } else {
          res.statusCode = 404;
          res.end();
        }
      }).listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => srv.close() }));
    });

  it('descarga JSON, bloquea redirecciones, excesos de tamaño y tipos no JSON', async () => {
    const s = await start();
    try {
      const f = createContentFetcher(cfg);
      expect(await f(`${s.url}/ok`)).toBe('{"sections":[]}');
      await expect(f(`${s.url}/redirect`)).rejects.toThrow(/redirecciones/i);
      await expect(f(`${s.url}/big`)).rejects.toThrow(/tamaño/);
      await expect(f(`${s.url}/html`)).rejects.toThrow(/JSON/);
      await expect(f(`${s.url}/missing`)).rejects.toThrow(/HTTP 404/);
    } finally {
      s.close();
    }
  });
  it('sin modo desarrollo no conecta a loopback (anti-SSRF a nivel de DNS/IP)', async () => {
    const s = await start();
    try {
      const f = createContentFetcher({ ...cfg, allowLocalContentUrls: false });
      await expect(f(`${s.url}/ok`)).rejects.toThrow();
    } finally {
      s.close();
    }
  });
});

describe('atajo de respuesta sin modelo', () => {
  const k = buildKnowledge({
    slug: 'x',
    sections: [
      { slug: 'servicios', title: 'Servicios', route: '/servicios', text: 'Recuperación de cartera, asesoría legal y call center.' },
      { slug: 'contacto', title: 'Contacto', route: '/contacto', text: 'Medellín: Carrera 46 # 50-63, piso 11. Atención de lunes a viernes de 8 a 5. Línea 604 000 0000.' },
      { slug: 'datos', title: 'Protección de datos', route: '/datos', text: 'Tratamos tus datos personales conforme a la ley.' },
    ],
  });
  const ask = (q: string, min = 2, cov = 0.66) => extractiveAnswer(k, q, min, cov)?.section.slug ?? null;

  it('entiende sinónimos: ubicación, horario, contacto y servicios', () => {
    expect(ask('¿Dónde están ubicados?')).toBe('contacto');
    expect(ask('¿En qué horario atienden?')).toBe('contacto');
    expect(ask('¿Cómo los llamo?')).toBe('contacto');
    expect(ask('¿Qué hacen ustedes?')).toBe('servicios');
  });
  it('cita las frases relacionadas, no toda la sección', () => {
    expect(extractiveAnswer(k, '¿Dónde están ubicados?', 2, 0.66)!.text).toContain('Carrera 46');
  });
  it('no responde lo que la página no dice', () => {
    expect(ask('¿Cuánto cuesta el servicio premium?')).toBeNull();
    expect(ask('jugadores famosos de ajedrez')).toBeNull();
  });
});

describe('respuestas del modelo respaldadas por la página', () => {
  const k = buildKnowledge({
    slug: 'x',
    sections: [
      { slug: 'presentacion', title: 'Presentación', route: '/', text: 'AAgora BPO integra recuperación de cartera, servicios jurídicos y atención multicanal. Sede principal: Carrera 46, Medellín.' },
      { slug: 'contacto', title: 'Contacto', route: '/contacto', text: 'Línea 604 607 4101. Correo de contacto: gerencia@agoraae.com' },
    ],
  });
  it('acepta paráfrasis fieles a la página', () => {
    expect(isGrounded('AAgora BPO tiene su sede principal en Carrera 46, Medellín. Ofrece recuperación de cartera y atención multicanal.', k)).toBe(true);
    expect(isGrounded('Puedes llamar a la línea 604 607 4101.', k)).toBe(true);
  });
  it('rechaza afirmaciones que la página no hace', () => {
    expect(isGrounded('AAgora BPO no proporciona cobro por WhatsApp. Para cualquier consulta puedes escribir por correo.', k)).toBe(false);
    expect(isGrounded('Contamos con más de veinte años de trayectoria y certificaciones internacionales de calidad.', k)).toBe(false);
  });
});

describe('migraciones y DBML', () => {
  it('son idempotentes y verifican checksum', async () => {
    const db = await createTestDb();
    const again = await runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBeGreaterThanOrEqual(7);
    await db.query("UPDATE schema_migrations SET checksum = 'x' WHERE name = '001_core.sql'");
    await expect(runMigrations(db)).rejects.toThrow(/modificada/);
    await db.close();
  });
  it('todas las tablas de las migraciones están en docs/database.dbml', () => {
    const dir = path.resolve(__dirname, '..', 'migrations');
    const sql = readdirSync(dir).sort().map((f) => readFileSync(path.join(dir, f), 'utf8'));
    const created = sql.flatMap((t) => [...t.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]));
    const dropped = new Set(sql.flatMap((t) => [...t.matchAll(/DROP TABLE (\w+)/g)].map((m) => m[1])));
    const tables = created.filter((t) => !dropped.has(t)).sort();
    const dbml = readFileSync(path.resolve(__dirname, '..', 'docs', 'database.dbml'), 'utf8');
    const documented = [...dbml.matchAll(/^Table (\w+)/gm)].map((m) => m[1]).sort();
    expect(documented).toEqual(tables);
  });
});

describe('seed:aagora', () => {
  it('crea aagora-bpo sin asesores ni teléfonos y es idempotente', async () => {
    const { seedAagora } = await import('../src/scripts/seedAagora');
    const db = await createTestDb();
    const a = await seedAagora(db, { origins: ['https://aagora.example', 'http://localhost:5173'] });
    expect(a.created).toBe(true);
    expect(a.company.slug).toBe('aagora-bpo');
    const b = await seedAagora(db, { origins: ['https://aagora.example'] });
    expect(b.created).toBe(false);
    const n = async (t: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    expect(await n('companies')).toBe(1);
    expect(await n('allowed_origins')).toBe(2);
    expect(await n('buttons')).toBe(1);
    expect(await n('portfolios')).toBe(1);
    expect(await n('advisors')).toBe(0);
    expect(await n('phones')).toBe(0);
    await db.close();
  });
});
