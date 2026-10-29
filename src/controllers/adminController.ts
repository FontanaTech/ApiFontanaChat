import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app-types';
import type { Queryable } from '../db';
import * as admins from '../models/admins';
import * as audit from '../models/audit';
import * as catalog from '../models/catalog';
import * as companies from '../models/companies';
import * as origins from '../models/origins';
import * as portfolios from '../models/portfolios';
import * as usage from '../models/usage';
import * as pub from '../models/public';
import { badRequest, forbidden, notFound } from '../utils/errors';
import * as v from '../validation/schemas';
import { hashPassword } from '../services/password';
import { syncCompanyContent } from '../services/contentSync';
import { eligibleRecipients } from '../services/assignment';
import { warmUpChat } from '../services/chat';
import { getCompanyContent } from '../models/companies';
import { generateWebhookSecret, validateWebhookUrl } from '../services/webhook';

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Datos inválidos', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

function parseRange(query: unknown) {
  const q = parse(v.rangeQuery, query);
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400_000);
  if (Number.isNaN(+from) || Number.isNaN(+to)) throw badRequest('Fechas inválidas');
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) to.setUTCDate(to.getUTCDate() + 1); // día completo inclusive
  else if (!q.to) to.setTime(to.getTime() + 1000);
  return { from, to, limit: q.limit, offset: q.offset };
}

export function adminController(deps: AppDeps) {
  const { db } = deps;

  /** Ejecuta una mutación y su registro de auditoría en la misma transacción. */
  async function audited<T extends { id?: string }>(
    req: Request,
    meta: { companyId: string | null | 'self'; entity: string; action: string },
    fn: (q: Queryable) => Promise<{ before?: unknown; after: T }>,
  ): Promise<T> {
    return db.tx(async (q) => {
      const { before, after } = await fn(q);
      await audit.recordAudit(q, {
        adminId: req.admin!.id, companyId: meta.companyId === 'self' ? ((after as any).id as string) : meta.companyId, action: meta.action, entity: meta.entity,
        entityId: (after as any)?.id ?? null, before, after, ip: req.ip,
      });
      return after;
    }).then((after) => {
      if (meta.entity === 'company' || meta.entity === 'origin') deps.cache.clear();
      return after;
    });
  }
  const cid = (req: Request) => req.companyId!;
  const id = (req: Request, name = 'id') => {
    const x = String(req.params[name]);
    if (!/^[0-9a-f-]{36}$/i.test(x)) throw notFound();
    return x;
  };
  const must = <T>(x: T | null | undefined, msg = 'No encontrado'): T => {
    if (x == null) throw notFound(msg);
    return x;
  };

  return {
    /* ---------- administradores (solo superadmin) ---------- */
    listAdmins: async (_req: Request, res: Response) => res.json({ items: await admins.listAdmins(db) }),
    async createAdmin(req: Request, res: Response) {
      const b = parse(v.createAdminBody, req.body);
      if (b.companyId) must(await companies.getCompany(db, b.companyId), 'Empresa no encontrada');
      const hash = await hashPassword(b.password);
      const a = await audited(req, { companyId: b.companyId ?? null, entity: 'admin', action: 'create' }, async (q) => ({
        after: await admins.createAdmin(q, { email: b.email, name: b.name, passwordHash: hash, role: b.role, companyId: b.companyId ?? null }),
      }));
      res.status(201).json(a);
    },
    async updateAdmin(req: Request, res: Response) {
      const b = parse(v.updateAdminBody, req.body);
      const target = id(req);
      const hash = b.password ? await hashPassword(b.password) : undefined;
      const a = await audited(req, { companyId: null, entity: 'admin', action: b.active === false ? 'deactivate' : 'update' }, async (q) => {
        const before = must(await admins.getAdmin(q, target));
        const after = must(await admins.updateAdmin(q, target, { name: b.name, active: b.active, passwordHash: hash }));
        if (hash || b.active === false) await admins.revokeAllAdminSessions(q, target);
        return { before, after };
      });
      res.json(a);
    },

    /* ---------- empresas ---------- */
    async listCompanies(req: Request, res: Response) {
      const a = req.admin!;
      res.json({ items: await companies.listCompanies(db, a.role === 'superadmin' ? undefined : a.company_id!) });
    },
    async createCompany(req: Request, res: Response) {
      const b = parse(v.createCompanyBody, req.body);
      const c = await audited(req, { companyId: 'self', entity: 'company', action: 'create' }, async (q) => {
        const company = await companies.createCompany(q, { slug: b.slug, name: b.name, contentUrl: b.contentUrl });
        for (const o of b.origins ?? []) await origins.createOrigin(q, company.id, o);
        // Toda empresa nace con una cartera por defecto; los teléfonos nuevos van a ella hasta que se creen las demás.
        await portfolios.createPortfolio(q, company.id, { key: 'general', name: 'General', description: 'Cartera por defecto', isDefault: true });
        return { after: company };
      });
      res.status(201).json(c);
    },
    async getCompany(req: Request, res: Response) {
      res.json(must(await companies.getCompany(db, cid(req))));
    },
    async updateCompany(req: Request, res: Response) {
      const b = parse(v.updateCompanyBody, req.body);
      const webhookChange = b.webhookUrl !== undefined || b.regenerateWebhookSecret !== undefined;
      if (req.admin!.role !== 'superadmin' && (b.slug !== undefined || b.active !== undefined || b.llmDailyTokens !== undefined || webhookChange)) {
        throw forbidden('Solo un superadmin puede cambiar el slug, el estado, el límite de IA ni el webhook de la empresa');
      }
      let webhookSecret: string | undefined; // solo se devuelve en el momento en que se genera
      let webhookUrl: string | null | undefined;
      if (b.webhookUrl) {
        try {
          webhookUrl = validateWebhookUrl(b.webhookUrl, deps.cfg.allowLocalContentUrls);
        } catch (e: any) {
          throw badRequest(e.message);
        }
      }
      const c = await audited(req, { companyId: cid(req), entity: 'company', action: b.active === false ? 'deactivate' : 'update' }, async (q) => {
        const before = must(await companies.getCompany(q, cid(req)));
        let after = must(await companies.updateCompany(q, cid(req), b));
        if (webhookChange) {
          const url = b.webhookUrl === undefined ? before.webhook_url : (webhookUrl ?? null);
          if (!url) {
            if (b.regenerateWebhookSecret) throw badRequest('Primero configura la URL del webhook');
            after = must(await companies.setWebhook(q, cid(req), { url: null }));
          } else {
            if (!before.webhook_secret_set || b.regenerateWebhookSecret) webhookSecret = generateWebhookSecret();
            after = must(await companies.setWebhook(q, cid(req), { url, secret: webhookSecret }));
          }
        }
        return { before, after };
      });
      res.json(webhookSecret ? { ...c, webhookSecret } : c);
    },
    async syncContent(req: Request, res: Response) {
      const company = must(await companies.getCompany(db, cid(req)));
      const out = await syncCompanyContent(db, deps.cfg, deps.contentFetcher, company);
      deps.cache.clear();
      if (out.ok && deps.cfg.llmProvider === 'ollama' && deps.cfg.llmEnabled) {
        const chatDeps = { db, llm: deps.llm, contextMaxChars: deps.cfg.chatContextMaxChars, fastScore: deps.cfg.chatFastScore };
        void warmUpChat(chatDeps, out.company); // en segundo plano: no retrasa la respuesta del panel
      }
      await audit.recordAudit(db, {
        adminId: req.admin!.id, companyId: company.id, action: 'sync', entity: 'content', entityId: company.id,
        before: { hash: company.content_hash }, after: { ok: out.ok, error: out.error, hash: out.company.content_hash }, ip: req.ip,
      });
      res.status(out.ok ? 200 : 422).json({ ok: out.ok, error: out.error, company: out.company });
    },
    /** Consumo del modelo de IA: hoy, últimos 14 días y límites (empresa y global). */
    async llmUsage(req: Request, res: Response) {
      const company = must(await companies.getCompany(db, cid(req)));
      const day = deps.budget.today();
      const [days, allToday] = await Promise.all([usage.usageHistory(db, company.id, 14), usage.usageForDay(db, day)]);
      const t = days.find((d) => d.day === day);
      res.json({
        enabled: deps.cfg.llmEnabled,
        provider: deps.cfg.llmProvider,
        model: deps.cfg.llmProvider === 'openai' ? deps.cfg.llmModel : deps.cfg.ollamaModel,
        today: { requests: t?.requests ?? 0, tokens: t?.tokens ?? 0 },
        dailyLimit: company.llm_daily_tokens,
        globalLimit: deps.cfg.llmDailyTokenLimit > 0 ? deps.cfg.llmDailyTokenLimit : null,
        globalToday: allToday.reduce((n, r) => n + r.tokens, 0),
        days,
      });
    },
    /** Envía un evento `test` firmado al webhook de la empresa y devuelve el resultado. */
    async testWebhook(req: Request, res: Response) {
      if (req.admin!.role !== 'superadmin') throw forbidden('Solo un superadmin puede probar el webhook');
      const company = must(await companies.getCompany(db, cid(req)));
      if (!company.webhook_url) throw badRequest('La empresa no tiene un webhook configurado');
      const r = await deps.webhook.test(company);
      res.status(r.ok ? 200 : 422).json(r);
    },
    async contentSummary(req: Request, res: Response) {
      const json = (await getCompanyContent(db, cid(req))) as v.ChatbotContent | null;
      res.json({ sections: (json?.sections ?? []).map((s) => ({ slug: s.slug, title: s.title, route: s.route, chars: s.text.length })) });
    },

    /* ---------- orígenes ---------- */
    async listOrigins(req: Request, res: Response) {
      res.json({ items: await origins.listOrigins(db, cid(req)) });
    },
    async createOrigin(req: Request, res: Response) {
      const b = parse(v.createOriginBody, req.body);
      res.status(201).json(await audited(req, { companyId: cid(req), entity: 'origin', action: 'create' }, async (q) => ({
        after: await origins.createOrigin(q, cid(req), b.origin),
      })));
    },
    async setOriginActive(req: Request, res: Response) {
      const b = parse(v.activeBody, req.body);
      res.json(await audited(req, { companyId: cid(req), entity: 'origin', action: b.active ? 'update' : 'deactivate' }, async (q) => ({
        before: must(await origins.getOrigin(q, cid(req), id(req))),
        after: must(await origins.setOriginActive(q, cid(req), id(req), b.active)),
      })));
    },

    async deleteOrigin(req: Request, res: Response) {
      await audited(req, { companyId: cid(req), entity: 'origin', action: 'delete' }, async (q) => {
        const before = must(await origins.getOrigin(q, cid(req), id(req)));
        await origins.deleteOrigin(q, cid(req), before.id);
        return { before, after: { id: before.id } };
      });
      res.status(204).end();
    },

    /* ---------- asesores y teléfonos ---------- */
    async listAdvisors(req: Request, res: Response) {
      const [advisors, phones] = await Promise.all([catalog.listAdvisors(db, cid(req)), catalog.listPhones(db, cid(req))]);
      res.json({ items: advisors.map((a) => ({ ...a, phones: phones.filter((p) => p.advisor_id === a.id) })) });
    },
    async createAdvisor(req: Request, res: Response) {
      const b = parse(v.createAdvisorBody, req.body);
      res.status(201).json(await audited(req, { companyId: cid(req), entity: 'advisor', action: 'create' }, async (q) => ({
        after: await catalog.createAdvisor(q, cid(req), b.name),
      })));
    },
    async updateAdvisor(req: Request, res: Response) {
      const b = parse(v.updateAdvisorBody, req.body);
      res.json(await audited(req, { companyId: cid(req), entity: 'advisor', action: b.active === false ? 'deactivate' : 'update' }, async (q) => ({
        before: must(await catalog.getAdvisor(q, cid(req), id(req))),
        after: must(await catalog.updateAdvisor(q, cid(req), id(req), b)),
      })));
    },
    async createPhone(req: Request, res: Response) {
      const b = parse(v.createPhoneBody, req.body);
      res.status(201).json(await audited(req, { companyId: cid(req), entity: 'phone', action: 'create' }, async (q) => {
        must(await catalog.getAdvisor(q, cid(req), b.advisorId), 'Asesor no encontrado en esta empresa');
        let portfolioId = b.portfolioId ?? null;
        if (portfolioId) must(await portfolios.getPortfolio(q, cid(req), portfolioId), 'Cartera no encontrada en esta empresa');
        else portfolioId = (await portfolios.getDefaultPortfolio(q, cid(req)))?.id ?? null;
        return { after: await catalog.createPhone(q, cid(req), { ...b, portfolioId }) };
      }));
    },
    async updatePhone(req: Request, res: Response) {
      const b = parse(v.updatePhoneBody, req.body);
      res.json(await audited(req, { companyId: cid(req), entity: 'phone', action: b.active === false ? 'deactivate' : 'update' }, async (q) => {
        const before = must(await catalog.getPhone(q, cid(req), id(req)));
        if (b.portfolioId) must(await portfolios.getPortfolio(q, cid(req), b.portfolioId), 'Cartera no encontrada en esta empresa');
        return { before, after: must(await catalog.updatePhone(q, cid(req), id(req), b)) };
      }));
    },

    async deletePhone(req: Request, res: Response) {
      await audited(req, { companyId: cid(req), entity: 'phone', action: 'delete' }, async (q) => {
        const before = must(await catalog.getPhone(q, cid(req), id(req)));
        await catalog.deletePhone(q, cid(req), before);
        return { before, after: { id: before.id } };
      });
      res.status(204).end();
    },

    /* ---------- carteras ---------- */
    async listPortfolios(req: Request, res: Response) {
      res.json({ items: await portfolios.listPortfolios(db, cid(req)) });
    },
    async createPortfolio(req: Request, res: Response) {
      const b = parse(v.createPortfolioBody, req.body);
      res.status(201).json(await audited(req, { companyId: cid(req), entity: 'portfolio', action: 'create' }, async (q) => ({
        after: await portfolios.createPortfolio(q, cid(req), b),
      })));
    },
    async updatePortfolio(req: Request, res: Response) {
      const b = parse(v.updatePortfolioBody, req.body);
      res.json(await audited(req, { companyId: cid(req), entity: 'portfolio', action: b.active === false ? 'deactivate' : 'update' }, async (q) => {
        const before = must(await portfolios.getPortfolio(q, cid(req), id(req)));
        if (b.active === false && before.is_default) {
          throw badRequest('La cartera por defecto no se puede desactivar: primero elige otra como por defecto.');
        }
        return { before, after: must(await portfolios.updatePortfolio(q, cid(req), id(req), b)) };
      }));
    },

    /* ---------- botones ---------- */
    async listButtons(req: Request, res: Response) {
      res.json({ items: await catalog.listButtons(db, cid(req)) });
    },
    async createButton(req: Request, res: Response) {
      const b = parse(v.createButtonBody, req.body);
      res.status(201).json(await audited(req, { companyId: cid(req), entity: 'button', action: 'create' }, async (q) => {
        if (b.advisorId) must(await catalog.getAdvisor(q, cid(req), b.advisorId), 'Asesor no encontrado en esta empresa');
        if (b.portfolioId) must(await portfolios.getPortfolio(q, cid(req), b.portfolioId), 'Cartera no encontrada en esta empresa');
        return { after: await catalog.createButton(q, cid(req), b) };
      }));
    },
    async updateButton(req: Request, res: Response) {
      const b = parse(v.updateButtonBody, req.body);
      res.json(await audited(req, { companyId: cid(req), entity: 'button', action: b.active === false ? 'deactivate' : 'update' }, async (q) => {
        const before = must(await catalog.getButton(q, cid(req), id(req)));
        if (b.advisorId) must(await catalog.getAdvisor(q, cid(req), b.advisorId), 'Asesor no encontrado en esta empresa');
        if (b.portfolioId) must(await portfolios.getPortfolio(q, cid(req), b.portfolioId), 'Cartera no encontrada en esta empresa');
        return { before, after: must(await catalog.updateButton(q, cid(req), id(req), b)) };
      }));
    },

    /** Checklist de puesta en marcha: qué falta para que el chatbot funcione. */
    async setup(req: Request, res: Response) {
      const company = must(await companies.getCompany(db, cid(req)));
      const [originList, recipients, buttons] = await Promise.all([
        origins.activeOrigins(db, company.id), eligibleRecipients(db, company.id), catalog.listButtons(db, company.id, true),
      ]);
      const contentHint = !company.content_url
        ? 'Pega la dirección de chatbot-content.json de tu sitio (pestaña General) y pulsa "Sincronizar ahora".'
        : company.content_status === 'error'
          ? `La última sincronización falló: ${company.content_error ?? 'error desconocido'}. Corrígelo y vuelve a sincronizar.`
          : 'Pulsa "Sincronizar ahora" para que el chatbot lea el contenido del sitio.';
      const steps = [
        {
          key: 'origin', label: 'Dominio del sitio registrado', required: true, done: originList.length > 0,
          hint: 'En la pestaña "Dominios" agrega la dirección exacta donde se ve el sitio, por ejemplo https://www.tudominio.com (sin ruta al final).',
        },
        {
          key: 'advisor', label: 'Al menos un asesor con teléfono activo', required: true, done: recipients.length > 0,
          hint: 'En "Asesores y números" crea un asesor y agrégale su número de WhatsApp con código de país.',
        },
        {
          key: 'content', label: 'Contenido del sitio sincronizado', required: true, done: company.content_status === 'ok', hint: contentHint,
        },
        {
          key: 'ai', label: 'Modelo de IA configurado', required: false, done: deps.cfg.llmEnabled,
          hint: 'Configura LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY y LLM_MODEL (p. ej. Groq) o OLLAMA_MODEL en las variables de la API. Sin modelo, el chat responde con el texto del sitio y pasa a un asesor cuando no alcanza.',
        },
        {
          key: 'buttons', label: 'Botón de contacto', required: false, done: buttons.length > 0,
          hint: 'En "Botones" crea un botón para contactar a un asesor (opcional: el chat también ofrece el contacto).',
        },
      ];
      res.json({ ready: steps.every((x) => !x.required || x.done), steps });
    },

    /* ---------- registros, métricas, auditoría ---------- */
    async handoffs(req: Request, res: Response) {
      const r = parseRange(req.query);
      res.json({ items: await pub.listHandoffs(db, cid(req), r.from, r.to, r.limit, r.offset) });
    },
    async events(req: Request, res: Response) {
      const r = parseRange(req.query);
      res.json({ items: await pub.listEvents(db, cid(req), r.from, r.to, r.limit, r.offset) });
    },
    async metrics(req: Request, res: Response) {
      const r = parseRange(req.query);
      res.json(await pub.metrics(db, cid(req), r.from, r.to));
    },
    async audit(req: Request, res: Response) {
      const q = parse(v.rangeQuery, req.query);
      res.json({ items: await audit.listAudit(db, cid(req), q.limit, q.offset) });
    },
  };
}
