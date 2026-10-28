/**
 * Generación de /chatbot-content.json desde los MISMOS textos visibles que renderizan los componentes.
 *
 * Patrón recomendado: cada sitio mantiene un módulo `siteContent.ts` con los textos (fuente única).
 * Los componentes importan de ahí para renderizar y el build lo usa para emitir el JSON,
 * de modo que el chatbot nunca responde con texto que la página no muestra.
 */

export interface ChatbotSection {
  slug: string;
  title: string;
  route: string;
  /** Texto público visible de la sección (párrafos, listas). Sin HTML. */
  text: string;
}
export interface ChatbotContent {
  slug: string; // slug de la empresa en la API (ej. "aagora-bpo")
  siteName?: string;
  generatedAt: string;
  sections: ChatbotSection[];
}

export interface SectionSource {
  slug: string;
  title: string;
  route: string;
  /** Cadenas o fragmentos visibles; se unen con saltos de línea. */
  texts: Array<string | null | undefined | false>;
}

const clean = (s: string) =>
  s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export function buildChatbotContent(companySlug: string, sections: SectionSource[], siteName?: string): ChatbotContent {
  const out: ChatbotSection[] = sections
    .map((s) => ({
      slug: s.slug,
      title: clean(s.title),
      route: s.route.startsWith('/') ? s.route : `/${s.route}`,
      text: s.texts.filter((t): t is string => typeof t === 'string').map(clean).filter(Boolean).join('\n').slice(0, 8000),
    }))
    .filter((s) => s.text.length > 0);
  if (out.length === 0) throw new Error('chatbot-content: no hay secciones con texto público');
  return { slug: companySlug, siteName, generatedAt: new Date().toISOString(), sections: out };
}

/**
 * Plugin de Vite (sin dependencia de tipos de Vite): emite `chatbot-content.json` en el build.
 *
 *   // vite.config.ts del sitio
 *   import { chatbotContentPlugin } from './fontanachat-client';
 *   import { companySlug, sections } from './src/siteContent';
 *   export default { plugins: [chatbotContentPlugin(() => buildChatbotContent(companySlug, sections))] };
 */
export function chatbotContentPlugin(build: () => ChatbotContent, fileName = 'chatbot-content.json') {
  return {
    name: 'fontanachat-chatbot-content',
    /** En `vite dev` no hay build: se sirve el mismo JSON desde el servidor de desarrollo. */
    configureServer(server: {
      middlewares: { use: (path: string, fn: (req: unknown, res: { setHeader: (k: string, v: string) => void; end: (b: string) => void }) => void) => void };
    }) {
      server.middlewares.use(`/${fileName}`, (_req, res) => {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-cache');
        res.end(JSON.stringify(build(), null, 2));
      });
    },
    generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void }) {
      this.emitFile({ type: 'asset', fileName, source: JSON.stringify(build(), null, 2) });
    },
  };
}
