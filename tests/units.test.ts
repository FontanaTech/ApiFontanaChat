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

describe('captura de datos del visitante', async () => {
  const { explicitName, extractDocument, matchPortfolio, extractVisitorData, onlyData } = await import('../src/services/visitorData');
  const { classify } = await import('../src/services/intents');
  const wallets = [{ key: 'pruebas', name: 'Cartera de pruebas' }, { key: 'general', name: 'General' }];
  it('nombre explícito dentro de una frase', () => {
    expect(explicitName('te estoy diciendo que mi nombre es Juan ESTEBAN')).toBe('Juan Esteban');
    expect(explicitName('Hola, me llamo Ana María y necesito ayuda')).toBe('Ana María');
    expect(explicitName('soy cliente de ustedes')).toBeNull();
    expect(explicitName('soy de Bogotá')).toBeNull();
  });
  it('documento con o sin separadores', () => {
    expect(extractDocument('mi cc es 1.021.803.088')).toBe('1021803088');
    expect(extractDocument('sin numeros')).toBeUndefined();
  });
  it('cartera tolera singular/plural y relleno', () => {
    expect(matchPortfolio('MI CARTERA ES CARTERA DE PRUEBA', wallets)?.key).toBe('pruebas');
    expect(matchPortfolio('general', wallets)?.key).toBe('general');
    expect(matchPortfolio('quiero información', wallets)).toBeUndefined();
  });
  it('distingue un mensaje que solo trae datos de una pregunta', () => {
    expect(onlyData(extractVisitorData('1021803088 NUMERO DE DOCUMENTO Y MI CARTERA ES CARTERA DE PRUEBA', wallets, false))).toBe(true);
    expect(onlyData(extractVisitorData('mi cédula es 1021803088, ¿cuánto debo de mi crédito hipotecario?', wallets, false))).toBe(false);
  });
  it('una sola regla de intención con prioridad fija', () => {
    expect(classify('eres una persona?')).toBe('identity');
    expect(classify('quiero hablar con un asesor')).toBe('human');
    expect(classify('mi cédula es 123456')).toBe('other');
    expect(classify('necesito un acuerdo de pago')).toBe('sensitive');
    // Preguntar POR un servicio no es un asunto personal; hablar de su propio caso sí.
    expect(classify('¿qué es la asesoría legal?')).toBe('other');
    expect(classify('¿tienen abogados?')).toBe('other');
    expect(classify('necesito un abogado')).toBe('sensitive');
    expect(classify('tengo una deuda con Flamingo')).toBe('sensitive');
    expect(classify('necesito ayuda')).toBe('help');
    expect(classify('👍')).toBe('thanks');
  });
});

describe('reglas de intención: casos reales de la revisión (nov. 2026)', async () => {
  const { classify, yesNo, isCancel, isRefuse, isHold, isWhyData } = await import('../src/services/intents');
  it.each([
    // Saludo o agradecimiento + pregunta: es la pregunta.
    ['hola, ¿cuál es el teléfono?', 'other'],
    ['gracias, y el correo?', 'other'],
    ['perfecto, y en bogota?', 'other'],
    ['una pregunta, horario?', 'other'],
    // Nombrar a un asesor no es pedirlo.
    ['no quiero hablar con un asesor, solo quiero saber donde quedan', 'other'],
    ['no necesito asesor, solo una pregunta: ¿qué es la asesoría legal?', 'other'],
    ['quiero trabajar como asesor de cobranza', 'other'],
    ['tienen vacantes de asesor de cobranza?', 'other'],
    ['los asesores atienden los sabados?', 'other'],
    ['usted es humano?', 'identity'],
    // Pedidos de persona en otras palabras.
    ['pasame con alguien', 'human'],
    ['me comunicas con alguien?', 'human'],
    ['me pueden llamar?', 'human'],
    ['necesito que alguien me ayude', 'human'],
    ['¿Eres un robot? Quiero hablar con una persona', 'human'],
    ['Quiero hablar con un asesor sobre Cobranza.', 'human'],
    // "Acuerdo" sin pago no es un asunto personal; un servicio o una empresa tampoco.
    ['de acuerdo', 'thanks'],
    ['ya no me acuerdo', 'other'],
    ['quiero saber si ustedes hacen cobro jurídico', 'other'],
    ['tengo una duda sobre la asesoría legal', 'other'],
    ['quiero contratar asesoría legal para mi empresa', 'other'],
    ['con quién hablo para hacer un acuerdo de pago', 'sensitive'],
    ['tengo una deuda de 2.500.000 de pesos con ustedes', 'sensitive'],
    ['¿Por qué me contactaron?', 'sensitive'],
    ['¿quién me escribió?', 'sensitive'],
    // Cierres, presencia y ayuda.
    ['listo muchas gracias', 'thanks'],
    ['muy amable', 'thanks'],
    ['no gracias, eso era todo', 'thanks'],
    ['hay alguien ahi?', 'greeting'],
    ['Hi', 'greeting'],
    ['?', 'help'],
    ['hablemos', 'help'],
    ['necesito información sobre empleo', 'other'],
  ])('%s → %s', (message, intent) => expect(classify(message)).toBe(intent));

  it('respuesta a "¿Quieres que te comunique con un asesor?": solo cuenta si es la respuesta', () => {
    for (const m of ['sí', 'de una', 'sip', 'bueno si', 'si, soy juan perez', 'claro que sí', 'por favor', 'porfa', 'de acuerdo', 'dale, pásame', 'listo, comuníqueme', 'comuníqueme con uno', 'sisas', 'si gracias']) expect(yesNo(m), m).toBe('yes');
    for (const m of ['no gracias', 'ahorita no', 'nooo', 'no, no necesito un asesor', 'mejor no']) expect(yesNo(m), m).toBe('no');
    for (const m of ['gracias', 'no gracias, eso era todo', 'muy amable', 'ok gracias', 'listo gracias']) expect(yesNo(m), m).toBe('closing');
    for (const m of ['ok, ¿y el teléfono?', 'dale, ¿y el teléfono?', 'no, ¿y el correo?', 'no entiendo, ¿qué es la conciliación?', 'quiero saber el horario', 'bueno, ¿qué es la conciliación?']) {
      expect(yesNo(m), m).toBeNull();
    }
  });

  it('cancelar, negarse, pedir un momento y preguntar para qué son los datos', () => {
    expect(isCancel('mejor no, ya no')).toBe(true);
    expect(isCancel('no gracias')).toBe(true);
    expect(isCancel('ya no tengo trabajo y no he podido pagar')).toBe(false);
    expect(isCancel('ya no me acuerdo del número de cédula')).toBe(false);
    // En la cola, "no gracias" responde a "¿te ayudo con algo más?": no suelta la solicitud.
    expect(isCancel('no gracias', { waiting: true })).toBe(false);
    expect(isCancel('ya no necesito el asesor, gracias', { waiting: true })).toBe(true);
    expect(isCancel('cancelar', { waiting: true })).toBe(true);
    expect(isCancel('ya me atendieron por whatsapp', { waiting: true })).toBe(true);
    expect(isRefuse('no')).toBe(true);
    expect(isRefuse('no tengo la cedula a la mano')).toBe(true);
    expect(isRefuse('ya no me acuerdo del número de cédula')).toBe(true);
    expect(isRefuse('No sé cuál es mi saldo')).toBe(false);
    expect(isHold('momentico')).toBe(true);
    expect(isHold('ya te los paso')).toBe(true);
    expect(isWhyData('¿para qué necesitan mis datos?')).toBe(true);
    expect(isWhyData('¿es obligatorio?')).toBe(true);
  });
});

describe('captura de datos: lo que NO se guarda (revisión nov. 2026)', async () => {
  const { extractDocument, extractVisitorData, explicitName, statedPortfolio } = await import('../src/services/visitorData');
  const company = new Set(['6046074101', '9014762892', '901476289']);
  it('documento: montos, teléfonos, fechas, obligaciones y números de la empresa no son cédulas', () => {
    for (const m of ['debo 850.000', 'me estan cobrando 850.000 de una deuda que ya pague', 'debo 1.500.000 a un almacen', "me cobran $1'200.000",
      'me cobran 2300000', 'tengo una deuda de 2.500.000 de pesos', '3001234567', 'llamame al 3104567890', 'ya pague mi deuda el 15-03-2024',
      'el estado de mi obligacion numero 45678912', '¿Cobran 50.000 por la gestión?']) {
      expect(extractDocument(m, company), m).toBeUndefined();
    }
    expect(extractDocument('¿El 604 607 4101 es de ustedes?', company)).toBeUndefined();
    expect(extractDocument('¿el NIT 901476289-2 es de ustedes?', company)).toBeUndefined();
  });
  it('documento: lo que sí es una cédula', () => {
    expect(extractDocument('43.123.456')).toBe('43123456');
    expect(extractDocument('1 020 304 050')).toBe('1020304050');
    expect(extractDocument('mi cédula es 3001234567')).toBe('3001234567');
    expect(extractDocument('1020304050 3001234567')).toBe('1020304050');
    expect(extractDocument('cel 3001234567 cc 1020304050')).toBe('1020304050');
    expect(extractDocument('1021803088 NUMERO DE DOCUMENTO')).toBe('1021803088');
    expect(extractDocument('pasaporte AB123456')).toBe('AB123456');
  });
  it('nombre suelto tras "¿Con quién tengo el gusto?": solo si es un nombre', () => {
    const asked = (m: string) => extractVisitorData(m, [], { asked: 'name' }).name;
    for (const m of ['telefono', 'hay vacantes', 'cuanto cuesta el servicio', 'atienden los sabados', 'en bogota tienen oficina', 'Gerente', 'Dr.',
      'jajaja', 'momentico', 'quedo atento', 'perdon', 'es obligatorio', 'no gracias', 'ok', 'Mejor No Ya No', '¿Juan?']) {
      expect(asked(m), m).toBeUndefined();
    }
    expect(asked('juan')).toBe('Juan');
    expect(asked('Con Pedro')).toBe('Pedro');
    expect(asked('Andrés, mucho gusto')).toBe('Andrés');
    expect(asked('María del Pilar Rodríguez')).toBe('María del Pilar Rodríguez');
    expect(asked('Dr. Juan Pérez')).toBe('Juan Pérez');
    expect(asked('Juan Pérez, llamame al 3104567890')).toBe('Juan Pérez');
    expect(asked('Ana Ruiz, mi celular es 3001234567')).toBe('Ana Ruiz');
    expect(asked('Buenas tardes, Juan Pérez')).toBe('Juan Pérez');
    // Pidió nombre, documento y cartera: una sola palabra que no es un nombre de pila es la entidad, no el nombre.
    expect(extractVisitorData('Bancolombia', [], { asked: 'handoff', missing: ['name', 'document', 'portfolio'] }).name).toBeUndefined();
  });
  it('nombre explícito: negaciones, correcciones y "mi nombre…" que no dice el nombre', () => {
    expect(explicitName('yo no soy Juan Pérez')).toBeNull();
    expect(explicitName('no me llamo Juan, me llamo Pedro')).toBe('Pedro');
    expect(explicitName('no, me llamo Andrés Pérez')).toBe('Andrés Pérez');
    expect(explicitName('soy cliente, me llamo Ana')).toBe('Ana');
    expect(explicitName('mi nombre completo es Ana María Ríos')).toBe('Ana María Ríos');
    expect(explicitName('Mi nombre es: Ana María Ríos, necesito un asesor')).toBe('Ana María Ríos');
    expect(explicitName('mi nombre aparece mal en la factura')).toBeNull();
    expect(explicitName('Soy Gerente de Cartera')).toBeNull();
    expect(explicitName('soy juan perez')).toBe('Juan Perez');
  });
  it('cartera: nombrar un aliado no es decir que es la propia', () => {
    const wallets = [{ key: 'general', name: 'General' }, { key: 'offcorss', name: 'Offcorss' }, { key: 'claro', name: 'Claro' }];
    expect(statedPortfolio('¿trabajan con Offcorss?', wallets, false)).toBeUndefined();
    expect(statedPortfolio('¿cuál es la línea general?', wallets, false)).toBeUndefined();
    expect(statedPortfolio('claro', wallets, false)).toBeUndefined();
    expect(statedPortfolio('mi deuda es con Offcorss', wallets, false)?.portfolio.key).toBe('offcorss');
    expect(statedPortfolio('es de offcorss', wallets, false)?.portfolio.key).toBe('offcorss');
    // Si el bot pidió solo la cartera, la respuesta sola cuenta (aunque sea una palabra común); si pidió también el
    // nombre y el documento, un "claro" suelto es un sí.
    expect(statedPortfolio('claro', wallets, true, new Set(), { onlyPortfolio: true })?.portfolio.key).toBe('claro');
    expect(statedPortfolio('claro', wallets, true)).toBeUndefined();
    expect(statedPortfolio('offcorss', wallets, true)?.portfolio.key).toBe('offcorss');
  });
});

describe('respuestas con el sitio (contenido real de AAgora)', async () => {
  const { buildKnowledge, contactAnswer, extractiveAnswer, companyNumberAnswer } = await import('../src/services/chat');
  const k = buildKnowledge({
    slug: 'aagora',
    sections: [
      { slug: 'servicios', title: 'Nuestros servicios', route: '/servicios', text: 'Recuperación de cartera, asesoría legal y call center.\nRecuperación de Cartera: Gestión de cobro de obligaciones por cuenta de clientes acreedores.' },
      { slug: 'servicio-asesoria-legal', title: 'Asesoría Legal', route: '/servicios/asesoria-legal', text: 'Acompañamiento jurídico a personas y empresas.' },
      { slug: 'area-juridica', title: 'Área jurídica y administrativa', route: '/juridica', text: 'Canales independientes para conciliación, PQR y recursos humanos.\nPQR (Línea exclusiva PQR): Canal para peticiones, quejas y reclamos. Correo pqr@demo.test. Línea 604 555 0000.' },
      { slug: 'contacto', title: 'Hablemos', route: '/contacto', text: 'Elige la sede o la línea que necesites, o habla con un asesor.\nMedellín (Línea de atención general): Carrera 46 # 50-63, Medellín. Línea 604 607 4101.\nBogotá (Línea de atención): Carrera 7 # 33-42, Bogotá D. C.. Línea 604 607 4101.\nCorreo de contacto: gerencia@demo.test' },
      { slug: 'presencia-internacional', title: 'Presencia internacional', route: '/presencia', text: 'Colombia, nuestro país principal, conectado con Perú y Ecuador.' },
      { slug: 'nosotros', title: 'Nosotros', route: '/nosotros', text: 'Quiénes somos: A. AGORA ABOGADOS S.A.S., identificada con NIT 901476289-2, tiene su sede principal en Medellín.' },
    ],
  });
  it('contacto: solo cuando pide ESE dato y el sitio lo publica', () => {
    expect(contactAnswer(k, '¿cuál es el número de NIT de la empresa?')).toBeNull();
    expect(contactAnswer(k, '¿me pueden dar el número de cuenta para consignar?')).toBeNull();
    expect(contactAnswer(k, '¿El cobro tiene un costo fijo?')).toBeNull();
    expect(contactAnswer(k, '¿dónde está el formulario de PQR?')).toBeNull();
    expect(contactAnswer(k, '¿tienen sede en Cali?')?.text).toBe('En el sitio no aparece una sede en Cali. Nuestras sedes publicadas están en Medellín y Bogotá.');
    expect(contactAnswer(k, '¿cuál es el teléfono y el horario?')).toBeNull(); // el horario no está publicado
    // WhatsApp no está publicado: se dice y se da la línea, marcado como parcial (el bot ofrece un asesor).
    const wa = contactAnswer(k, '¿cuál es el número de WhatsApp?');
    expect(wa?.text).toContain('En el sitio no aparece un número de WhatsApp.');
    expect(wa?.partial).toBe(true);
    expect(contactAnswer(k, 'la línea 604 607 4101 no contesta')).toBeNull();
    expect(contactAnswer(k, '¿cuál es la línea de PQR?')?.text).toBe('PQR (Línea exclusiva PQR): 604 555 0000');
    expect(contactAnswer(k, '¿cuál es el correo de PQR?')?.text).toBe('PQR (Línea exclusiva PQR): pqr@demo.test');
    expect(contactAnswer(k, 'ME REFIERO AL NUMERO FIJO DE LA EMPRESA')?.text).toBe('Línea de atención: 604 607 4101');
    expect(contactAnswer(k, '¿dónde quedan en Bogotá?')?.text).toContain('Carrera 7 # 33-42');
  });
  it('atajo estricto: el título es lo que se pregunta (palabras completas, no raíces)', () => {
    expect(extractiveAnswer(k, '¿Cuánto son los intereses?', 2, 0.66, { strict: true })).toBeNull();
    expect(extractiveAnswer(k, 'estoy interesado', 2, 0.66, { strict: true })).toBeNull();
    expect(extractiveAnswer(k, '¿esto es legal?', 2, 0.66, { strict: true })).toBeNull();
    expect(extractiveAnswer(k, '¿qué servicios ofrecen?', 2, 0.66, { strict: true })?.text).toBe('Nuestros servicios: Recuperación de cartera, asesoría legal y call center.');
    expect(extractiveAnswer(k, '¿qué es la asesoría legal?', 2, 0.66, { strict: true })?.text).toMatch(/^Asesoría Legal: Acompañamiento jurídico/);
    // La frase ya trae su etiqueta: no "Nosotros: Quiénes somos: …".
    expect(extractiveAnswer(k, '¿quiénes son ustedes?', 2, 0.66, { strict: true })?.text).toMatch(/^Quiénes somos: A\. AGORA ABOGADOS S\.A\.S\., identificada/);
    expect(extractiveAnswer(k, '¿en qué países tienen presencia?', 2, 0.66, { strict: true })?.section.slug).toBe('presencia-internacional');
  });
  it('un número que publica la empresa se confirma, no se toma como documento', () => {
    expect(companyNumberAnswer(k, '¿El 604 607 4101 es de ustedes?')?.text).toBe('Sí, el 604 607 4101 es la línea de atención publicada en nuestro sitio.');
    expect(companyNumberAnswer(k, '¿el NIT 901476289-2 es de ustedes?')?.text).toMatch(/^Sí, ese número aparece en nuestro sitio: .*NIT 901476289-2/);
    expect(companyNumberAnswer(k, 'mi cédula es 1020304050')).toBeNull();
  });
  it('contacto: "en línea", otros lugares y preguntas con algo más no reciben el dato suelto; una ciudad sin sede se dice', async () => {
    const { topicText } = await import('../src/services/intents');
    for (const m of ['¿tienen pagos en línea?', '¿la asesoría legal es en línea?', '¿dónde quedan las Islas Canarias?', '¿dónde se encuentran los aliados?',
      '¿la oficina de Bogotá atiende los sábados?', '¿El teléfono atiende 24 horas?', '¿Puedo ir a la oficina sin cita?', '¿Se puede pagar en la oficina?']) {
      expect(contactAnswer(k, m), m).toBeNull();
    }
    expect(contactAnswer(k, '¿atienden en Barranquilla?')?.text).toBe('En el sitio no aparece una sede en Barranquilla. Nuestras sedes publicadas están en Medellín y Bogotá.');
    const both = contactAnswer(k, '¿Tienen sede en Medellín y Cali?')?.text ?? '';
    expect(both).toContain('Carrera 46 # 50-63');
    expect(both).toMatch(/En el sitio no aparece una sede en Cali\.$/);
    expect(contactAnswer(k, '¿dónde quedan?')?.text).toContain('Carrera 7 # 33-42');
    // "No me acuerdo" no es "acuerdos de pago": el correo sale con su etiqueta de contacto.
    expect(contactAnswer(k, topicText('no me acuerdo cual es el correo de ustedes'))?.text).toBe('Correo de contacto: gerencia@demo.test');
  });
  it('una frase que remite a una línea exclusiva trae su correo y su número', () => {
    const jobs = buildKnowledge({
      slug: 'rrhh',
      sections: [
        { slug: 'area-juridica', title: 'Área jurídica y administrativa', route: '/juridica', text: 'Recursos Humanos (Línea exclusiva RRHH): Canal para procesos de selección. Correo rrhh@demo.test. Línea 604 555 1111.' },
        { slug: 'trabaja-con-nosotros', title: 'Trabaja con nosotros', route: '/nosotros', text: 'Para procesos de selección, escribe a la línea exclusiva de Recursos Humanos.' },
      ],
    });
    const r = extractiveAnswer(jobs, 'empleo', 2, 0.66, { strict: true });
    expect(r?.text).toMatch(/^Trabaja con nosotros: Para procesos de selección, escribe a la línea exclusiva de Recursos Humanos\./);
    expect(r?.text).toContain('rrhh@demo.test');
    expect(r?.text).toContain('604 555 1111');
  });
});

describe('revisión 2 (verificación nov. 2026): nombres, documentos y carteras', async () => {
  const { extractVisitorData, explicitName, extractDocument, findPhone, statedPortfolio } = await import('../src/services/visitorData');
  const asked = (m: string) => extractVisitorData(m, [], { asked: 'name' }).name;
  const handoff = (m: string, missing: Array<'name' | 'document' | 'portfolio'> = ['name', 'document']) => extractVisitorData(m, [], { asked: 'handoff', missing });
  it('tras "¿Con quién tengo el gusto?": términos, marcas, plurales y negativas no son un nombre', () => {
    for (const m of ['precios', 'tarifas', 'requisitos', 'costos', 'nequi', 'datacredito', 'flamingo', 'paz y salvo', 'dios le pague', 'reporte en datacredito',
      'Bancolombia', 'prestamo', 'libranza', 'abono', 'soat', 'Movistar', 'Tigo', 'Davivienda', 'normal', 'sucursales', 'descuentos', 'convenios', 'honorarios',
      'prefiero no decirlo', 'prefiero no', 'prefiero reservarlo', 'anonimo', 'confidencial', 'secreto', 'preferiría no']) {
      expect(asked(m), m).toBeUndefined();
    }
    for (const [m, name] of [['Soledad', 'Soledad'], ['Oneida', 'Oneida'], ['Clemente', 'Clemente'], ['Leo', 'Leo'], ['Pedro Nel Ospina', 'Pedro Nel Ospina'],
      ['Dr. Carlos Mejía', 'Carlos Mejía'], ['Sra. Martha Gómez', 'Martha Gómez'], ['Ing. Carlos Ruiz', 'Carlos Ruiz'], ['Dra. Ana Ruiz', 'Ana Ruiz'], ['yurley', 'Yurley']]) {
      expect(asked(m), m).toBe(name);
    }
  });
  it('al pedir nombre y documento: nombres poco comunes, en minúscula, con apellido que es una palabra o con tratamiento', () => {
    expect(handoff('wilmar gomez').name).toBe('Wilmar Gomez');
    expect(handoff('Yurley').name).toBe('Yurley');
    expect(handoff('wilmar').name).toBe('Wilmar');
    expect(handoff('duberney castaño').name).toBe('Duberney Castaño');
    expect(handoff('yhorman gomez 1020304050')).toMatchObject({ name: 'Yhorman Gomez', document: '1020304050' });
    expect(handoff('Carlos Mora 1020304050').name).toBe('Carlos Mora');
    expect(handoff('Martha Cuesta 43123456')).toMatchObject({ name: 'Martha Cuesta', document: '43123456' });
    expect(handoff('Juan Plata 71234567')).toMatchObject({ name: 'Juan Plata', document: '71234567' });
    expect(handoff('Domingo Pérez 70111222')).toMatchObject({ name: 'Domingo Pérez', document: '70111222' });
    expect(handoff('Luz Mery Bello').name).toBe('Luz Mery Bello');
    expect(handoff('José Luis Mora 1020304050').name).toBe('José Luis Mora');
    expect(handoff('Diana Cuesta, cc 43567890')).toMatchObject({ name: 'Diana Cuesta', document: '43567890' });
    expect(handoff('Dr. Jaime Ruiz 79123456')).toMatchObject({ name: 'Jaime Ruiz', document: '79123456' });
    expect(handoff('Ana Ruiz 43.120.000')).toMatchObject({ name: 'Ana Ruiz', document: '43120000' });
    const ti = handoff('tarjeta de identidad 1001234567');
    expect(ti).toMatchObject({ document: '1001234567' });
    expect(ti.name).toBeUndefined();
    expect(ti.rest).toBe('');
    for (const m of ['jajaja', 'busco la cedula', 'Bancolombia', 'si', 'ahorita', 'por nequi']) expect(handoff(m).name, m).toBeUndefined();
    // Si también pidió la cartera, una palabra suelta desconocida es la entidad.
    expect(handoff('Finandina', ['name', 'document', 'portfolio']).name).toBeUndefined();
  });
  it('nombre explícito: la empresa, la cédula o el cargo no son parte del nombre', () => {
    expect(explicitName('Buenas tardes, soy Laura de Bancolombia, queremos cotizar')).toBe('Laura');
    expect(explicitName('me llamo Pedro de Offcorss, cc 1020304050')).toBe('Pedro');
    expect(explicitName('me llamo andrea de aagora para cobrarme una deuda')).toBe('Andrea');
    expect(explicitName('mi nombre es Carlos Ruiz identificado con cedula 1.036.456.789')).toBe('Carlos Ruiz');
    expect(explicitName('mi nombre es Ana Ruiz identificada con cc 43567890')).toBe('Ana Ruiz');
    expect(explicitName('me llamo Leo')).toBe('Leo');
    expect(explicitName('soy Leo Martínez')).toBe('Leo Martínez');
    expect(explicitName('soy yuliza ortiz')).toBe('Yuliza Ortiz');
    expect(explicitName('le habla la doctora Ana Ruiz')).toBe('Ana Ruiz');
    expect(explicitName('soy la señora Gloria Pérez, cédula 43567890')).toBe('Gloria Pérez');
    expect(explicitName('habla con el señor Pedro Gómez')).toBe('Pedro Gómez');
    expect(explicitName('María del Carmen Ruiz')).toBeNull();
    for (const m of ['Soy Asistente Administrativa de una empresa y queremos contratar', 'Soy Director Comercial', 'Soy Analista Financiera', 'soy asesor de cobranza']) {
      expect(explicitName(m), m).toBeNull();
    }
  });
  it('correcciones: el dato corregido reemplaza al anterior', () => {
    expect(handoff('no es 1020304050, es 1020304051', ['name'])).toMatchObject({ document: '1020304051', documentExplicit: true });
    expect(handoff('perdón, es 1020304051', ['name'])).toMatchObject({ document: '1020304051', documentExplicit: true });
    expect(handoff('me equivoqué, el correcto es 1020304051', ['name'])).toMatchObject({ document: '1020304051', documentExplicit: true });
    expect(handoff('perdón, es Juan Pablo Pérez', ['document'])).toMatchObject({ name: 'Juan Pablo Pérez', nameExplicit: true });
  });
  it('documento: letras pegadas al pasaporte, cédula junto a "saldo" o "cuánto debo"', () => {
    expect(extractDocument('mi pasaporte es 123456789')).toBe('123456789');
    expect(extractDocument('mi PPT es 1234567')).toBe('1234567');
    expect(extractDocument('pasaporte No 123456')).toBe('123456');
    expect(extractDocument('pasaporte de 1234567')).toBe('1234567');
    expect(extractDocument('PPT 1234567')).toBe('1234567');
    expect(extractDocument('pasaporte AB123456')).toBe('AB123456');
    expect(extractDocument('quiero saber mi saldo 1020304050')).toBe('1020304050');
    expect(extractDocument('cuanto debo 43567890')).toBe('43567890');
    expect(extractDocument('cuanto debo? 1020304050')).toBe('1020304050');
    expect(extractDocument('me cobran 2300000')).toBeUndefined();
    expect(findPhone('¿El 604 607 4101 es de ustedes?')).toBeUndefined();
    expect(findPhone('me llamaron del 3001234567')).toBeUndefined();
    expect(findPhone('pueden llamarme a este número 3001234567')).toBe('3001234567');
  });
  it('cartera: dicha al pedir el asesor, junto a los demás datos o en la cola', () => {
    const wallets = [{ key: 'general', name: 'General' }, { key: 'flamingo', name: 'Flamingo', aliases: ['almacenes flamingo'] }, { key: 'offcorss', name: 'Offcorss' }, { key: 'claro', name: 'Claro' }];
    for (const [m, key] of [['quiero un asesor de offcorss', 'offcorss'], ['necesito un asesor para flamingo', 'flamingo'], ['quiero hablar con alguien de flamingo', 'flamingo'],
      ['me están cobrando de offcorss', 'offcorss'], ['asesor offcorss', 'offcorss']]) {
      expect(statedPortfolio(m, wallets, false)?.portfolio.key, m).toBe(key);
    }
    const all = (m: string) => extractVisitorData(m, wallets, { asked: 'handoff', missing: ['name', 'document', 'portfolio'] });
    expect(all('Juan Pérez 1020304050 claro')).toMatchObject({ name: 'Juan Pérez', document: '1020304050', portfolioKey: 'claro' });
    expect(all('Juan Pérez, 1020304050, General')).toMatchObject({ portfolioKey: 'general' });
    expect(all('soy Carlos, cc 1030405060, general')).toMatchObject({ name: 'Carlos', portfolioKey: 'general' });
    expect(extractVisitorData('ah ya me acordé, es flamingo', wallets, { asked: 'queue', missing: ['portfolio'] }).portfolioKey).toBe('flamingo');
    // En la cola solo se toma un nombre claro: "quedo atento" o "espero" no lo son.
    for (const m of ['quedo atento', 'entiendo', 'espero']) expect(extractVisitorData(m, [], { asked: 'queue', missing: ['name'] }).name, m).toBeUndefined();
    expect(extractVisitorData('bueno, Juan Pérez', [], { asked: 'queue', missing: ['name'] }).name).toBe('Juan Pérez');
  });
});

describe('revisión 2 (verificación nov. 2026): intenciones', async () => {
  const { classify, analyze, yesNo, isCancel, cancelOf, isRefuse, refuseQuestion, isHold, isWhyData, isWaitQuestion } = await import('../src/services/intents');
  it.each([
    ['eres una persona real?', 'identity'],
    ['hola, hablo con una persona real?', 'identity'],
    ['estoy hablando con un robot?', 'identity'],
    ['me atiende una persona o un robot?', 'identity'],
    ['alguien me puede ayudar?', 'help'],
    ['quiero hablar de nuevo con un asesor', 'human'],
    ['necesito hablar ya con un asesor', 'human'],
    ['me gustaría hablar directamente con un asesor', 'human'],
    ['quisiera hablar con alguno de sus asesores', 'human'],
    ['quiero comunicarme ya mismo con un asesor', 'human'],
    ['¿Me podrían comunicar con un asesor?', 'human'],
    ['¿me pueden pasar con un asesor?', 'human'],
    ['Quisiera que me comunicaran con un asesor', 'human'],
    ['me gustaría que un asesor me llamara', 'human'],
    ['Deseo ser atendido por un asesor', 'human'],
    ['dame un asesor', 'human'],
    ['necesito otra vez un asesor', 'human'],
    ['alguien me puede atender?', 'human'],
    ['Trabajo en una empresa y quiero hablar con un asesor para contratar el servicio de cobranza', 'human'],
    ['asesor offcorss', 'human'],
    ['quiero ser asesor', 'other'],
    ['quiero saber si los asesores atienden los sábados', 'other'],
    ['¿cómo me contacto con ustedes?', 'other'],
    ['¿cuánto me cobran por una asesoría legal?', 'other'],
    ['ya cancelé', 'sensitive'],
    ['¿Cómo está conformada la empresa?', 'other'],
    ['gracias, que tenga buen dia', 'thanks'],
    ['muy amable de su parte', 'thanks'],
    ['que amable, gracias', 'thanks'],
    ['le agradezco mucho', 'thanks'],
    ['ya entendí, gracias', 'thanks'],
    ['eso es todo por ahora, mil gracias', 'thanks'],
    ['ya no necesito nada, gracias', 'thanks'],
    ['estoy de acuerdo, gracias', 'thanks'],
    ['dios le pague', 'thanks'],
    ['quedo atento', 'thanks'],
    ['listo, espero', 'thanks'],
    ['ok, quedo pendiente', 'thanks'],
    ['gracias, buenas noches', 'thanks'],
  ])('%s → %s', (message, intent) => expect(classify(message)).toBe(intent));

  it('"¿qué tal…?" o "¿cómo está…?" solo son saludo si no siguen con el tema', () => {
    expect(analyze('¿Cómo está conformada la empresa?').greeted).toBe(false);
    expect(analyze('¿Qué tal es el servicio de call center?').greeted).toBe(false);
    expect(analyze('hola que tal, cual es el telefono')).toMatchObject({ greeted: true, rest: 'cual es el telefono' });
    expect(analyze('como estas, quiero saber el horario').greeted).toBe(true);
  });
  it('negar el asesor con otra pregunta no es un "no"; "por ahora no" sí', () => {
    expect(yesNo('no quiero hablar con ningún asesor, ¿qué servicios ofrecen?')).toBeNull();
    expect(yesNo('no necesito un asesor, solo el correo')).toBeNull();
    expect(yesNo('No quiero asesor, gracias')).toBe('no');
    expect(yesNo('por ahora no')).toBe('no');
  });
  it('cancelar: "ya cancelé" es un pago; en la cola "mejor no" responde a la pregunta del bot; despedirse suelta la toma de datos', () => {
    expect(isCancel('ya cancelé')).toBe(false);
    expect(isCancel('ya cancelé', { waiting: true })).toBe(false);
    expect(isCancel('mejor no', { waiting: true, answering: true })).toBe(false);
    expect(isCancel('déjalo', { waiting: true, answering: true })).toBe(false);
    expect(isCancel('mejor no', { waiting: true })).toBe(true);
    expect(isCancel('cancelar', { waiting: true, answering: true })).toBe(true);
    expect(cancelOf('olvídalo, ¿cuál es el correo?')).toEqual({ cancel: true, question: true });
    expect(cancelOf('ya no necesito el asesor, ¿me das el correo?', { waiting: true })).toEqual({ cancel: true, question: true });
    expect(cancelOf('no gracias, ¿cuál es el correo?', { waiting: true })).toEqual({ cancel: false, question: false });
    for (const m of ['ya no me interesa', 'chao', 'gracias, chao', 'no gracias, ya me ayudaste']) expect(isCancel(m), m).toBe(true);
    expect(isCancel('chao', { waiting: true })).toBe(false);
  });
  it('no sabe o no quiere dar el dato; pide tiempo; pregunta para qué', () => {
    for (const m of ['no sé cuál es', 'no me acuerdo cuál es', 'ni idea cuál', 'ninguna de esas', 'no estoy seguro', 'ahorita no puedo', 'no me sé la cédula de memoria', 'prefiero no decirlo', 'anónimo']) {
      expect(isRefuse(m), m).toBe(true);
    }
    expect(refuseQuestion('no quiero dar mi cédula, solo dime el correo')).toBe(true);
    for (const m of ['dame un segundo que la busco', 'luego te los doy', 'ahorita']) expect(isHold(m), m).toBe(true);
    expect(isWhyData('¿para qué quieres mi nombre?')).toBe(true);
    expect(isWhyData('¿para qué sirve la asesoría legal?')).toBe(false);
  });
  it('preguntas por la espera: no las de duración de un trámite ni de cuánto más pagar', () => {
    for (const m of ['cuánto más tengo que pagar?', 'la demora en el pago me genera intereses?', 'tengo una demora de tres meses en las cuotas', '¿cuánto se demora el paz y salvo?']) {
      expect(isWaitQuestion(m), m).toBe(false);
    }
    for (const m of ['cuanto se demora?', 'falta mucho?', '¿cuánto se demora el asesor?', 'por qué se demoran tanto?']) expect(isWaitQuestion(m), m).toBe(true);
  });
});

describe('revisión 3 (verificación nov. 2026): nombres, carteras e intenciones', async () => {
  const { extractVisitorData, explicitName, extractDocument, onlyData, statedPortfolio } = await import('../src/services/visitorData');
  const intents = await import('../src/services/intents');
  const asked = (m: string) => extractVisitorData(m, [], { asked: 'name' }).name;
  const handoff = (m: string, missing: Array<'name' | 'document' | 'portfolio'> = ['name', 'document']) => extractVisitorData(m, [], { asked: 'handoff', missing });
  it('al pedir los datos: verbos, condiciones, marcas, ciudades y la primera palabra de una frase no son el nombre', () => {
    for (const m of ['cuentame un chiste', 'mira lo que pasa es que me llegó un mensaje', 'resulta que me cobraron dos veces', 'explicame como funciona esto',
      'mandame el link de pago', 'fijate que no tengo la plata', 'acabo de pagar la cuota', 'joven, ayúdeme', 'uyy', 'domingo te los mando',
      'leo los mensajes y te digo', 'Ferreteria El Tornillo nit 900123456', 'soy viuda y no puedo pagar', 'soy ama de casa', 'soy paisa',
      'permítame un momento', 'regáleme un segundo', 'Comcel', 'Yanbal', 'Credifamilia', 'Montería', 'con Sodimac', 'es con Sodimac, 1020304050', 'hipoteca',
      'dele', 'breve', 'fresco', 'melo', 'Mundo Mujer', 'Muebles Jamar', 'soy víctima de suplantación, esa deuda no es mía', 'soy adulto mayor y no puedo pagar',
      'soy campesino y no tengo cómo pagar', 'simón']) {
      expect(handoff(m).name, m).toBeUndefined();
    }
    expect(handoff('cuentame un chiste', ['name']).name).toBeUndefined();
    expect(handoff('resulta que ya pagué', ['name']).name).toBeUndefined();
  });
  it('tras "¿Con quién tengo el gusto?": seguimientos, cierres, ciudades y condiciones no son un nombre; un nombre solo sí', () => {
    for (const m of ['presencial', 'virtual', 'caja social', 'Sodimac', 'explícame mejor', 'uyy', 'clara la respuesta, gracias', 'bueno, gracias. Feliz noche',
      'gracias, feliz tarde', 'Gracias. Feliz fin de semana', 'Feliz Navidad', 'Pasto', 'Montería', 'Armenia', 'Pereira', 'soy viuda', 'soy campesina de Boyacá',
      'cuéntame más', 'infórmame', 'Comcel', 'no te voy a decir mi nombre']) {
      expect(asked(m), m).toBeUndefined();
    }
    for (const [m, name] of [['Clara', 'Clara'], ['leo', 'Leo'], ['Yurany', 'Yurany'], ['Juan de Pereira', 'Juan'], ['Soledad', 'Soledad']]) expect(asked(m), m).toBe(name);
  });
  it('la frase de entrada, una negativa o el pasaporte no esconden el nombre', () => {
    for (const m of ['mis datos son Juan Pérez cc 1020304050', 'aquí van mis datos: Juan Pérez, 1020304050', 'mi nombre y cédula: Juan Pérez 1020304050',
      'te paso mis datos: Juan Pérez 1020304050', 'ok, mis datos son Juan Pérez y 1020304050', 'claro que sí: Juan Pérez 1020304050', 'le escribe Juan Pérez, cc 1020304050',
      'Nombre completo Juan Pérez cédula 1020304050', 'ya te lo dije: Juan Pérez', 'Juan Pérez, no tengo la cédula a la mano', 'Juan Pérez, la cédula no te la voy a dar']) {
      expect(handoff(m).name, m).toBe('Juan Pérez');
    }
    expect(handoff('documento # 43567890, Rosa Díaz')).toMatchObject({ name: 'Rosa Díaz', document: '43567890' });
    expect(handoff('pasaporte AB123456 Juan Pérez')).toMatchObject({ name: 'Juan Pérez', document: 'AB123456' });
    expect(handoff('me llamo Juan Pérez, la cédula no te la doy').name).toBe('Juan Pérez');
    expect(onlyData(handoff('mis datos son Juan Pérez cc 1020304050'))).toBe(true);
  });
  it('"de" seguido de una ciudad o una empresa no es parte del nombre; "bueno" seguido de la frase no es un apellido', () => {
    expect(explicitName('Buenas tardes, soy Laura de Ecopetrol, queremos cotizar el servicio de cobranza')).toBe('Laura');
    expect(explicitName('hola, soy Carolina de Sodimac y necesito información del call center')).toBe('Carolina');
    expect(explicitName('Soy Carlos de Bello, cc 71222333')).toBe('Carlos');
    expect(handoff('Ana Torres de Armenia 43111222').name).toBe('Ana Torres');
    expect(explicitName('hola soy juan bueno quería saber si tienen sede en cali')).toBe('Juan');
    expect(explicitName('me llamo sandra bueno es que tengo una deuda')).toBe('Sandra');
    expect(asked('María de los Ángeles Ruiz')).toBe('María de los Ángeles Ruiz');
    expect(asked('Juan de Dios Restrepo')).toBe('Juan de Dios Restrepo');
  });
  it('correcciones del nombre: "no es X, es Y", "me equivoqué de nombre…", también en la cola', () => {
    for (const m of ['no, es Juan Gómez', 'mi nombre no es Pedro, es Juan Gómez', 'me equivoqué de nombre, es Juan Gómez', 'no es Pedro Gómez, es Juan Gómez']) {
      expect(handoff(m, ['document']), m).toMatchObject({ name: 'Juan Gómez', nameExplicit: true });
    }
    expect(extractVisitorData('no es Pedro, es Juan', [], { asked: null })).toMatchObject({ name: 'Juan', nameExplicit: true });
    expect(extractVisitorData('perdón, es Juan Pablo Pérez', [], { asked: null })).toMatchObject({ name: 'Juan Pablo Pérez', nameExplicit: true });
    expect(extractVisitorData('no, es con offcorss', [], { asked: null }).name).toBeUndefined();
  });
  it('nombre y cédula sin que se pidan; un tercero en la cola no es el visitante; una pregunta junto al nombre no es "solo datos"', () => {
    expect(extractVisitorData('Juan Pérez 1020304050', [], { asked: null })).toMatchObject({ name: 'Juan Pérez', document: '1020304050' });
    expect(onlyData(extractVisitorData('Juan Pérez 1020304050', [], { asked: null }))).toBe(true);
    expect(extractVisitorData('Juan 1020304050', [], { asked: null }).name).toBeUndefined();
    expect(extractVisitorData('Carlos me dijo que me iban a llamar', [], { asked: 'queue', missing: ['name'] }).name).toBeUndefined();
    expect(onlyData(extractVisitorData('Andrés, ¿y el correo?', [], { asked: 'name' }))).toBe(false);
    expect(onlyData(extractVisitorData('me llamo Ana, el telefono?', [], { asked: null }))).toBe(false);
    expect(onlyData(extractVisitorData('soy Pedro, que hacen?', [], { asked: null }))).toBe(false);
  });
  it('documento: PEP de 15 dígitos; un NIT que pregunta si es de ellos no es el documento del visitante', () => {
    expect(extractDocument('mi PEP es 123456789012345')).toBe('123456789012345');
    for (const m of ['¿el NIT 900123456-1 es de ustedes?', '¿el NIT 800.123.456-7 es el de ustedes?', '¿el 900123456-1 es de ustedes?']) expect(extractDocument(m), m).toBeUndefined();
  });
  it('cartera: la negada no cuenta, un "claro" inicial es un sí, dos sin marcar no se adivinan, preguntar por sus asesores no la anota', () => {
    const wallets = [{ key: 'general', name: 'General' }, { key: 'flamingo', name: 'Flamingo', aliases: ['almacenes flamingo'] }, { key: 'offcorss', name: 'Offcorss' }, { key: 'claro', name: 'Claro' }];
    const all = (m: string) => extractVisitorData(m, wallets, { asked: 'handoff', missing: ['name', 'document', 'portfolio'] });
    expect(all('claro, me llamo Pedro Pérez').portfolioKey).toBeUndefined();
    expect(all('claro, Juan Pérez 1020304050').portfolioKey).toBeUndefined();
    expect(all('Sí claro, me llamo Ana Ruiz, cc 43567890').portfolioKey).toBeUndefined();
    expect(all('claro: Ana Ruiz, 43567890, Flamingo')).toMatchObject({ name: 'Ana Ruiz', portfolioKey: 'flamingo' });
    expect(all('claro, Juan Pérez 1020304050, es con flamingo').portfolioKey).toBe('flamingo');
    expect(all('no es flamingo, es offcorss').portfolioKey).toBe('offcorss');
    expect(all('offcorss, no flamingo').portfolioKey).toBe('offcorss');
    expect(all('no es general, es offcorss').portfolioKey).toBe('offcorss');
    expect(all('Offcorss y Flamingo').portfolioKey).toBeUndefined();
    expect(extractVisitorData('claro', wallets, { asked: 'handoff', missing: ['portfolio'] }).portfolioKey).toBe('claro');
    expect(statedPortfolio('perdón, es offcorss', wallets, false)).toMatchObject({ portfolio: { key: 'offcorss' }, explicit: true });
    expect(statedPortfolio('necesito un asesor, es para flamingo', wallets, false)?.portfolio.key).toBe('flamingo');
    for (const m of ['cuántos asesores de flamingo tienen?', 'los asesores de flamingo atienden los sábados?', 'quiero ser asesor de offcorss, como aplico?']) {
      expect(statedPortfolio(m, wallets, false), m).toBeUndefined();
    }
    const queue = (m: string) => extractVisitorData(m, wallets, { asked: 'queue', missing: ['portfolio'] }).portfolioKey;
    for (const [m, key] of [['es con Flamingo', 'flamingo'], ['la cartera es Flamingo', 'flamingo'], ['tengo una deuda con Flamingo', 'flamingo'], ['mi cartera es Offcorss', 'offcorss'],
      ['perdón, es Offcorss', 'offcorss'], ['flamingo', 'flamingo']]) {
      expect(queue(m), m).toBe(key);
    }
    expect(queue('¿ustedes trabajan con Offcorss?')).toBeUndefined();
  });
  it.each([
    ['no quiero que me llamen', 'other'],
    ['¿es legal que me llamen tanto?', 'sensitive'],
    ['quiero que me llamen', 'human'],
    ['quiero otro asesor', 'human'],
    ['necesito otro asesor por favor', 'human'],
    ['me pasas con otro asesor?', 'human'],
    ['quiero hablar con mi asesor', 'human'],
    ['no quiero hablar con un bot', 'human'],
    ['quisiera que me atendiera una persona', 'human'],
    ['quiero hablar con el gerente', 'human'],
    ['necesito hablar con el encargado', 'human'],
    ['¿cuál es el teléfono para hablar con un asesor?', 'other'],
    ['¿a qué número llamo para hablar con un asesor?', 'other'],
    ['eres un asesor?', 'identity'],
    ['¿tú eres un asesor?', 'identity'],
    ['¿eres el asesor?', 'identity'],
    ['hay una persona ahí?', 'identity'],
    ['quiero trabajar como asesor', 'other'],
    ['no quiero hablar con nadie', 'other'],
    ['hola como estan ustedes', 'greeting'],
    ['buenas tardes, como le va?', 'greeting'],
    ['hola, que mas?', 'greeting'],
    ['buenos dias, como amanecio?', 'greeting'],
    ['y tu como estas?', 'greeting'],
    ['hola, todo bien?', 'greeting'],
    ['gracias, ya me quedo claro todo', 'thanks'],
    ['ya me quedó claro, gracias', 'thanks'],
    ['gracias, ya no necesito mas', 'thanks'],
    ['gracias, lo tendre en cuenta', 'thanks'],
    ['gracias, ya voy a llamar', 'thanks'],
    ['gracias, que dios lo bendiga', 'thanks'],
    ['gracias por su tiempo', 'thanks'],
    ['gracias por atenderme', 'thanks'],
    ['gracias por la paciencia', 'thanks'],
    ['gracias, eres muy amable', 'thanks'],
    ['perfecto entonces', 'thanks'],
    ['ok, ya les escribo', 'thanks'],
    ['gracias, disculpe la molestia', 'thanks'],
    ['muchas gracias señorita', 'thanks'],
    ['gracias señor', 'thanks'],
  ])('%s → %s', (m, intent) => expect(intents.classify(m)).toBe(intent));
  it('saludos que preguntan cómo está; "¿qué tal es…?" no es un saludo', () => {
    expect(intents.analyze('hola como estan ustedes')).toMatchObject({ intent: 'greeting', howAreYou: true });
    expect(intents.analyze('hola, ¿cómo estás? soy Luisa')).toMatchObject({ greeted: true, rest: 'soy luisa' });
    expect(intents.analyze('¿Qué tal es el servicio de call center?').greeted).toBe(false);
  });
  it('respuestas a la oferta y cierres', () => {
    for (const m of ['estoy de acuerdo', 'simón', 'dele', 'si estoy de acuerdo']) expect(intents.yesNo(m), m).toBe('yes');
    for (const m of ['no, pero gracias', 'ahora no puedo', 'mira, mejor no', 'no, gracias igual']) expect(intents.yesNo(m), m).toBe('no');
    expect(intents.yesNo('nada, gracias')).toBe('closing');
  });
  it('cancelar en la cola o al pedir los datos, con y sin pregunta', () => {
    for (const m of ['ya no me interesa', 'no me interesa', 'ya no quiero nada, gracias', 'me voy, chao', 'ya no quiero hablar con nadie']) {
      expect(intents.isCancel(m, { waiting: true }), m).toBe(true);
    }
    expect(intents.cancelOf('no quiero esperar, cual es el correo?', { waiting: true })).toEqual({ cancel: true, question: true });
    expect(intents.cancelOf('ya no me interesa, cual es el correo?')).toEqual({ cancel: true, question: true });
    expect(intents.cancelOf('no, mejor dime el teléfono')).toEqual({ cancel: true, question: true });
    expect(intents.isCancel('no me interesa dar mis datos')).toBe(false);
    expect(intents.isCancel('me voy a pagar mañana', { waiting: true })).toBe(false);
  });
  it('negarse, pedir tiempo, preguntar para qué o por la espera', () => {
    for (const m of ['la cédula no te la doy', 'no te la voy a dar', 'no te voy a decir mi nombre', 'no te voy a decir']) expect(intents.isRefuse(m), m).toBe(true);
    expect(intents.refusedFields('no tengo cédula, tengo pasaporte AB123456')).toEqual(['document']);
    expect(intents.refusedFields('no quiero dar mis datos')).toBe('all');
    for (const m of ['no la tengo aquí, déjame buscarla', 'espera un momento', 'estoy buscando la cédula', 'el lunes te los paso', 'permítame un momento',
      'regáleme un segundo', 'aguarda']) {
      expect(intents.isHold(m), m).toBe(true);
    }
    for (const m of ['por qué?', '¿y eso para qué?', '¿para qué?', 'para qué lo necesitas?', '¿es seguro?']) expect(intents.isWhyData(m), m).toBe(true);
    for (const m of ['cuánto me toca esperar?', 'demoran mucho?', 'tardan mucho?', 'a qué hora me atienden?', 'y el asesor?', 'cuánto se demora en llegar el asesor?']) {
      expect(intents.isWaitQuestion(m), m).toBe(true);
    }
  });
  it('¿es una pregunta? por partes de la frase, sin tomar como pregunta "dime" solo o "es de Dupree"', () => {
    for (const m of ['1020304050 y cual es el correo', 'no, mejor dime el teléfono', 'Juan Pérez y cuál es el correo', 'necesito un asesor y saber donde quedan']) {
      expect(intents.looksLikeQuestion(m), m).toBe(true);
    }
    for (const m of ['dime', 'cuéntame', 'es de dupree', 'quiero poner una queja', 'que pena con usted', 'es urgente', 'Juan Pérez']) {
      expect(intents.looksLikeQuestion(m), m).toBe(false);
    }
  });
});

describe('revisión 3 (verificación nov. 2026): respuestas con el sitio', async () => {
  const { buildKnowledge, contactAnswer, companyNumberAnswer, isGrounded } = await import('../src/services/chat');
  const { topicText } = await import('../src/services/intents');
  const k = buildKnowledge({
    slug: 'aagora',
    sections: [
      { slug: 'area-juridica', title: 'Área jurídica y administrativa', route: '/juridica', text: 'PQR (Línea exclusiva PQR): Canal para peticiones, quejas, reclamos y consultas sobre datos personales. Correo gerencia@demo.test. Línea 604 607 4101.' },
      { slug: 'contacto', title: 'Hablemos', route: '/contacto', text: 'Medellín (Línea de atención general): Carrera 46 # 50-63, Medellín. Línea 604 607 4101.\nBogotá (Línea de atención): Carrera 7 # 33-42, Bogotá D. C.. Línea 604 607 4101.\nCorreo de contacto: gerencia@demo.test' },
      { slug: 'nosotros', title: 'Nosotros', route: '/nosotros', text: 'Quiénes somos: A. AGORA ABOGADOS S.A.S., identificada con NIT 901476289-2, tiene su sede principal en Medellín.' },
    ],
  });
  it('ciudades con sede, sucursales, "¿y en Cali?" y la ciudad del visitante', () => {
    for (const m of ['¿Atienden en Bogotá?', '¿están en Bogotá?', '¿tienen sucursal en Bogotá?', '¿tienen presencia en Bogotá?']) expect(contactAnswer(k, m)?.text, m).toContain('Carrera 7 # 33-42');
    expect(contactAnswer(k, topicText('gracias, ¿y en Cali?'))?.text).toBe('En el sitio no aparece una sede en Cali. Nuestras sedes publicadas están en Medellín y Bogotá.');
    expect(contactAnswer(k, 'Soy de Cali, ¿cuál es el correo?')?.text).toBe('Correo de contacto: gerencia@demo.test');
    expect(contactAnswer(k, 'Estoy en Cali, ¿cuál es el teléfono?')?.text).toBe('Línea de atención: 604 607 4101');
  });
  it('quejas, "¿dónde quedan?" junto a otro dato y la palabra "datos"', () => {
    for (const m of ['nadie me contesta en la línea', 'llamé a la línea y nadie contesta', 'no me han contestado en la línea']) expect(contactAnswer(k, m), m).toBeNull();
    const both = contactAnswer(k, '¿Dónde quedan? ¿Cuál es el teléfono?')?.text ?? '';
    expect(both).toContain('604 607 4101');
    expect(both).toContain('Carrera 46 # 50-63');
    const data = contactAnswer(k, '¿dónde están los datos de contacto?')?.text ?? '';
    expect(data).toContain('Correo de contacto: gerencia@demo.test');
    expect(data).not.toContain('PQR');
  });
  it('sin modelo, la pregunta compuesta da lo publicado y dice lo que no', () => {
    expect(contactAnswer(k, '¿cuál es el teléfono y el horario?', { partial: true })?.text).toBe('Línea de atención: 604 607 4101. El horario de atención no aparece publicado en el sitio.');
    const sat = contactAnswer(k, '¿la oficina de Bogotá atiende los sábados?', { partial: true })?.text ?? '';
    expect(sat).toContain('Carrera 7 # 33-42');
    expect(sat).toMatch(/El horario de atención no aparece publicado en el sitio\.$/);
    expect(contactAnswer(k, '¿cuál es el teléfono y el horario?')).toBeNull();
  });
  it('un número que no es de la empresa se dice; una respuesta honesta de "no está publicado" se acepta', () => {
    expect(companyNumberAnswer(k, '¿el NIT 900123456-1 es de ustedes?')?.text).toBe('Ese número no aparece en nuestro sitio. El NIT que publicamos es 901476289-2.');
    expect(companyNumberAnswer(k, '¿el 3001234567 es de ustedes?')?.text).toBe('Ese número no aparece en nuestro sitio. Nuestra línea de atención publicada es 604 607 4101.');
    expect(companyNumberAnswer(k, 'me llamaron del 3001234567')).toBeNull();
    expect(isGrounded('La línea de atención es 604 607 4101; el horario no aparece publicado en el sitio.', k)).toBe(true);
  });
});

describe('revisión 4 (verificación nov. 2026): nombres, carteras e intenciones', async () => {
  const { extractVisitorData, onlyData, statedPortfolio, namedPortfolios, deniedName } = await import('../src/services/visitorData');
  const intents = await import('../src/services/intents');
  const { isComplaint } = await import('../src/services/chat');
  const asked = (m: string) => extractVisitorData(m, [], { asked: 'name' }).name;
  const handoff = (m: string, missing: Array<'name' | 'document' | 'portfolio'> = ['name', 'document']) => extractVisitorData(m, [], { asked: 'handoff', missing }).name;
  const W = [{ key: 'general', name: 'General' }, { key: 'claro', name: 'Claro' }, { key: 'flamingo', name: 'Flamingo' }, { key: 'offcorss', name: 'Offcorss' }];
  const pick = (m: string, mode: boolean | 'bare', opts: { onlyPortfolio?: boolean; human?: boolean } = {}) => statedPortfolio(m, W, mode, new Set(), opts)?.portfolio.key ?? null;

  it('negar un nombre no lo da; "no me llamo X sino Y" da Y; el adjetivo de "la cédula correcta es…" no es un nombre', () => {
    for (const m of ['no me llamo Pedro', 'no soy Juan Pérez, él es mi papá', 'yo no soy Pedro Gómez, él es mi esposo']) expect(handoff(m), m).toBeUndefined();
    expect(extractVisitorData('Me llaman cobrando a Juan Pérez, pero yo no soy Juan Pérez', [], { asked: null }).name).toBeUndefined();
    expect(extractVisitorData('Me están cobrando una deuda de Juan Pérez, yo no soy Juan Pérez, soy la hija', [], { asked: null }).name).toBeUndefined();
    expect(handoff('no me llamo Pedro sino Juan')).toBe('Juan');
    expect(asked('no me llamo telefono, me llamo Pedro')).toBe('Pedro');
    expect(onlyData(extractVisitorData('no me llamo telefono, me llamo Pedro', [], { asked: 'name' }))).toBe(true);
    expect(deniedName('no me llamo Pedro')).toBe('pedro');
    for (const m of ['disculpa, la cedula correcta es 1020304051', 'la cédula completa es 1020304051', 'perdón, la cédula real es 1020304051', 'la cédula exacta es 1020304051']) {
      expect(handoff(m, ['name']), m).toBeUndefined();
    }
  });

  it('"Con Pedro", "rosa", "luz dary" o "Ludwing" solos al pedir los datos son el nombre; "simón" o "nel" solos no', () => {
    expect(handoff('Con Pedro')).toBe('Pedro');
    expect(handoff('con Juan Pérez, cc 1020304050')).toBe('Juan Pérez');
    for (const [m, name] of [['rosa', 'Rosa'], ['luz dary', 'Luz Dary'], ['paz', 'Paz'], ['Ludwing', 'Ludwing'], ['Yeraldyn', 'Yeraldyn']]) expect(handoff(m), m).toBe(name);
    expect(handoff('keymer')).toBeUndefined(); // poco común, en minúscula y sin el documento: ante la duda no
    expect(handoff('ludwing')).toBe('Ludwing'); // ya está entre los nombres de pila del léxico
    expect(handoff('simón')).toBeUndefined();
    expect(asked('nel')).toBeUndefined();
    expect(asked('Pedro Nel Ospina')).toBe('Pedro Nel Ospina');
    expect(handoff('domingo te los mando')).toBeUndefined();
    expect(handoff('paz y salvo')).toBeUndefined();
  });

  it('el nombre seguido de un saludo o de la consulta, sin coma, se guarda', () => {
    for (const [m, name] of [['Ana López mucho gusto', 'Ana López'], ['Carlos mucho gusto', 'Carlos'], ['Juan buenas noches', 'Juan'], ['Luisa buen día', 'Luisa'],
      ['Rosa Elena buenas tardes', 'Rosa Elena'], ['Rosa Elena Tarde', 'Rosa Elena']]) {
      expect(asked(m), m).toBe(name);
    }
    expect(handoff('Juan Pérez mi saldo 1020304050')).toBe('Juan Pérez');
    expect(handoff('Juan Pérez cuál es el horario')).toBe('Juan Pérez');
    expect(handoff('Juan Pérez buenas tardes 1020304050')).toBe('Juan Pérez');
    expect(extractVisitorData('Juan Pérez quiero saber mi saldo, cc 1020304050', [], { asked: null }).name).toBe('Juan Pérez');
    expect(extractVisitorData('Juan Pérez necesito saber cuánto debo cc 1020304050', [], { asked: null }).name).toBe('Juan Pérez');
    expect(asked('Carlos me dijo que llamara')).toBeUndefined();
  });

  it('un apellido que también es ciudad, departamento o marca no hace perder el nombre', () => {
    for (const [m, name] of [['Juan Caldas 1020304050', 'Juan Caldas'], ['María Sucre 43567890', 'María Sucre'], ['Luis Girón 1020304050', 'Luis Girón'],
      ['Ana Cartagena 43567890', 'Ana Cartagena'], ['Rosa Elena Calle 43567890', 'Rosa Elena Calle'], ['Luis Corona 1020304050', 'Luis Corona'],
      ['Pedro Santander 1020304050', 'Pedro Santander'], ['Juan Medellín 1020304050', 'Juan Medellín']]) {
      expect(handoff(m), m).toBe(name);
    }
    expect(handoff('me llamo Carlos Nariño, cc 1020304050')).toBe('Carlos Nariño');
    expect(asked('Andrés Buenaventura')).toBe('Andrés Buenaventura');
    expect(asked('me llamo Paz')).toBe('Paz');
    expect(handoff('Pasto')).toBeUndefined();
  });

  it('palabras del tema, saludos, apelativos y groserías no son un nombre; "soy <oficio o parentesco>" tampoco', () => {
    for (const m of ['laboral', 'familia', 'penal', 'gratuita', 'online', 'remota', 'aló', 'hey', 'plis', 'porfi', 'sumercé', 'patrón', 'veci', 'mierda', 'respeten', 'Comfandi',
      'policía', 'sobrina']) {
      expect(asked(m), m).toBeUndefined();
    }
    for (const m of ['aló', 'hey', 'plis', 'mierda']) expect(handoff(m, ['name']), m).toBeUndefined();
    for (const m of ['soy emprendedora', 'soy policía', 'soy sobrina del titular', 'soy nieta de la señora', 'soy conductor y no he podido pagar']) expect(handoff(m), m).toBeUndefined();
    expect(handoff('soy wilmar 1020304050')).toBe('Wilmar');
    expect(handoff('soy Ludwing')).toBe('Ludwing');
  });

  it('un saludo social o una cortesía junto al nombre no cuentan como pregunta ni tema', () => {
    for (const m of ['hola, ¿qué tal? soy Luisa', 'Buenos días, ¿cómo está? Le habla Martha Gómez', '¿qué más? soy Pedro', 'hola, ¿cómo estás? soy Luisa']) {
      expect(onlyData(extractVisitorData(m, [], { asked: null })), m).toBe(true);
    }
    expect(onlyData(extractVisitorData('Carlos Gómez para servirle', [], { asked: 'name' }))).toBe(true);
  });

  it('cartera: el "claro" de acuse en la cola no es la cartera Claro; "claro, general" es General', () => {
    for (const m of ['claro, gracias', 'ok claro', 'claro que sí', 'sí claro', 'claro', 'listo, claro']) expect(pick(m, 'bare'), m).toBeNull();
    expect(pick('es con claro', 'bare')).toBe('claro');
    expect(pick('claro', true, { onlyPortfolio: true })).toBe('claro');
    expect(pick('claro que sí', true, { onlyPortfolio: true })).toBeNull();
    for (const m of ['claro, general', 'claro que sí, general', 'sí claro, General', 'claro, la general', 'es una consulta general']) expect(pick(m, true, { onlyPortfolio: true }), m).toBe('general');
    expect(pick('claro que sí: Juan Pérez, cc 1020304050, cartera claro', true)).toBe('claro');
    expect(pick('claro que sí, es de claro', false)).toBe('claro');
    expect(extractVisitorData('claro, gracias', W, { asked: 'queue', missing: ['portfolio'] }).portfolioKey).toBeUndefined();
    expect(extractVisitorData('claro, soy Ana Gómez, cc 43123456, de claro', W, { asked: 'handoff', missing: ['name', 'document', 'portfolio'] }).portfolioKey).toBe('claro');
  });

  it('cartera: "no, es X" corrige, "X no, Y" niega X, dos a la vez no se adivinan y "los asesores de X" en un pedido la dice', () => {
    expect(pick('no, es Offcorss', true)).toBe('offcorss');
    expect(pick('no, la de Offcorss', true)).toBe('offcorss');
    expect(statedPortfolio('ah no, es flamingo', W, 'bare')).toMatchObject({ portfolio: { key: 'flamingo' }, explicit: true });
    expect(statedPortfolio('perdón, offcorss, no flamingo', W, 'bare')).toMatchObject({ portfolio: { key: 'offcorss' }, explicit: true });
    expect(pick('flamingo no, offcorss', true)).toBe('offcorss');
    expect(pick('flamingo no, es offcorss', true)).toBe('offcorss');
    expect(pick('Offcorss y Flamingo', true)).toBeNull();
    expect(pick('tengo deuda con claro y con flamingo', false)).toBeNull();
    expect(pick('mi cartera es Flamingo, ¿trabajan con Offcorss?', false)).toBe('flamingo');
    expect(pick('Quiero hablar con los asesores de Flamingo', false, { human: true })).toBe('flamingo');
    expect(pick('¿cuántos asesores de flamingo tienen?', false)).toBeNull();
    expect(extractVisitorData('los asesores de offcorss me pueden llamar?', W, { asked: null }).portfolioKey).toBe('offcorss');
    expect(namedPortfolios('no es flamingo', W)).toMatchObject({ list: [{ key: 'flamingo' }], negated: true });
    expect(namedPortfolios('es una consulta general', W)).toMatchObject({ list: [{ key: 'general' }], negated: false });
    expect(namedPortfolios('claro, pero no sé cuál es', W).list).toEqual([]);
  });

  it('pedir "un asesor, no un robot" o quejarse de un asesor no es negarlo', () => {
    for (const m of ['quiero un asesor, no un robot', 'quiero un asesor humano no un bot', 'necesito un asesor humano, no un robot, por favor',
      'quiero hablar con otro asesor, el asesor no me ayudó', 'no quiero que me llamen, quiero hablar con un asesor por aquí']) {
      expect(intents.analyze(m).intent, m).toBe('human');
    }
    expect(intents.analyze('no quiero que me llamen').intent).not.toBe('human');
    for (const m of ['el asesor no me contesto ayer', 'mi asesor no me ha llamado', 'la asesora no me devolvio la llamada']) expect(intents.HUMAN_NEGATED.test(m), m).toBe(false);
    for (const m of ['un asesor no gracias', 'asesor no', 'no quiero un asesor']) expect(intents.HUMAN_NEGATED.test(m), m).toBe(true);
    for (const m of ['el asesor no me ha contestado', 'mi asesora no me ha devuelto la llamada', 'el asesor no me resolvió nada', 'el asesor no me dio la información']) {
      expect(isComplaint(m), m).toBe(true);
    }
    expect(isComplaint('quiero un asesor, no un robot')).toBe(false);
  });

  it('en la cola, "no quiero nada más" o "me voy un momento" no cancelan; "ya no me interesa" y "me voy, gracias" sí', () => {
    const cancel = (m: string, o: { waiting?: boolean; answering?: boolean }) => intents.cancelOf(m, o).cancel;
    for (const m of ['no quiero nada más, gracias', 'no, no quiero nada más', 'ya no necesito nada más, gracias', 'no me interesa, gracias']) {
      expect(cancel(m, { waiting: true, answering: true }), m).toBe(false);
    }
    for (const m of ['no quiero nada más, gracias', 'me voy un momento, ya vuelvo', 'me voy de viaje mañana, ¿me pueden atender hoy?', 'ya no quiero nada, gracias, aquí espero',
      'no quiero nada más que hablar con el asesor', 'me voy a almorzar, ya vuelvo']) {
      expect(cancel(m, { waiting: true }), m).toBe(false);
    }
    for (const m of ['ya no me interesa', 'me voy, gracias', 'ya me voy', 'ya no quiero esperar']) expect(cancel(m, { waiting: true, answering: true }), m).toBe(true);
    expect(cancel('no quiero nada más', {})).toBe(true); // al pedir los datos sí deja la solicitud
    expect(intents.cancelOf('olvídalo y dime el teléfono', {})).toEqual({ cancel: true, question: true });
    expect(intents.cancelOf('mejor no y dame el correo', {})).toEqual({ cancel: true, question: true });
  });

  it('preguntas sin signo, pedidos en imperativo, anunciar una pregunta, "no entiendo" y "estoy de acuerdo"', () => {
    for (const m of ['dame el correo', 'regálame el teléfono', 'pásame la dirección porfa', 'Juan Pérez, cuál es el horario', '1020304050 cuál es el correo', '1020304050 dónde quedan']) {
      expect(intents.looksLikeQuestion(m), m).toBe(true);
    }
    for (const m of ['pásame con un asesor', 'gracias, que tengas buen día', 'como te dije, Juan Pérez', 'Juan Pérez']) expect(intents.looksLikeQuestion(m), m).toBe(false);
    for (const m of ['quiero preguntar algo', 'quiero consultar algo', 'quisiera preguntar otra cosa', '¿te puedo hacer una pregunta?', 'tengo otra pregunta']) {
      expect(intents.announcesQuestion(m), m).toBe(true);
      expect(intents.analyze(m).intent, m).toBe('help');
    }
    expect(intents.announcesQuestion('necesito consultar mi saldo')).toBe(false);
    for (const m of ['no entiendo', 'no le entendí', '¿cómo así?', 'no te entiendo bien']) expect(intents.isConfused(m), m).toBe(true);
    expect(intents.isConfused('entiendo')).toBe(false);
    for (const m of ['estoy de acuerdo', 'ok, estoy de acuerdo', 'estoy de acuerdo, gracias', 'listo, estoy de acuerdo', 'sí, de acuerdo con eso']) expect(intents.afterYes(m), m).toBe('');
    expect(intents.afterYes('sí, pero dime dónde quedan')).toBe('dime donde quedan');
  });

  it('identidad, esperas, la pregunta por el documento y las empresas que quieren contratar', () => {
    for (const m of ['¿estoy hablando con alguien?', '¿me atiende un asesor real?']) expect(intents.analyze(m).intent, m).toBe('identity');
    for (const m of ['ya regreso', 'ya vuelvo', 'te los mando el domingo', 'domingo te los mando', 'el lunes te los paso']) expect(intents.isHold(m), m).toBe(true);
    for (const m of ['¿y si no tengo cédula?', 'y si no tengo cédula, ¿qué hago?', 'no tengo cédula, ¿sirve la tarjeta de identidad?', '¿cuál documento?']) {
      expect(intents.asksWhichDocument(m), m).toBe(true);
    }
    expect(intents.asksWhichDocument('no tengo la cédula a la mano')).toBe(false);
    for (const m of ['el asesor no me ha contestado', 'nadie me ha respondido', 'la asesora todavía no me escribe']) expect(intents.isWaitQuestion(m), m).toBe(true);
    for (const m of ['pueden trabajar para mi empresa en la cobranza', 'mi empresa quiere trabajar con ustedes para recuperar la cartera', 'buscamos una empresa para la recuperacion de cartera']) {
      expect(intents.COMMERCIAL_RE.test(m), m).toBe(true);
    }
    expect(intents.COMMERCIAL_RE.test('quiero trabajar en una empresa como la suya')).toBe(false);
  });
});

describe('revisión 4 (verificación nov. 2026): respuestas con el sitio', async () => {
  const { buildKnowledge, contactAnswer, isGrounded } = await import('../src/services/chat');
  const k = buildKnowledge({
    slug: 'aagora',
    sections: [
      { slug: 'presentacion', title: 'A.AGORA BPO', route: '/', text: 'Sede principal: Carrera 46 # 50-63, Edificio Playa Oriental, piso 11, Medellín, Colombia.' },
      {
        slug: 'contacto', title: 'Hablemos', route: '/contacto',
        text: 'Medellín (Línea de atención general): Carrera 46 # 50-63, Edificio Playa Oriental, piso 11, Medellín. Línea 604 607 4101.\nBogotá (Línea de atención): Carrera 7 # 33-42, Edificio Corfivalle, Centro Internacional, Bogotá D. C.. Línea 604 607 4101.\nCorreo de contacto: gerencia@demo.test',
      },
    ],
  });
  it('la línea no se rotula con una sede por una palabra parecida ("interesa", "internet", "centro", "orientación")', () => {
    for (const m of ['me interesa el servicio, ¿cuál es el teléfono?', 'encontré su página en internet, ¿cuál es el teléfono?', '¿cuál es el teléfono del centro de atención?']) {
      expect(contactAnswer(k, m)?.text, m).toBe('Línea de atención: 604 607 4101');
    }
    for (const m of ['Me interesa saber dónde quedan', 'necesito orientacion, donde quedan?']) {
      const t = contactAnswer(k, m)?.text ?? '';
      expect(t, m).toContain('Carrera 46 # 50-63');
      expect(t, m).toContain('Carrera 7 # 33-42');
    }
  });
  it('la ciudad del visitante cuenta cuando pregunta por una sede "aquí" o "allá"; los departamentos y más municipios', () => {
    expect(contactAnswer(k, 'soy colombiano y vivo en Cali, ¿tienen sede aquí?')?.text).toBe('En el sitio no aparece una sede en Cali. Nuestras sedes publicadas están en Medellín y Bogotá.');
    expect(contactAnswer(k, 'Soy de Medellín, ¿tienen oficina allá?')?.text).toMatch(/^Medellín.*Carrera 46 # 50-63/);
    expect(contactAnswer(k, 'estoy en Bogotá, ¿dónde queda la oficina?')?.text).toMatch(/^Bogotá.*Carrera 7 # 33-42/);
    expect(contactAnswer(k, 'soy de Pasto, ¿tienen oficina allá?')?.text).toMatch(/^En el sitio no aparece una sede en Pasto\./);
    expect(contactAnswer(k, 'Soy de Cali, ¿cuál es el correo?')?.text).toBe('Correo de contacto: gerencia@demo.test');
    expect(contactAnswer(k, '¿tienen sede en Soledad?')?.text).toMatch(/^En el sitio no aparece una sede en Soledad\./);
    expect(contactAnswer(k, '¿tienen sede en Antioquia?')?.text).toMatch(/^Medellín.*Carrera 46 # 50-63/);
    expect(contactAnswer(k, '¿tienen sede en Boyacá?')?.text).toMatch(/^En el sitio no aparece una sede en Boyacá\./);
  });
  it('sin modelo: lo publicado y lo que no, también si no hay nada publicado de lo que pregunta', () => {
    expect(contactAnswer(k, '¿cuál es el número de WhatsApp?', { partial: true })?.text).toBe('Línea de atención: 604 607 4101. En el sitio no aparece un número de WhatsApp.');
    expect(contactAnswer(k, '¿cuál es el horario?', { partial: true })?.text).toBe('El horario de atención no aparece publicado en el sitio. Puedes consultarlo en la línea de atención: 604 607 4101.');
    expect(contactAnswer(k, 'estoy interesado en el servicio, ¿dónde quedan?', { partial: true })?.text).toContain('Carrera 7 # 33-42');
    expect(contactAnswer(k, '¿cuál es el horario?')).toBeNull(); // con modelo, lo responde el modelo
  });
  it('una respuesta del modelo que dice que algo no está publicado, con otra redacción, se acepta', () => {
    expect(isGrounded('En el sitio no aparece un WhatsApp publicado; puedes escribir al correo de contacto gerencia@demo.test o llamar a la línea de atención 604 607 4101.', k)).toBe(true);
    expect(isGrounded('No tenemos WhatsApp publicado en el sitio; puedes llamar a la línea de atención 604 607 4101 o escribir al correo de contacto.', k)).toBe(true);
  });
});

describe('revisión 5 (léxico amplio, nov. 2026): palabras que no son nombres y nombres que también son palabras', async () => {
  const { extractVisitorData } = await import('../src/services/visitorData');
  const { analyze } = await import('../src/services/intents');
  const { isCommonWord, FIRST_NAMES, SURNAMES } = await import('../src/services/lexicon');
  const asked = (m: string) => extractVisitorData(m, [], { asked: 'name' }).name;
  const handoff = (m: string, missing: Array<'name' | 'document' | 'portfolio'> = ['name', 'document']) => extractVisitorData(m, [], { asked: 'handoff', missing }).name;
  const free = (m: string) => extractVisitorData(m, [], { asked: null }).name;

  it('un apelativo después del saludo o del agradecimiento no es el nombre: es un cierre o un saludo', () => {
    for (const m of ['gracias linda', 'gracias, linda', 'listo linda', 'ok princesa', 'gracias mi reina', 'gracias cielo', 'gracias mami', 'gracias corazon', 'dale mona', 'gracias mi amor']) {
      expect(asked(m), m).toBeUndefined();
      expect(handoff(m), m).toBeUndefined();
    }
    expect(analyze('gracias linda').intent).toBe('thanks');
    expect(analyze('hola bella').intent).toBe('greeting');
    expect(asked('hola bella')).toBeUndefined();
    // El nombre dicho sí cuenta, aunque también sea un apelativo.
    expect(asked('me llamo Linda')).toBe('Linda');
    expect(asked('Linda')).toBe('Linda');
    expect(asked('soy Linda Caicedo')).toBe('Linda Caicedo');
    expect(asked('Cielo')).toBe('Cielo');
  });

  it('oficios, condiciones, meses y palabras sueltas no son el nombre', () => {
    for (const m of ['soy pescador', 'soy mayor de edad', 'soy infante de marina', 'soy policia', 'soy emprendedora', 'pescador', 'junio', 'mayo', 'mayo 15 te pago', 'largo', 'lindo', 'contacto', 'personal', 'laboral', 'familia', 'online', 'sumerce', 'mierda', 'respeten']) {
      expect(asked(m), m).toBeUndefined();
    }
    for (const w of ['laboral', 'policia', 'emprendedora', 'sumerce', 'comfandi', 'gratuita', 'remota']) expect(isCommonWord(w), w).toBe(true);
  });

  it('los nombres y apellidos que también son palabras siguen siendo nombres', () => {
    expect(asked('Lucero')).toBe('Lucero');
    expect(asked('Lucero Pérez 52123456')).toBe('Lucero Pérez');
    expect(asked('María del Tránsito Gómez')).toBe('María del Tránsito Gómez');
    expect(asked('Bautista Ramírez')).toBe('Bautista Ramírez');
    expect(handoff('esmeralda')).toBe('Esmeralda');
    expect(asked('Luz Mira')).toBe('Luz Mira');
    expect(free('Juan Aguilera 1020304050')).toBe('Juan Aguilera');
    expect(free('Carlos Herrero 1020304050')).toBe('Carlos Herrero');
    expect(free('Wilson Wilches 1020304051 general')).toBe('Wilson Wilches');
    // Apellidos muy frecuentes que también son palabras ("Cortés", "Peña", "Barrios"): no se pierden en minúscula.
    expect(asked('juan cortes quiero pagar')).toBe('Juan Cortes');
    expect(asked('ana pena')).toBe('Ana Pena');
    expect(asked('jhon barrios')).toBe('Jhon Barrios');
    for (const w of ['esmeralda', 'paloma', 'lucero', 'abril', 'darling', 'transito']) expect(FIRST_NAMES.has(w), w).toBe(true);
    for (const w of ['cadena', 'robles', 'segura', 'llanos', 'aguilera', 'wilches']) expect(SURNAMES.has(w), w).toBe(true);
  });

  it('un apellido que también es palabra no es el primer nombre: "soy herrero" no, "Juan Robles" sí', () => {
    expect(asked('soy herrero')).toBeUndefined();
    expect(asked('herrero')).toBeUndefined();
    expect(asked('robles')).toBeUndefined();
    expect(asked('Pedro Robles')).toBe('Pedro Robles');
    expect(asked('Ana Segura')).toBe('Ana Segura');
  });
});

describe('revisión 6 (verificación nov. 2026): groserías, nombres en -is, correcciones, carteras y asunto', async () => {
  const { extractVisitorData, namedPortfolios } = await import('../src/services/visitorData');
  const { analyze, announcesQuestion, cancelOf, COMMERCIAL_RE, isSensitive, mentionsCase, refusedFields } = await import('../src/services/intents');
  const { isComplaint, withoutUserPlace } = await import('../src/services/chat');
  const { subjectText } = await import('../src/services/liveChat');
  const asked = (m: string) => extractVisitorData(m, [], { asked: 'name' }).name;
  const handoff = (m: string, missing: Array<'name' | 'document' | 'portfolio'> = ['name', 'document']) => extractVisitorData(m, [], { asked: 'handoff', missing }).name;
  const free = (m: string) => extractVisitorData(m, [], { asked: null }).name;
  const P4 = [
    { key: 'general', name: 'General', aliases: [] }, { key: 'claro', name: 'Claro', aliases: [] },
    { key: 'flamingo', name: 'Flamingo', aliases: ['almacenes flamingo'] }, { key: 'offcorss', name: 'Offcorss', aliases: [] },
  ];

  it('una grosería o un apelativo en minúscula no es el nombre', () => {
    for (const m of ['gonorrea', 'hijueputa', 'idiota', 'Idiota', 'huevón', 'pirobo', 'princesa', 'reina', 'linda', 'bella', 'pastor']) expect(asked(m), m).toBeUndefined();
    expect(handoff('ya le dije mi nombre, idiota', ['name'])).toBeUndefined();
    expect(handoff('gonorrea 1020304050')).toBeUndefined();
    for (const m of ['Linda', 'Cielo', 'rosa']) expect(asked(m), m).toBeTruthy();
  });

  it('"soy" con un adjetivo, una creencia o un oficio no es el nombre; un nombre sí', () => {
    for (const m of ['soy pastor', 'soy cristiana', 'soy honesto', 'soy labrador', 'soy pastor de una iglesia, cc 1020304050']) expect(handoff(m, ['name']), m).toBeUndefined();
    for (const m of ['le soy franco, ya no tengo cómo pagar', 'te soy clara: no voy a pagar esa deuda', 'soy franco, no puedo pagar esa deuda', 'soy pastora de una iglesia y no tengo cómo pagar']) {
      expect(free(m), m).toBeUndefined();
    }
    expect(free('soy Franco, no puedo pagar')).toBe('Franco');
    expect(free('soy rosa y quiero un asesor')).toBe('Rosa');
    expect(handoff('Pastor Hernández 1020304050')).toBe('Pastor Hernández');
    expect(handoff('Reina Gómez 43567890')).toBe('Reina Gómez');
  });

  it('nombres costeños en -is, "Leida" y un apellido común con mayúscula se guardan', () => {
    expect(handoff('Yarlenis Pérez 43567890')).toBe('Yarlenis Pérez');
    expect(handoff('Leidys Gómez, cc 43567890')).toBe('Leidys Gómez');
    expect(handoff('Leida Ruiz 43567890')).toBe('Leida Ruiz');
    expect(asked('Yuranis')).toBe('Yuranis');
    expect(asked('gastritis')).toBeUndefined();
    expect(handoff('Carlos Alemán')).toBe('Carlos Alemán');
    // Una palabra común que no es un apellido conocido no se guarda como apellido (ronda 7: "Andrea Urgente", "Juan No").
    expect(handoff('Laura Prueba')).toBe('Laura');
    expect(extractVisitorData('Ana Claro 43567890', [], { asked: 'handoff', missing: ['name', 'document'], siteWords: new Set(['claro']) }).name).toBe('Ana');
    expect(asked('Rosa Elena Tarde')).toBe('Rosa Elena');
    expect(asked('Muchas gracias, Linda Tarde')).toBeUndefined();
  });

  it('el nombre de otra persona no es el del visitante; un apelativo o un saludo antes del nombre no lo tapan', () => {
    for (const m of ['Carlos Mora me dijo que les escribiera', 'la abogada Marta Gómez me pidió que me comunicara', 'Pedro Gómez el de cartera me llamó ayer',
      'Ana Ruiz es mi mamá, ella tiene la deuda', 'Jorge Pérez me recomendó este chat']) expect(handoff(m), m).toBeUndefined();
    expect(handoff('Juan Pérez quiero saber mi saldo')).toBe('Juan Pérez');
    expect(handoff('Juan Pérez es mi nombre')).toBe('Juan Pérez');
    for (const m of ['ok linda, Juan Pérez 1020304050', 'listo mi reina, Juan Pérez 1020304050', 'bueno princesa, Juan Pérez 1020304050']) expect(handoff(m), m).toBe('Juan Pérez');
    expect(asked('hola, ¿cómo estás? Luisa')).toBe('Luisa');
    expect(asked('buenas tardes, ¿cómo le va? Martha Gómez')).toBe('Martha Gómez');
    expect(asked('me dicen Toño')).toBe('Toño');
    expect(asked('nel, gracias')).toBeUndefined();
    expect(free('Ana López, mucho gusto')).toBe('Ana López');
  });

  it('corrige el nombre guardado ("Pedro no, Juan Gómez") y el documento sin decir "cédula"', () => {
    for (const m of ['Pedro no, Juan Gómez', 'no, Juan Gómez', 'no Pedro, Juan Gómez']) {
      const x = extractVisitorData(m, [], { asked: 'queue', missing: [], savedName: 'Pedro Gómez' });
      expect([x.name, x.nameExplicit], m).toEqual(['Juan Gómez', true]);
    }
    for (const m of ['el número correcto es 1020304051', '1020304051 es el correcto', 'ese número está mal, es 1020304051', 'error, es 1020304051',
      'lo escribí mal, es 1020304051', 'me faltó un número: 1020304051', 'mi número real es 1020304051', 'esa era la cédula vieja, la nueva es 1020304051']) {
      const x = extractVisitorData(m, [], { asked: 'handoff', missing: ['name'] });
      expect([x.document, x.documentExplicit], m).toEqual(['1020304051', true]);
    }
    expect(extractVisitorData('Luz Dary Cuesta 52111222', [], { asked: 'handoff', missing: ['name', 'document'] }).document).toBe('52111222');
  });

  it('carteras: "Claro y Flamingo" no se adivina, las marcas de pago y las correcciones con pausa cuentan', () => {
    const pf = (m: string, ctx: object) => { const x = extractVisitorData(m, P4, ctx); return [x.portfolioKey, !!x.correction]; };
    expect(pf('Claro y Flamingo', { asked: 'handoff', missing: ['portfolio'] })[0]).toBeUndefined();
    expect(pf('tengo una deuda con flamingo y otra con offcorss', { asked: null })[0]).toBeUndefined();
    for (const [m, key] of [['quiero un acuerdo de pago con flamingo', 'flamingo'], ['quiero negociar con Offcorss', 'offcorss'],
      ['necesito un paz y salvo de Offcorss', 'offcorss'], ['necesito pagarle a Flamingo', 'flamingo']]) expect(pf(m, { asked: null })[0], m).toBe(key);
    for (const [m, key] of [['no, la de Offcorss', 'offcorss'], ['no señor, es flamingo', 'flamingo'], ['Flamingo no, Offcorss', 'offcorss'], ['en realidad es de Offcorss', 'offcorss']]) {
      expect(pf(m, { asked: 'queue', missing: [] }), m).toEqual([key, true]);
    }
    expect(namedPortfolios('ni Flamingo ni Offcorss', P4)).toEqual({ list: [P4[2], P4[3]], negated: true });
  });

  it('intenciones: pedidos de asesor, preguntas anunciadas, cierres, cancelaciones y negativas', () => {
    expect(analyze('un asesor, no un robot').intent).toBe('human');
    expect(analyze('me atiende un asesor, por favor').intent).toBe('human');
    expect(analyze('¿me atiende un asesor? ¿cuál es el correo?').intent).toBe('identity');
    expect(analyze('no quiero que me llamen, prefiero que me escriban por aquí').intent).toBe('human');
    for (const m of ['quiero preguntar algo primero', 'antes quiero preguntar algo', 'quisiera saber otra cosa', 'hola, gracias por atenderme, tengo una pregunta']) {
      expect(announcesQuestion(m), m).toBe(true);
    }
    expect(announcesQuestion('quiero saber el horario')).toBe(false);
    for (const m of ['gracias, con eso tengo', 'gracias, ya tengo la información', 'listo, con eso me basta']) expect(analyze(m).intent, m).toBe('thanks');
    expect(cancelOf('no gracias, ya me ayudaste')).toEqual({ cancel: true, question: false });
    expect(cancelOf('olvídalo, ¿cuál es el correo?')).toEqual({ cancel: true, question: true });
    expect(cancelOf('no gracias, después escribo').cancel).toBe(true);
    expect(cancelOf('luego te paso la cédula').cancel).toBe(false);
    for (const m of ['eso no te incumbe', 'y a ti qué te importa', 'no tengo por qué decirte', 'qué le importa', 'flamingo u offcorss, no sé']) expect(refusedFields(m), m).toBe('all');
    expect(isSensitive('me llamo pedro tienen abogados')).toBe(false);
    expect(isSensitive('me llamo pedro y tengo una deuda')).toBe(true);
    expect(isSensitive('cual es el telefono para hacer un acuerdo de pago')).toBe(false);
    expect(isSensitive('compre en flamingo y debo unas cuotas')).toBe(true);
    expect(COMMERCIAL_RE.test('me pueden contratar')).toBe(false);
    expect(mentionsCase('soy pensionada y me descuentan de la mesada')).toBe(true);
    expect(isComplaint('la asesora fue grosera conmigo')).toBe(true);
    expect(withoutUserPlace('soy de cali donde quedan')).toBe('donde quedan');
  });

  it('el asunto no lleva el nombre ni el documento en ninguna posición, ni conectores sueltos', () => {
    expect(subjectText('buenas tardes, mi nombre es Carlos Ruiz identificado con cedula 1.036.456.789 y quiero saber cuanto debo', { name: 'Carlos Ruiz', document: '1036456789' })).toBe('quiero saber cuanto debo');
    expect(subjectText('Soy Carlos Ruiz y mi cédula es 1020304050, ¿cuánto debo?', { name: 'Carlos Ruiz', document: '1020304050' })).toBe('¿cuánto debo?');
    expect(subjectText('quiero un acuerdo de pago con flamingo, me llamo Luis Torres y mi cc es 79.456.123', { name: 'Luis Torres', document: '79456123' })).toBe('quiero un acuerdo de pago con flamingo');
    expect(subjectText('somos una empresa con NIT 900.123.456-7 y queremos contratar el servicio de cobranza', { document: '9001234567' })).toBe('somos una empresa y queremos contratar el servicio de cobranza');
    expect(subjectText('Buenas tardes, soy Laura de Bancolombia, queremos cotizar el servicio de cobranza', { name: 'Laura' })).toBe('Bancolombia: queremos cotizar el servicio de cobranza');
    expect(subjectText('que es el call center?', {})).toBe('que es el call center?');
    expect(subjectText('Juan Pérez 1020304050', { name: 'Juan Pérez', document: '1020304050' })).toBe('');
  });
});

describe('revisión 7 (verificación nov. 2026): diccionario, apodos, correcciones, carteras ofrecidas e intenciones', async () => {
  const { extractVisitorData, offeredPortfolios } = await import('../src/services/visitorData');
  const { acceptsOffer, analyze, cancelOf, isHold, isRefuse, isWaitQuestion, looksLikeQuestion, yesNo } = await import('../src/services/intents');
  const { isSpanishWord } = await import('../src/services/spanishWords');
  const { subjectText } = await import('../src/services/liveChat');
  const asked = (m: string) => extractVisitorData(m, [], { asked: 'name' }).name;
  const handoff = (m: string, missing: Array<'name' | 'document' | 'portfolio'> = ['name', 'document']) => extractVisitorData(m, [], { asked: 'handoff', missing }).name;
  const P4 = [
    { key: 'general', name: 'General', aliases: [] }, { key: 'claro', name: 'Claro', aliases: [] },
    { key: 'flamingo', name: 'Flamingo', aliases: ['almacenes flamingo'] }, { key: 'offcorss', name: 'Offcorss', aliases: [] },
  ];

  it('una palabra del idioma no es un nombre poco común; los nombres conocidos y los raros sí', () => {
    expect(isSpanishWord('burro')).toBe(true);
    expect(isSpanishWord('yeison')).toBe(false);
    for (const m of ['burro', 'bestia', 'actriz', 'musulmán', 'parálisis', 'diálisis', 'graxis', 'gamín', 'rico', 'soy ateo', 'soy judía']) expect(asked(m), m).toBeUndefined();
    for (const m of ['soy pastora', 'soy franco', 'soy clara', 'ya le dije mi nombre, burro']) expect(handoff(m, ['name']), m).toBeUndefined();
    for (const [m, name] of [['wilmar', 'Wilmar'], ['Duberney', 'Duberney'], ['Yarlenis', 'Yarlenis'], ['me dicen Toño', 'Toño'], ['Linda', 'Linda'], ['Bella', 'Bella'], ['soy Clara', 'Clara']]) {
      expect(asked(m), m).toBe(name);
    }
  });

  it('tras el nombre, una palabra común no es el apellido; un apellido conocido sí', () => {
    for (const [m, name] of [['Andrea Urgente', 'Andrea'], ['Juan No', 'Juan'], ['María Deuda', 'María'], ['Luisa Atentamente', 'Luisa'], ['Laura Mora', 'Laura Mora'], ['Ana Zuleta', 'Ana Zuleta']]) {
      expect(handoff(m, ['name']), m).toBe(name);
    }
  });

  it('el nombre con un verbo en plural es del visitante; un apodo no reemplaza el nombre', () => {
    for (const m of ['Juan Pérez me llamaron por una deuda', 'Juan Pérez me dijeron que les escribiera por aquí', 'Juan Pérez el de la deuda', 'buenas tardes, Juan Pérez quien le escribe']) {
      expect(handoff(m), m).toBe('Juan Pérez');
    }
    expect(handoff('Pedro Gómez el de cartera me llamó ayer')).toBeUndefined();
    expect(handoff('eso está mal, Pedro Gómez no soy yo')).toBeUndefined();
    expect(handoff('soy Carlos Gómez y me dicen Pacho')).toBe('Carlos Gómez');
    expect(extractVisitorData('me dicen Toño', [], { asked: 'queue', missing: ['document'], savedName: 'Juan Pérez' }).nameExplicit).toBe(false);
  });

  it('un monto en una corrección no reemplaza la cédula; "es X, no Y" y "no es ese número" sí la corrigen', () => {
    const doc = (m: string) => { const x = extractVisitorData(m, [], { asked: 'queue', missing: [] }); return [x.document, x.documentExplicit, x.phone]; };
    for (const m of ['la cuota está mal, es de 250000', 'en realidad es 1200000 lo que me cobran', 'me dijeron que debía 1500000, no era 1500000 sino 1200000']) {
      expect(doc(m)[0], m).toBeUndefined();
    }
    expect(doc('no es ese número, es 1020304051')).toEqual(['1020304051', true, undefined]);
    expect(doc('es 1020304051, no 1020304050')).toEqual(['1020304051', true, undefined]);
    expect(doc('corrige el número: 1020304051')).toEqual(['1020304051', true, undefined]);
  });

  it('corrige el nombre en cualquier orden y con el documento al final', () => {
    const swap = (m: string, saved: string) => extractVisitorData(m, [], { asked: 'handoff', missing: ['document'], savedName: saved }).name;
    expect(swap('Juan Gómez, no Pedro', 'Pedro Gómez')).toBe('Juan Gómez');
    expect(swap('no, Juan', 'Pedro Gómez')).toBe('Juan');
    expect(swap('no, Ana Rojas 43123456', 'Ana Ruiz')).toBe('Ana Rojas');
    expect(swap('lo escribí mal, es Juan Pérez', 'Juan Peres')).toBe('Juan Pérez');
    expect(swap('no, gracias', 'Pedro Gómez')).toBeUndefined();
  });

  it('tras la oferta, "sí, Juan Pérez" o "claro, me llamo Pedro" aceptan y dan el nombre', () => {
    const offer = (m: string) => extractVisitorData(m, [], { asked: 'offer', missing: ['name', 'document'] }).name;
    for (const [m, name] of [['sí, Juan Pérez', 'Juan Pérez'], ['claro, me llamo Pedro Pérez', 'Pedro Pérez'], ['hágale, Pedro Gómez', 'Pedro Gómez'], ['Pedro, sí', 'Pedro'],
      ['Simón Bolívar 1020304050', 'Simón Bolívar']]) {
      expect(offer(m), m).toBe(name);
    }
    for (const m of ['claro, me llamo Pedro', 'dale, soy Pedro Gómez', 'me llamo Pedro y sí quiero', 'claro, con gusto']) expect(acceptsOffer(m), m).toBe(true);
    for (const m of ['ok, gracias', 'no gracias, soy Pedro', 'gracias']) expect(acceptsOffer(m), m).toBe(false);
    expect(extractVisitorData('sí, Juan Pérez 1020304050 flamingo', P4, { asked: 'offer', missing: ['name', 'document', 'portfolio'] }).portfolioKey).toBe('flamingo');
    expect(yesNo('claro, con mucho gusto')).toBe('yes');
  });

  it('las carteras que el bot acaba de ofrecer: la respuesta se lee entre ellas', () => {
    expect(offeredPortfolios('Entendido, no es Flamingo. ¿Es de General, Claro u Offcorss? Si no estás seguro, el asesor lo confirma contigo.', P4).list.map((p) => p.key))
      .toEqual(['general', 'claro', 'offcorss']);
    const pk = (m: string, ctx: object) => extractVisitorData(m, P4, ctx).portfolioKey;
    expect(pk('de Claro', { asked: 'queue', missing: ['portfolio'], offered: ['general', 'claro', 'offcorss'] })).toBe('claro');
    expect(pk('claro', { asked: 'handoff', missing: ['portfolio'], offered: ['general'] })).toBeUndefined();
    expect(pk('claro, con flamingo', { asked: 'handoff', missing: ['portfolio'] })).toBe('flamingo');
    expect(pk('claro', { asked: 'handoff', missing: ['name', 'document', 'portfolio'] })).toBeUndefined();
  });

  it('se presenta sin que se lo pidan: "Ana López, mucho gusto. Tengo una deuda…" y "hola, ¿cómo estás? Luisa"', () => {
    const free = (m: string) => extractVisitorData(m, [], { asked: null }).name;
    expect(free('Ana López, mucho gusto. Tengo una deuda con ustedes')).toBe('Ana López');
    expect(free('hola, ¿cómo estás? Luisa')).toBe('Luisa');
    expect(free('hola, ¿qué servicios tienen? Pedro')).toBeUndefined();
  });

  it('intenciones: "no sé si…" no es negarse, "¿ya me atendieron?" no cancela, esperas y quejas cortas', () => {
    for (const m of ['no sé si es con ustedes, me llegó un mensaje de cobro', 'a ustedes no les importa nada', 'me están cobrando y no sé']) expect(isRefuse(m), m).toBe(false);
    for (const m of ['eso no te incumbe', 'Flamingo u Offcorss, no sé', 'mi nombre no te importa']) expect(isRefuse(m), m).toBe(true);
    expect(cancelOf('¿ya me atendieron?', { waiting: true }).cancel).toBe(false);
    expect(isWaitQuestion('¿ya me atendieron?')).toBe(true);
    expect(cancelOf('Ana Ruiz 43123456, si no me atienden hoy mañana vuelvo', { hasData: true }).cancel).toBe(false);
    expect(cancelOf('espera, luego miro y te digo').cancel).toBe(false);
    expect(cancelOf('asesor no, por favor').cancel).toBe(true);
    for (const m of ['espera, luego miro y te digo', 'luego te paso la cédula', 'más tarde te escribo con los datos']) expect(isHold(m), m).toBe(true);
    for (const m of ['la asesora fue grosera', 'asesora grosera', 'el asesor muy grosero']) expect(analyze(m).intent, m).not.toBe('human');
    for (const m of ['asesor de flamingo', 'el asesor me colgó, quiero hablar con otro', 'otro asesor por favor, el anterior no me ayudó']) expect(analyze(m).intent, m).toBe('human');
    expect(analyze('necesito el número de mi deuda para pagar').intent).toBe('sensitive');
    for (const m of ['Ana Ruiz 43123456, cuando puedan', 'Juan Pérez, como usted diga', 'cuanto antes por favor']) expect(looksLikeQuestion(m), m).toBe(false);
    expect(analyze('después te escribo').intent).toBe('thanks');
  });

  it('verificación 7: nombres en -is, nombres que son palabras, montos, negativas y coletillas', () => {
    expect(handoff('Marlenis Pérez 1020304050')).toBe('Marlenis Pérez');
    expect(handoff('Yesenis Palacios 43123456')).toBe('Yesenis Palacios');
    expect(asked('Yuledis')).toBe('Yuledis');
    expect(asked('graxis')).toBeUndefined();
    for (const [m, name] of [['me llamo Lisa', 'Lisa'], ['Junior Pérez 1020304050', 'Junior Pérez'], ['Pío Martínez 1020304050', 'Pío Martínez'], ['Ana Madera', 'Ana Madera']]) {
      expect(handoff(m), m).toBe(name);
    }
    for (const m of ['Mía', 'Amapola', 'Hola, ¿cómo estás? Luisa']) expect(extractVisitorData(m, [], { asked: m.startsWith('Hola') ? null : 'name' }).name, m).toBeTruthy();
    expect(handoff('me llamo burro')).toBeUndefined();
    expect(extractVisitorData('Carlos Ruiz 1020304050', [], { asked: 'handoff', missing: ['document'], savedName: 'Carlos' }).name).toBe('Carlos Ruiz');
    const doc = (m: string) => extractVisitorData(m, [], { asked: 'handoff', missing: ['name'] }).document;
    expect(doc('perdón, debe ser 1020304051')).toBe('1020304051');
    expect(doc('me equivoqué, es 1020304051, es para pagar la deuda')).toBe('1020304051');
    expect(doc('la cuota está mal, es de 250000')).toBeUndefined();
    expect(cancelOf('¿y el asesor no? por favor', { waiting: true }).cancel).toBe(false);
    expect(cancelOf('me pasas con un asesor, ¿no?, por favor').cancel).toBe(false);
    expect(isHold('no te doy mi cédula')).toBe(false);
    expect(isRefuse('no te paso mis datos')).toBe(true);
    expect(isRefuse('no le importa a nadie mi caso')).toBe(false);
    expect(isWaitQuestion('¿todavía no me atendieron?')).toBe(true);
    expect(analyze('¿pueden pasarme con otro número?').intent).not.toBe('human');
    expect(analyze('el asesor fue grosero, quiero que me atienda otro').intent).toBe('human');
    expect(acceptsOffer('sí, no hay problema')).toBe(true);
  });

  it('el asunto pierde el nombre en cualquier posición y no toma una ciudad por empresa', () => {
    expect(subjectText('tengo una deuda con ustedes, Ana Ruiz 43567890', { name: 'Ana Ruiz', document: '43567890' })).toBe('tengo una deuda con ustedes');
    expect(subjectText('buenas tardes, yo soy Ana Gómez y necesito un paz y salvo, cc 43123456', { name: 'Ana Gómez', document: '43123456' })).toBe('necesito un paz y salvo');
    expect(subjectText('necesito un acuerdo de pago, soy la señora Gloria Ruiz, cédula 43123456', { name: 'Gloria Ruiz', document: '43123456' })).toBe('necesito un acuerdo de pago');
    expect(subjectText('necesito un paz y salvo Juan Pérez 1020304050', { name: 'Juan Pérez', document: '1020304050' })).toBe('necesito un paz y salvo');
    expect(subjectText('Hola, soy Ana de Cali, ¿dónde quedan?', { name: 'Ana' })).toBe('de Cali, ¿dónde quedan?');
    expect(subjectText('la deuda está a nombre de mi mamá, Rosa Díaz, cc 43567890', { document: '43567890' })).toBe('la deuda está a nombre de mi mamá, Rosa Díaz');
  });
});
