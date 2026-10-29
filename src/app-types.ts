import type { Config } from './config/env';
import type { Db } from './db';
import type { Admin } from './models/admins';
import type { Company } from './models/companies';
import type { PublicSession } from './models/public';
import type { ContentFetcher } from './services/contentSync';
import type { LlmBudget } from './services/llmBudget';
import type { PublicCache } from './services/publicCache';
import type { LiveBus } from './services/liveEvents';
import type { LlmClient } from './services/ollama';

export interface AppDeps {
  cfg: Config;
  db: Db;
  llm: LlmClient;
  contentFetcher: ContentFetcher;
  cache: PublicCache;
  budget: LlmBudget;
  live: LiveBus;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: Admin;
      adminCsrf?: string;
      companyId?: string;
      pub?: { company: Company; origin: string; session?: PublicSession };
    }
  }
}
