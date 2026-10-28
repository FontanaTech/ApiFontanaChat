import type { Config } from '../config/env';
import type { Queryable } from '../db';
import { addUsage, usageForDay } from '../models/usage';

export type BudgetVerdict = 'ok' | 'company' | 'global';

/**
 * Controla cuántos tokens del modelo gasta cada empresa por día (UTC, igual que los proveedores) para no
 * agotar la cuota del proveedor de golpe. Al llegar al límite el chat NO se detiene: deja de usar el modelo
 * y responde con el texto del sitio o pasa a un asesor.
 *  - límite por empresa: `companies.llm_daily_tokens` (panel)
 *  - tope global: `LLM_DAILY_TOKEN_LIMIT` (suma de todas las empresas; 0 = sin tope)
 * El consumo se lleva en memoria y se guarda en `llm_usage` para sobrevivir a los reinicios.
 */
export function createLlmBudget(db: Queryable, cfg: Pick<Config, 'llmDailyTokenLimit'>) {
  let loadedDay = '';
  const used = new Map<string, number>();
  const today = () => new Date().toISOString().slice(0, 10);

  async function sync() {
    const day = today();
    if (day === loadedDay) return;
    const rows = await usageForDay(db, day);
    used.clear();
    for (const r of rows) used.set(r.company_id, r.tokens);
    loadedDay = day;
  }
  const total = () => [...used.values()].reduce((a, b) => a + b, 0);

  return {
    today,
    async check(company: { id: string; llm_daily_tokens: number | null }): Promise<BudgetVerdict> {
      await sync();
      if (cfg.llmDailyTokenLimit > 0 && total() >= cfg.llmDailyTokenLimit) return 'global';
      if (company.llm_daily_tokens != null && (used.get(company.id) ?? 0) >= company.llm_daily_tokens) return 'company';
      return 'ok';
    },
    async record(companyId: string, tokens: number): Promise<void> {
      try {
        await sync();
        used.set(companyId, (used.get(companyId) ?? 0) + Math.max(0, Math.round(tokens)));
        await addUsage(db, companyId, today(), tokens);
      } catch (e: any) {
        console.error(`[llm] no se pudo guardar el consumo: ${e.message}`);
      }
    },
  };
}
export type LlmBudget = ReturnType<typeof createLlmBudget>;
