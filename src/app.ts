import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import type { AppDeps } from './app-types';
import { errorHandler, limiter, notFoundHandler } from './middleware/security';
import { adminRouter, publicRouter } from './routes';
import { createLlmBudget } from './services/llmBudget';
import { createPublicCache } from './services/publicCache';
import { createWebhookPoster, createWebhookService, type WebhookPoster } from './services/webhook';

export const ADMIN_DIST = path.resolve(__dirname, '..', 'admin', 'dist');

export function createApp(input: Omit<AppDeps, 'cache' | 'budget' | 'webhook'> & { webhookPoster?: WebhookPoster }) {
  const { webhookPoster, ...rest } = input;
  const deps: AppDeps = {
    ...rest,
    cache: createPublicCache(input.cfg),
    budget: createLlmBudget(input.db, input.cfg),
    webhook: createWebhookService(input.db, webhookPoster ?? createWebhookPoster(input.cfg)),
  };
  const { cfg, db } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts: cfg.isProd,
      // En http://localhost el navegador no debe forzar https en las peticiones del panel.
      contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': cfg.isProd ? [] : null } },
    }),
  );

  app.get('/health', async (_req, res) => {
    let dbOk = true;
    try {
      await db.query('SELECT 1');
    } catch {
      dbOk = false;
    }
    res.json({ status: dbOk ? 'ok' : 'degraded', db: dbOk ? 'up' : 'down', time: new Date().toISOString() });
  });

  app.use('/api', limiter(cfg.rate.windowMs, cfg.rate.general), express.json({ limit: `${cfg.bodyLimitKb}kb` }));
  app.use('/api/v1/public', publicRouter(deps));
  app.use('/api/v1/admin', adminRouter(deps));
  app.use('/api', notFoundHandler);

  if (cfg.serveAdmin) {
    if (!existsSync(path.join(ADMIN_DIST, 'index.html'))) {
      console.warn('[admin] admin/dist no existe; ejecuta "npm run build". /admin no estará disponible.');
    } else {
      app.use('/admin', express.static(ADMIN_DIST, { index: false, redirect: false, maxAge: '1y', immutable: true }));
      app.get(/^\/admin(\/.*)?$/, (_req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(ADMIN_DIST, 'index.html'));
      });
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
