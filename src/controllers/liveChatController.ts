import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app-types';
import { assignRecipient, type Recipient } from '../services/assignment';
import { buildWaUrl } from '../services/handoff';
import {
  actorAdvisor, auditChat, getConversationForAdmin, listConversations, lockConversation, ownerOrManager,
} from '../services/liveChat';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import * as v from '../validation/schemas';

const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
  const out = schema.safeParse(value);
  if (!out.success) throw badRequest('Datos inválidos', out.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return out.data;
};

export function liveChatController(deps: AppDeps) {
  const cid = (req: Request) => req.companyId!;
  const chatId = (req: Request) => {
    const value = String(req.params.chatId);
    if (!z.string().uuid().safeParse(value).success) throw notFound('Conversación no encontrada');
    return value;
  };
  const publish = (companyId: string, type: Parameters<typeof deps.live.publish>[1], data: Record<string, unknown>) => deps.live.publish(companyId, type, data);

  return {
    async list(req: Request, res: Response) {
      const filters = {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        portfolioId: typeof req.query.portfolioId === 'string' ? req.query.portfolioId : undefined,
        advisorId: typeof req.query.advisorId === 'string' ? req.query.advisorId : undefined,
        search: typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : undefined,
        pending: typeof req.query.pending === 'string' ? req.query.pending : undefined,
        from: typeof req.query.from === 'string' ? req.query.from : undefined,
        to: typeof req.query.to === 'string' ? req.query.to : undefined,
      };
      res.json({ items: await listConversations(deps.db, cid(req), req.admin!, filters) });
    },

    async detail(req: Request, res: Response) {
      res.json(await getConversationForAdmin(deps.db, cid(req), chatId(req), req.admin!));
    },

    async advisors(req: Request, res: Response) {
      const rows = await deps.db.query<any>(
        `SELECT a.id, a.name, a.active, COALESCE(s.status, 'offline') AS status, s.last_activity_at,
           COALESCE(array_agg(DISTINCT p.id) FILTER (WHERE p.id IS NOT NULL), '{}') AS portfolio_ids,
           count(DISTINCT c.id) FILTER (WHERE c.status = 'TOMADO_POR_ASESOR' AND c.current_advisor_id = a.id)::int AS active_chats,
           count(DISTINCT x.id) FILTER (WHERE x.action = 'TAKE' AND x.created_at >= date_trunc('day', now()))::int AS chats_today
         FROM advisors a LEFT JOIN advisor_status s ON s.advisor_id = a.id AND s.company_id = a.company_id
         LEFT JOIN advisor_portfolios ap ON ap.advisor_id = a.id AND ap.company_id = a.company_id
         LEFT JOIN portfolios p ON p.id = ap.portfolio_id AND p.company_id = a.company_id
         LEFT JOIN chat_sessions c ON c.current_advisor_id = a.id AND c.company_id = a.company_id
         LEFT JOIN chat_assignments x ON x.advisor_id = a.id AND x.company_id = a.company_id
         WHERE a.company_id = $1 GROUP BY a.id, a.name, a.active, s.status, s.last_activity_at ORDER BY a.name`, [cid(req)],
      );
      res.json({ items: rows.rows });
    },

    async setAdvisorStatus(req: Request, res: Response) {
      const body = parse(v.advisorStatusBody, req.body);
      const advisorId = String(req.params.advisorId);
      if (req.admin!.role === 'advisor' && req.admin!.advisor_id !== advisorId) throw forbidden('Solo puedes cambiar tu propio estado');
      const found = await deps.db.query('SELECT 1 FROM advisors WHERE id = $1 AND company_id = $2', [advisorId, cid(req)]);
      if (!found.rows[0]) throw notFound('Asesor no encontrado');
      const before = (await deps.db.query<any>('SELECT status FROM advisor_status WHERE advisor_id = $1 AND company_id = $2', [advisorId, cid(req)])).rows[0] ?? null;
      const row = (await deps.db.query<any>(
        `INSERT INTO advisor_status (advisor_id, company_id, status, last_activity_at, updated_at) VALUES ($1,$2,$3,now(),now())
         ON CONFLICT (advisor_id) DO UPDATE SET status = EXCLUDED.status, last_activity_at = now(), updated_at = now() RETURNING *`,
        [advisorId, cid(req), body.status],
      )).rows[0];
      await deps.db.query(
        `INSERT INTO audit_log (admin_id, company_id, action, entity, entity_id, before_data, after_data, ip)
         VALUES ($1,$2,'status_change','advisor_status',$3,$4::jsonb,$5::jsonb,$6)`,
        [req.admin!.id, cid(req), advisorId, JSON.stringify(before), JSON.stringify(row), req.ip],
      );
      publish(cid(req), 'advisor_status', { advisorId, status: body.status });
      res.json(row);
    },

    async take(req: Request, res: Response) {
      const body = parse(v.takeChatBody, req.body);
      const result = await deps.db.tx(async (q) => {
        const before = await lockConversation(q, cid(req), chatId(req));
        if (!['BOT_ACTIVO', 'EN_ESPERA_ASESOR', 'ABANDONADO'].includes(before.status)) throw conflict('La conversación ya está tomada o finalizada');
        const advisorId = req.admin!.role === 'advisor' ? actorAdvisor(req.admin!) : body.advisorId;
        if (!advisorId) throw badRequest('Selecciona el asesor que tomará la conversación');
        const eligible = await q.query<any>(
          `SELECT a.id, COALESCE(s.status, 'offline') AS status FROM advisors a
           LEFT JOIN advisor_status s ON s.advisor_id = a.id WHERE a.id = $1 AND a.company_id = $2 AND a.active`, [advisorId, cid(req)],
        );
        if (!eligible.rows[0]) throw notFound('Asesor no encontrado');
        if (eligible.rows[0].status === 'offline') throw conflict('El asesor está desconectado');
        if (before.portfolio_id) {
          const access = await q.query('SELECT 1 FROM advisor_portfolios WHERE company_id = $1 AND advisor_id = $2 AND portfolio_id = $3', [cid(req), advisorId, before.portfolio_id]);
          if (!access.rows[0]) throw forbidden('El asesor no está autorizado para esta cartera');
        }
        const conversation = (await q.query<any>(
          `UPDATE chat_sessions SET status = 'TOMADO_POR_ASESOR', current_advisor_id = $3, pending_transfer_to = NULL,
             taken_at = now(), waiting_since = NULL, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
          [before.id, cid(req), advisorId],
        )).rows[0];
        const message = (await q.query<any>(
          `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, content)
           VALUES ($1,$2,'SYSTEM','Un asesor de FontanaWeb ha tomado tu solicitud y continuará la atención por este medio.') RETURNING *`,
          [cid(req), before.id],
        )).rows[0];
        await q.query(`INSERT INTO chat_assignments (company_id, chat_session_id, advisor_id, action) VALUES ($1,$2,$3,'TAKE')`, [cid(req), before.id, advisorId]);
        await auditChat(q, req.admin!, cid(req), before.id, 'TAKE_CONTROL', before, conversation);
        return { conversation, message };
      });
      publish(cid(req), 'chat_assignment', { conversationId: result.conversation.id, advisorId: result.conversation.current_advisor_id });
      publish(cid(req), 'chat_message', { conversationId: result.conversation.id, messageId: result.message.id, sender: 'SYSTEM' });
      res.json(result);
    },

    async send(req: Request, res: Response) {
      const body = parse(v.advisorMessageBody, req.body);
      const result = await deps.db.tx(async (q) => {
        const conversation = await lockConversation(q, cid(req), chatId(req));
        if (conversation.status !== 'TOMADO_POR_ASESOR' || !conversation.current_advisor_id) throw conflict('La conversación no está tomada');
        ownerOrManager(req.admin!, conversation);
        const message = (await q.query<any>(
          `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, advisor_id, content)
           VALUES ($1,$2,'ADVISOR',$3,$4) RETURNING *`, [cid(req), conversation.id, conversation.current_advisor_id, body.message],
        )).rows[0];
        await q.query('UPDATE chat_sessions SET last_interaction_at = now(), updated_at = now() WHERE id = $1', [conversation.id]);
        await q.query('UPDATE advisor_status SET last_activity_at = now(), updated_at = now() WHERE advisor_id = $1', [conversation.current_advisor_id]);
        return { conversation, message };
      });
      publish(cid(req), 'chat_message', { conversationId: result.conversation.id, messageId: result.message.id, sender: 'ADVISOR' });
      res.status(201).json(result.message);
    },

    async changePortfolio(req: Request, res: Response) {
      const body = parse(v.changeChatPortfolioBody, req.body);
      const result = await deps.db.tx(async (q) => {
        const before = await lockConversation(q, cid(req), chatId(req));
        ownerOrManager(req.admin!, before);
        const portfolio = (await q.query<any>('SELECT id, name FROM portfolios WHERE id = $1 AND company_id = $2 AND active', [body.portfolioId, cid(req)])).rows[0];
        if (!portfolio) throw notFound('Cartera no encontrada');
        let keepAdvisor = true;
        if (before.current_advisor_id) {
          const authorized = await q.query('SELECT 1 FROM advisor_portfolios WHERE company_id = $1 AND advisor_id = $2 AND portfolio_id = $3', [cid(req), before.current_advisor_id, body.portfolioId]);
          keepAdvisor = !!authorized.rows[0];
        }
        const conversation = (await q.query<any>(
          `UPDATE chat_sessions SET portfolio_id = $3,
             status = CASE WHEN $4::boolean THEN status ELSE 'EN_ESPERA_ASESOR' END,
             current_advisor_id = CASE WHEN $4::boolean THEN current_advisor_id ELSE NULL END,
             waiting_since = CASE WHEN $4::boolean THEN waiting_since ELSE now() END, updated_at = now()
           WHERE id = $1 AND company_id = $2 RETURNING *`,
          [before.id, cid(req), body.portfolioId, keepAdvisor],
        )).rows[0];
        await auditChat(q, req.admin!, cid(req), before.id, 'CHANGE_PORTFOLIO', { portfolioId: before.portfolio_id }, { portfolioId: body.portfolioId });
        return { conversation, portfolio };
      });
      publish(cid(req), 'chat_portfolio', { conversationId: result.conversation.id, portfolioId: body.portfolioId });
      res.json(result);
    },

    async release(req: Request, res: Response) {
      const body = parse(v.releaseChatBody, req.body);
      const result = await deps.db.tx(async (q) => {
        const before = await lockConversation(q, cid(req), chatId(req));
        ownerOrManager(req.admin!, before);
        if (before.status !== 'TOMADO_POR_ASESOR') throw conflict('La conversación no está tomada');
        const status = body.destination === 'bot' ? 'BOT_ACTIVO' : 'EN_ESPERA_ASESOR';
        const conversation = (await q.query<any>(
          `UPDATE chat_sessions SET status = $3, current_advisor_id = NULL, pending_transfer_to = NULL, taken_at = NULL,
             waiting_since = CASE WHEN $3 = 'EN_ESPERA_ASESOR' THEN now() ELSE NULL END, updated_at = now()
           WHERE id = $1 AND company_id = $2 RETURNING *`, [before.id, cid(req), status],
        )).rows[0];
        await q.query(`INSERT INTO chat_assignments (company_id, chat_session_id, advisor_id, action) VALUES ($1,$2,$3,$4)`,
          [cid(req), before.id, before.current_advisor_id, body.destination === 'bot' ? 'RELEASE_BOT' : 'RELEASE_QUEUE']);
        await auditChat(q, req.admin!, cid(req), before.id, 'RELEASE', before, conversation);
        return conversation;
      });
      publish(cid(req), 'chat_status', { conversationId: result.id, status: result.status });
      res.json(result);
    },

    async transfer(req: Request, res: Response) {
      const body = parse(v.transferChatBody, req.body);
      const result = await deps.db.tx(async (q) => {
        const before = await lockConversation(q, cid(req), chatId(req));
        ownerOrManager(req.admin!, before);
        if (before.status !== 'TOMADO_POR_ASESOR') throw conflict('La conversación no está tomada');
        const access = await q.query('SELECT 1 FROM advisor_portfolios WHERE company_id = $1 AND advisor_id = $2 AND portfolio_id = $3', [cid(req), body.advisorId, before.portfolio_id]);
        if (!access.rows[0]) throw forbidden('El asesor destino no está autorizado para la cartera');
        const conversation = (await q.query<any>('UPDATE chat_sessions SET pending_transfer_to = $3, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *', [before.id, cid(req), body.advisorId])).rows[0];
        await q.query(`INSERT INTO chat_assignments (company_id, chat_session_id, advisor_id, target_advisor_id, action) VALUES ($1,$2,$3,$4,'TRANSFER_REQUEST')`, [cid(req), before.id, before.current_advisor_id, body.advisorId]);
        await auditChat(q, req.admin!, cid(req), before.id, 'TRANSFER_REQUEST', before, conversation);
        return conversation;
      });
      publish(cid(req), 'chat_assignment', { conversationId: result.id, pendingTransferTo: result.pending_transfer_to });
      res.json(result);
    },

    async acceptTransfer(req: Request, res: Response) {
      const result = await deps.db.tx(async (q) => {
        const before = await lockConversation(q, cid(req), chatId(req));
        const advisorId = actorAdvisor(req.admin!);
        if (before.pending_transfer_to !== advisorId) throw forbidden('No tienes una transferencia pendiente para este chat');
        const conversation = (await q.query<any>(
          `UPDATE chat_sessions SET current_advisor_id = $3, pending_transfer_to = NULL, taken_at = now(), updated_at = now()
           WHERE id = $1 AND company_id = $2 RETURNING *`, [before.id, cid(req), advisorId],
        )).rows[0];
        await q.query(`INSERT INTO chat_assignments (company_id, chat_session_id, advisor_id, target_advisor_id, action) VALUES ($1,$2,$3,$4,'TRANSFER_ACCEPT')`, [cid(req), before.id, before.current_advisor_id, advisorId]);
        await auditChat(q, req.admin!, cid(req), before.id, 'TRANSFER_ACCEPT', before, conversation);
        return conversation;
      });
      publish(cid(req), 'chat_assignment', { conversationId: result.id, advisorId: result.current_advisor_id });
      res.json(result);
    },

    async whatsapp(req: Request, res: Response) {
      const body = parse(v.whatsappChatBody, req.body);
      const result = await deps.db.tx(async (q) => {
        const before = await lockConversation(q, cid(req), chatId(req));
        ownerOrManager(req.admin!, before);
        if (!before.portfolio_id) throw badRequest('Selecciona una cartera antes de remitir a WhatsApp');
        let recipient: Recipient | null;
        if (body.advisorId) {
          recipient = await assignRecipient(q, cid(req), { advisorId: body.advisorId });
        } else {
          const picked = (await q.query<any>(
            `SELECT a.id AS advisor_id, a.name AS advisor_name, ph.id AS phone_id, ph.number, ph.portfolio_id
             FROM advisors a JOIN advisor_portfolios ap ON ap.advisor_id = a.id AND ap.company_id = a.company_id
             JOIN phones ph ON ph.advisor_id = a.id AND ph.company_id = a.company_id AND ph.portfolio_id = ap.portfolio_id AND ph.active
             LEFT JOIN advisor_status ast ON ast.advisor_id = a.id
             LEFT JOIN chat_sessions active ON active.current_advisor_id = a.id AND active.status = 'TOMADO_POR_ASESOR'
             WHERE a.company_id = $1 AND ap.portfolio_id = $2 AND a.active AND COALESCE(ast.status, 'offline') <> 'offline'
             GROUP BY a.id, a.name, ph.id, ph.number, ph.portfolio_id, ast.status, ph.is_primary, ph.created_at
             ORDER BY CASE ast.status WHEN 'available' THEN 0 ELSE 1 END, count(active.id), ph.is_primary DESC, ph.created_at LIMIT 1`,
            [cid(req), before.portfolio_id],
          )).rows[0];
          recipient = picked ? { advisorId: picked.advisor_id, advisorName: picked.advisor_name, phoneId: picked.phone_id, number: picked.number, portfolioId: picked.portfolio_id } : null;
        }
        if (!recipient || recipient.portfolioId !== before.portfolio_id) throw conflict('No hay un WhatsApp habilitado para esta cartera');
        const portfolio = (await q.query<{ name: string }>('SELECT name FROM portfolios WHERE id = $1 AND company_id = $2', [before.portfolio_id, cid(req)])).rows[0];
        const company = (await q.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [cid(req)])).rows[0];
        const summary = body.summary || before.summary || before.subject;
        const reason = [before.document ? `Documento: ${before.document}` : '', `Cartera: ${portfolio?.name ?? ''}`, summary].filter(Boolean).join(' · ');
        const waUrl = buildWaUrl(recipient.number, company.name, before.visitor_name ?? before.id.slice(0, 8), reason, before.id);
        const conversation = (await q.query<any>(
          `UPDATE chat_sessions SET status = 'REMITIDO_WHATSAPP', summary = $3, closed_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
          [before.id, cid(req), summary],
        )).rows[0];
        const message = (await q.query<any>(
          `INSERT INTO chat_messages (company_id, chat_session_id, sender_type, content, metadata)
           VALUES ($1,$2,'SYSTEM','Puedes continuar la atención en el WhatsApp autorizado para tu cartera.',jsonb_build_object('waUrl',$3::text)) RETURNING *`,
          [cid(req), before.id, waUrl],
        )).rows[0];
        await auditChat(q, req.admin!, cid(req), before.id, 'WHATSAPP_ROUTE', before, { ...conversation, advisorId: recipient.advisorId });
        return { conversation, message, waUrl, advisorName: recipient.advisorName };
      });
      publish(cid(req), 'chat_status', { conversationId: result.conversation.id, status: 'REMITIDO_WHATSAPP' });
      publish(cid(req), 'chat_message', { conversationId: result.conversation.id, messageId: result.message.id, sender: 'SYSTEM' });
      res.json(result);
    },

    async close(req: Request, res: Response) {
      const body = parse(v.closeChatBody, req.body);
      const result = await deps.db.tx(async (q) => {
        const before = await lockConversation(q, cid(req), chatId(req));
        ownerOrManager(req.admin!, before);
        if (before.status === 'CERRADO') throw conflict('La conversación ya está cerrada');
        const conversation = (await q.query<any>(
          `UPDATE chat_sessions SET status = 'CERRADO', close_reason = $3, summary = COALESCE(NULLIF($4,''), summary),
             closed_at = now(), pending_transfer_to = NULL, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
          [before.id, cid(req), body.reason, body.summary ?? ''],
        )).rows[0];
        await q.query(`INSERT INTO chat_assignments (company_id, chat_session_id, advisor_id, action) VALUES ($1,$2,$3,'CLOSE')`, [cid(req), before.id, before.current_advisor_id]);
        await auditChat(q, req.admin!, cid(req), before.id, 'CLOSE', before, conversation);
        return conversation;
      });
      publish(cid(req), 'chat_status', { conversationId: result.id, status: 'CERRADO' });
      res.json(result);
    },
  };
}

