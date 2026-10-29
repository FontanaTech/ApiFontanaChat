import type { Queryable } from '../db';

export interface UsageDay {
  day: string;
  requests: number;
  tokens: number;
}

/** Suma una consulta al modelo (y sus tokens) al consumo del día de la empresa. */
export async function addUsage(q: Queryable, companyId: string, day: string, tokens: number): Promise<void> {
  await q.query(
    `INSERT INTO llm_usage (company_id, day, requests, tokens) VALUES ($1, $2::date, 1, $3)
     ON CONFLICT (company_id, day) DO UPDATE SET requests = llm_usage.requests + 1, tokens = llm_usage.tokens + EXCLUDED.tokens`,
    [companyId, day, Math.max(0, Math.round(tokens))],
  );
}

/** Solicitudes y tokens consumidos en un día por cada empresa (todas). */
export async function usageForDay(q: Queryable, day: string): Promise<Array<{ company_id: string; requests: number; tokens: number }>> {
  return (
    await q.query<{ company_id: string; requests: number; tokens: number }>('SELECT company_id, requests, tokens FROM llm_usage WHERE day = $1::date', [day])
  ).rows;
}

/** Consumo diario sumando todas las empresas, el más reciente primero. */
export async function usageHistoryAll(q: Queryable, days = 14): Promise<UsageDay[]> {
  return (
    await q.query<UsageDay>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(requests)::int AS requests, sum(tokens)::int AS tokens FROM llm_usage
       GROUP BY day ORDER BY day DESC LIMIT $1`,
      [days],
    )
  ).rows;
}

/** Últimos días de consumo de una empresa, el más reciente primero. */
export async function usageHistory(q: Queryable, companyId: string, days = 14): Promise<UsageDay[]> {
  return (
    await q.query<UsageDay>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, requests, tokens FROM llm_usage
       WHERE company_id = $1 ORDER BY llm_usage.day DESC LIMIT $2`,
      [companyId, days],
    )
  ).rows;
}
