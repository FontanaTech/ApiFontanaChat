import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app-types';
import { getButtonByKey, listButtons } from '../models/catalog';
import { listPortfolios } from '../models/portfolios';
import { createPublicSession, getHandoffForSession, insertEvent, markWhatsappClicked } from '../models/public';
import { hashToken, randomToken } from '../utils/crypto';
import { badRequest, notFound } from '../utils/errors';
import { createSessionBody, eventBody, handoffBody } from '../validation/schemas';
import { eligibleRecipients } from '../services/assignment';
import { answerChat } from '../services/chat';
import { createHandoff } from '../services/handoff';
import { parseUserAgent, visitorHash } from '../utils/userAgent';

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Datos inválidos', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

/** Los bots y las sesiones antiguas no cuentan como visitantes. */
const trackedVisitor = (s: { visitor_hash: string | null; device: string | null }) => (s.device === 'bot' ? null : s.visitor_hash);

export function publicController(deps: AppDeps) {
  const chatBody = z.object({
    message: z.string().trim().min(1).max(deps.cfg.chatMessageMaxChars),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(deps.cfg.chatMessageMaxChars * 2) }))
      .max(6)
      .default([]),
  });

  return {
    async createSession(req: Request, res: Response) {
      const body = parse(createSessionBody, req.body);
      const { company, origin } = req.pub!;
      const token = randomToken();
      const expiresAt = new Date(Date.now() + deps.cfg.publicSessionTtlMs);
      // Visitante = IP + navegador (huella irreversible; la IP no se guarda), para contar ingresos reales y no vistas.
      const ua = req.get('user-agent');
      const client = parseUserAgent(ua);
      const s = await createPublicSession(deps.db, {
        companyId: company.id, tokenHash: hashToken(deps.cfg.sessionSecret, token), origin,
        pagePath: body.pagePath ?? '/', expiresAt,
        visitorHash: visitorHash(deps.cfg.sessionSecret, company.id, req.ip ?? '', ua), ...client,
      });
      res.status(201).json({ token, expiresAt: s.expires_at, company: { slug: company.slug, name: company.name } });
    },

    /** Botones activos con disponibilidad; nunca incluye números de teléfono. */
    async config(req: Request, res: Response) {
      const { company } = req.pub!;
      const [buttons, recipients, wallets] = await Promise.all([
        listButtons(deps.db, company.id, true), eligibleRecipients(deps.db, company.id), listPortfolios(deps.db, company.id, true),
      ]);
      const available = new Set(recipients.map((r) => r.advisorId));
      const withPhones = new Set(wallets.filter((w) => w.phone_count > 0).map((w) => w.id));
      res.json({
        company: { slug: company.slug, name: company.name },
        available: available.size > 0,
        // Carteras que hoy pueden atender (solo nombre; nunca teléfonos).
        portfolios: wallets.filter((w) => w.phone_count > 0).map((w) => ({ key: w.key, name: w.name })),
        buttons: buttons.map((b) => ({
          key: b.key, label: b.label, color: b.color, textColor: b.text_color,
          available: b.advisor_id ? available.has(b.advisor_id) : b.portfolio_id ? withPhones.has(b.portfolio_id) : available.size > 0,
        })),
      });
    },

    async event(req: Request, res: Response) {
      const body = parse(eventBody, req.body);
      const { company, session } = req.pub!;
      let buttonId: string | null = null;
      if (body.buttonKey) {
        const b = await getButtonByKey(deps.db, company.id, body.buttonKey);
        if (!b || !b.active) throw badRequest('Botón inexistente');
        buttonId = b.id;
      }
      const path = body.path ?? session!.page_path;
      const { isVisit } = await insertEvent(deps.db, {
        companyId: company.id, sessionId: session!.id, type: body.type, buttonId, pagePath: path, visitorHash: trackedVisitor(session!),
      });
      // Al panel abierto, en vivo (en memoria: no consulta la base).
      deps.live.publish(company.id, body.type, { path, isVisit, button: body.buttonKey ?? null, device: session!.device, browser: session!.browser, os: session!.os });
      res.status(202).json({ ok: true });
    },

    async chat(req: Request, res: Response) {
      const body = parse(chatBody, req.body);
      const reply = await answerChat({ db: deps.db, llm: deps.llm, contextMaxChars: deps.cfg.chatContextMaxChars, fastScore: deps.cfg.chatFastScore, budget: deps.budget, notify: deps.live.publish }, req.pub!.company, req.pub!.session!, body.message, body.history);
      res.json(reply);
    },

    async createHandoff(req: Request, res: Response) {
      const body = parse(handoffBody, req.body);
      const headerKey = req.headers['idempotency-key'];
      const key = body.idempotencyKey ?? (typeof headerKey === 'string' ? headerKey.trim() : '');
      if (!key || key.length < 8 || key.length > 100 || !/^[A-Za-z0-9_\-:.]+$/.test(key)) {
        throw badRequest('Se requiere Idempotency-Key (8-100 caracteres)');
      }
      const { company, session } = req.pub!;
      const r = await createHandoff(deps.db, company, session!, {
        buttonKey: body.buttonKey, portfolioKey: body.portfolioKey, name: body.name, reason: body.reason, idempotencyKey: key,
      }, deps.live.publish);
      res.status(r.replayed ? 200 : 201).json({
        handoffId: r.handoff.id,
        replayed: r.replayed,
        advisorName: r.advisorName,
        waUrl: r.handoff.wa_url,
        summary: { name: r.handoff.visitor_name, reason: r.handoff.reason },
      });
    },

    /** Registra el clic en el enlace de WhatsApp. No implica que el mensaje se haya enviado. */
    async whatsappClick(req: Request, res: Response) {
      const { company, session } = req.pub!;
      const id = String(req.params.id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Derivación no encontrada');
      const h = await getHandoffForSession(deps.db, company.id, session!.id, id);
      if (!h) throw notFound('Derivación no encontrada');
      const first = await markWhatsappClicked(deps.db, company.id, h.id);
      if (first) {
        await insertEvent(deps.db, { companyId: company.id, sessionId: session!.id, type: 'whatsapp_click', buttonId: h.button_id, handoffId: h.id, visitorHash: trackedVisitor(session!) });
        deps.live.publish(company.id, 'whatsapp_click', { handoffId: h.id });
      }
      res.status(202).json({ ok: true });
    },
  };
}

