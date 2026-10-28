import type { Config } from '../config/env';
import type { Company } from '../models/companies';
import type { PublicSession } from '../models/public';
import { TtlCache } from '../utils/cache';

export interface PublicSite {
  company: Company;
  origins: string[];
}

/**
 * Caché de lo que cada petición pública necesita leer antes de hacer su trabajo (empresa, orígenes
 * permitidos y sesión). Los teléfonos y asesores NO se cachean: un cambio de número aplica al instante.
 * Los cambios de empresa/orígenes/contenido hechos desde el panel llaman a `clear()`.
 */
export function createPublicCache(cfg: Pick<Config, 'cacheTtlMs'>) {
  const sites = new TtlCache<PublicSite>(cfg.cacheTtlMs, 500);
  const sessions = new TtlCache<PublicSession>(cfg.cacheTtlMs, 5000);
  return {
    sites,
    sessions,
    clear() {
      sites.clear();
      sessions.clear();
    },
  };
}
export type PublicCache = ReturnType<typeof createPublicCache>;
