import type { Db } from '../db';
import { HttpError, badRequest, conflict } from '../utils/errors';
import type { Company } from '../models/companies';
import { getButtonByKey } from '../models/catalog';
import { findHandoffByKey, insertEvent, insertHandoff, type Handoff, type PublicSession } from '../models/public';
import { assignRecipient } from './assignment';

export interface HandoffInput {
  /** Opcional: un botón con asesor fijo lo respeta; sin botón (o botón rotativo) se rota entre asesores disponibles. */
  buttonKey?: string;
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
export async function createHandoff(db: Db, company: Company, session: PublicSession, input: HandoffInput): Promise<HandoffResult> {
  return db.tx(async (q) => {
    // Serializa solicitudes concurrentes de la misma sesión (evita doble asignación con la misma clave).
    await q.query('SELECT id FROM public_sessions WHERE id = $1 AND company_id = $2 FOR UPDATE', [session.id, company.id]);

    const existing = await findHandoffByKey(q, company.id, session.id, input.idempotencyKey);
    if (existing) {
      const adv = await q.query<{ name: string }>('SELECT name FROM advisors WHERE id = $1 AND company_id = $2', [existing.advisor_id, company.id]);
      return { handoff: existing, replayed: true, advisorName: adv.rows[0]?.name ?? '' };
    }

    let buttonId: string | null = null;
    let advisorId: string | null = null;
    if (input.buttonKey) {
      const button = await getButtonByKey(q, company.id, input.buttonKey);
      if (!button || !button.active) throw badRequest('Botón inexistente o inactivo');
      buttonId = button.id;
      advisorId = button.advisor_id;
    }

    const recipient = await assignRecipient(q, company.id, advisorId);
    if (!recipient) throw new HttpError(409, 'no_advisor_available', 'No hay un asesor disponible en este momento');

    const refCode = session.id.slice(0, 4) + Date.now().toString(36).slice(-4).toUpperCase();
    const name = input.name ?? '';
    const reason = input.reason ?? '';
    const waUrl = buildWaUrl(recipient.number, company.name, name, reason, refCode);
    let handoff: Handoff;
    try {
      handoff = await insertHandoff(q, {
        companyId: company.id, sessionId: session.id, key: input.idempotencyKey, buttonId,
        advisorId: recipient.advisorId, phoneId: recipient.phoneId, phoneNumber: recipient.number,
        name, reason, waUrl,
      });
    } catch (e: any) {
      if ((e?.code ?? e?.cause?.code) === '23505') throw conflict('Solicitud duplicada');
      throw e;
    }
    await insertEvent(q, { companyId: company.id, sessionId: session.id, type: 'handoff_created', buttonId, handoffId: handoff.id });
    return { handoff, replayed: false, advisorName: recipient.advisorName };
  });
}
