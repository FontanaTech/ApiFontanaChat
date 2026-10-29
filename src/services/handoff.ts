import type { Db } from '../db';
import { HttpError, badRequest, conflict } from '../utils/errors';
import type { Company } from '../models/companies';
import { getButtonByKey } from '../models/catalog';
import { getDefaultPortfolio, getPortfolioByKey } from '../models/portfolios';
import { findHandoffByKey, insertEvent, insertHandoff, type Handoff, type PublicSession } from '../models/public';
import { assignRecipient, type Recipient, type RecipientFilter } from './assignment';
import type { LiveNotify } from './liveEvents';

export interface HandoffInput {
  /** Opcional: un botón con asesor fijo lo respeta; con cartera usa esa cartera; sin nada, la cartera por defecto. */
  buttonKey?: string;
  /** Cartera pedida de forma explícita: si no existe, está inactiva o no tiene asesores disponibles, es un error. */
  portfolioKey?: string;
  /**
   * Cartera detectada por el chat a partir del texto del visitante: si no tiene asesores disponibles se cae a la
   * cartera por defecto en vez de fallar.
   */
  portfolioKeyHint?: string;
  name?: string;
  reason?: string;
  idempotencyKey: string;
}

export function buildWaUrl(number: string, companyName: string, name: string, reason: string, ref: string): string {
  const intro = name ? `Hola ${companyName}, soy ${name}.` : `Hola ${companyName}.`;
  const text = `${intro} ${reason ? `Quiero consultar sobre: ${reason}.` : 'Quiero hablar con un asesor.'} (Ref. ${ref})`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

export interface HandoffResult {
  handoff: Handoff;
  replayed: boolean;
  advisorName: string;
}

/**
 * Crea la derivación de forma idempotente por (sesión, clave).
 * Consulta el teléfono vigente en la base en el momento de la llamada; nunca usa datos del cliente.
 */
export async function createHandoff(
  db: Db, company: Company, session: PublicSession, input: HandoffInput, notify?: LiveNotify,
): Promise<HandoffResult> {
  const out = await db.tx(async (q) => {
    // Serializa solicitudes concurrentes de la misma sesión (evita doble asignación con la misma clave).
    await q.query('SELECT id FROM public_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE', [session.id, company.id]);

    const existing = await findHandoffByKey(q, company.id, session.id, input.idempotencyKey);
    if (existing) {
      const adv = await q.query<{ name: string }>('SELECT name FROM advisors WHERE id = $1 AND company_id = $2', [existing.advisor_id, company.id]);
      return { handoff: existing, replayed: true, advisorName: adv.rows[0]?.name ?? '' };
    }

    // Prioridad: asesor fijo del botón > cartera del botón > cartera pedida > cartera detectada > cartera por defecto.
    let buttonId: string | null = null;
    const attempts: RecipientFilter[] = [];
    let strict = false;
    if (input.buttonKey) {
      const button = await getButtonByKey(q, company.id, input.buttonKey);
      if (!button || !button.active) throw badRequest('Botón inexistente o inactivo');
      buttonId = button.id;
      if (button.advisor_id) attempts.push({ advisorId: button.advisor_id });
      else if (button.portfolio_id) attempts.push({ portfolioId: button.portfolio_id });
    }
    if (attempts.length === 0 && input.portfolioKey) {
      const p = await getPortfolioByKey(q, company.id, input.portfolioKey);
      if (!p || !p.active) throw badRequest('Cartera inexistente o inactiva');
      attempts.push({ portfolioId: p.id });
      strict = true;
    }
    if (attempts.length === 0 && input.portfolioKeyHint) {
      const p = await getPortfolioByKey(q, company.id, input.portfolioKeyHint);
      if (p?.active) attempts.push({ portfolioId: p.id });
    }
    if (!strict && !attempts.some((a) => a.advisorId)) {
      const def = await getDefaultPortfolio(q, company.id);
      if (def?.active && !attempts.some((a) => a.portfolioId === def.id)) attempts.push({ portfolioId: def.id });
      attempts.push({}); // último recurso: cualquier asesor disponible de la empresa
    }

    let recipient: Recipient | null = null;
    for (const f of attempts) {
      recipient = await assignRecipient(q, company.id, f);
      if (recipient) break;
    }
    if (!recipient) throw new HttpError(409, 'no_advisor_available', 'No hay un asesor disponible en este momento');

    const refCode = session.id.slice(0, 4) + Date.now().toString(36).slice(-4).toUpperCase();
    const name = input.name ?? '';
    const reason = input.reason ?? '';
    const waUrl = buildWaUrl(recipient.number, company.name, name, reason, refCode);
    let handoff: Handoff;
    try {
      handoff = await insertHandoff(q, {
        companyId: company.id, sessionId: session.id, key: input.idempotencyKey, buttonId, portfolioId: recipient.portfolioId,
        advisorId: recipient.advisorId, phoneId: recipient.phoneId, phoneNumber: recipient.number,
        name, reason, waUrl,
      });
    } catch (e: any) {
      if ((e?.code ?? e?.cause?.code) === '23505') throw conflict('Solicitud duplicada');
      throw e;
    }
    await insertEvent(q, {
      companyId: company.id, sessionId: session.id, type: 'handoff_created', buttonId, handoffId: handoff.id,
      visitorHash: session.device === 'bot' ? null : session.visitor_hash,
    });
    return { handoff, replayed: false, advisorName: recipient.advisorName };
  });
  // Ya confirmada la transacción: aviso en vivo al panel.
  if (!out.replayed) notify?.(company.id, 'handoff_created', { handoffId: out.handoff.id });
  return out;
}
