import { loadConfig } from '../config/env';
import { createPgDb } from '../db';
import { runMigrations } from '../db/migrate';

async function main() {
  const cfg = loadConfig();
  const db = createPgDb(cfg.databaseUrl);
  try {
    const r = await runMigrations(db);
    console.log(`Migraciones aplicadas: ${r.applied.length ? r.applied.join(', ') : '(ninguna)'}`);
    console.log(`Ya aplicadas: ${r.skipped.length}`);
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  console.error('Error en migración:', e.message);
  process.exit(1);
});
