import { z } from 'zod';
import type { Company } from '../models/companies';
import type { LlmBudget } from './llmBudget';
import { LlmUnavailableError, type LlmClient, type LlmMessage, type LlmMeta } from './ollama';

/** Turno de la conversación que ve el redactor del mensaje (el del visitante y el del asistente). */
export interface WaTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface WaMessageDeps {
  llm: LlmClient;
  budget?: LlmBudget;
  /** Espera máxima antes de usar el mensaje sencillo (el visitante ya espera el enlace de WhatsApp). */
  timeoutMs?: number;
}

const maskNumbers = (s: string): string => s.replace(/\d[\d\s().-]{4,}\d/g, '[número]');
const Out = z.object({ mensaje: z.string() });

/** El mensaje va a un asesor real: sin enlaces, correos, números largos ni restos de plantilla. */
function acceptable(text: string): boolean {
  return text.length >= 8 && text.length <= 260 && !/https?:|www\.|@|\[|\d{5,}/i.test(text);
}

function systemPrompt(company: Company): string {
  return [
    `Redactas el primer mensaje de WhatsApp que un visitante del sitio de ${company.name} enviará a un asesor.`,
    '- Escríbelo en primera persona, en español, cordial y natural, como lo escribiría la persona.',
    '- Máximo 2 frases cortas (menos de 220 caracteres) que digan con claridad qué necesita, según la conversación.',
    '- No inventes datos, nombres, cifras ni enlaces; no incluyas números. No te presentes con el nombre de la empresa ni escribas la referencia: se añaden aparte.',
    '- No saludes con "Hola": ya se añade. Empieza directo (ej. "Quisiera saber cómo funciona ...").',
    'Responde SOLO con JSON: {"mensaje":"..."}',
  ].join('\n');
}

/**
 * Mensaje de WhatsApp personalizado con la consulta del visitante (lo redacta el modelo).
 * Devuelve null si no hay consulta, no hay modelo, se agotó el presupuesto, tarda demasiado o la salida no es confiable;
 * entonces quien llama usa el mensaje sencillo. Nunca lanza.
 */
export async function composeWaMessage(deps: WaMessageDeps, company: Company, turns: WaTurn[]): Promise<string | null> {
  if (turns.length === 0) return null;
  try {
    if (deps.budget && (await deps.budget.check(company)) !== 'ok') return null;
    const msgs: LlmMessage[] = [
      { role: 'system', content: systemPrompt(company) },
      {
        role: 'user',
        content: turns
          .slice(-5)
          .map((t) => `${t.role === 'user' ? 'Visitante' : 'Asistente'}: ${maskNumbers(t.content.slice(0, 400))}`)
          .join('\n'),
      },
    ];
    const meta: LlmMeta = {};
    let timer: NodeJS.Timeout | undefined;
    const raw = await Promise.race([
      deps.llm.chatJson(msgs, meta),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new LlmUnavailableError('timeout redactando el mensaje de WhatsApp')), deps.timeoutMs ?? 6000);
      }),
    ]).finally(() => clearTimeout(timer));
    const chars = msgs.reduce((n, m) => n + m.content.length, 0) + raw.length;
    void deps.budget?.record(company.id, meta.tokens ?? Math.ceil(chars / 3.2));
    const clean = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = Out.safeParse(JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] ?? clean));
    if (!parsed.success) return null;
    const text = parsed.data.mensaje.replace(/\s+/g, ' ').trim();
    return acceptable(text) ? text : null;
  } catch {
    return null;
  }
}
