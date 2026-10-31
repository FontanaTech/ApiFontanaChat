import { createApp } from './app';
import { loadConfig } from './config/env';
import { createPgDb } from './db';
import { createContentFetcher } from './services/contentSync';
import { listCompanies } from './models/companies';
import { warmUpChat } from './services/chat';
import { createLlmClient } from './services/llm';
import type { LiveBus } from './services/liveEvents';
import { attachLiveWebSocket } from './services/liveWebSocket';

let cfg: ReturnType<typeof loadConfig>;
let db: ReturnType<typeof createPgDb>;
try {
  cfg = loadConfig();
  db = createPgDb(cfg.databaseUrl);
} catch (e: any) {
  console.error(`No se pudo iniciar: ${e.message}`);
  process.exit(1);
}
const llm = createLlmClient(cfg);
const app = createApp({
  cfg,
  db,
  llm,
  contentFetcher: createContentFetcher(cfg),
});

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`API escuchando en http://${cfg.host}:${cfg.port} (${cfg.env})`);
  // Solo Ollama necesita precalentarse (carga el modelo en memoria); un proveedor alojado responde de inmediato.
  if (cfg.llmProvider === 'ollama' && cfg.llmEnabled) void warmUp();
});
const liveWebSocket = attachLiveWebSocket(server, { cfg, db, live: app.locals.live as LiveBus });

/** Carga el modelo en memoria con el contenido de cada empresa, para que la primera pregunta real no espere ~20 s. */
async function warmUp() {
  try {
    const chatDeps = { db, llm, contextMaxChars: cfg.chatContextMaxChars, fastScore: cfg.chatFastScore };
    for (const c of await listCompanies(db)) if (c.active && c.content_status === 'ok') await warmUpChat(chatDeps, c);
    console.log('Modelo de chat precalentado');
  } catch (e: any) {
    console.warn(`No se pudo precalentar el modelo: ${e.message}`);
  }
}

async function shutdown(signal: string) {
  console.log(`${signal} recibido, cerrando...`);
  liveWebSocket.close();
  (app.locals.live as LiveBus).closeAll(); // las conexiones abiertas impedirían cerrar el servidor
  server.close(async () => {
    await db.close().catch(() => undefined);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
