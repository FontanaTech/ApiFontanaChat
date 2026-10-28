import { z } from 'zod';

export const uuid = z.string().uuid();
export const slugRe = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const slug = z.string().min(2).max(60).regex(slugRe, 'Solo minúsculas, números y guiones');
const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color hex #RRGGBB');

/** Número internacional: acepta +, espacios y guiones; se guarda solo con dígitos (8 a 15, sin 0 inicial). */
export const phoneNumber = z
  .string()
  .trim()
  .max(25)
  .transform((s) => s.replace(/[\s\-().+]/g, ''))
  .refine((s) => /^[1-9][0-9]{7,14}$/.test(s), 'Número inválido: usa formato internacional con código de país');

/** Orígenes: esquema + host (+ puerto), sin ruta. Se normaliza a minúsculas. */
export const originStr = z
  .string()
  .trim()
  .max(200)
  .transform((s) => s.replace(/\/+$/, '').toLowerCase())
  .refine((s) => /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(s), 'Origen inválido (ej. https://sitio.com)');

export const loginBody = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });

export const createCompanyBody = z.object({
  slug,
  name: trimmed(1, 120),
  contentUrl: z.string().trim().url().max(500).nullable().optional(),
  origins: z.array(originStr).max(20).optional(),
});
export const updateCompanyBody = z
  .object({
    slug: slug.optional(),
    name: trimmed(1, 120).optional(),
    active: z.boolean().optional(),
    contentUrl: z.string().trim().url().max(500).nullable().optional(),
    // Solo superadmin: reparte la cuota diaria de tokens del modelo entre las empresas (null = sin límite propio).
    llmDailyTokens: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  })
  .strict();

export const createOriginBody = z.object({ origin: originStr });
export const activeBody = z.object({ active: z.boolean() });

export const createAdvisorBody = z.object({ name: trimmed(1, 120) });
export const updateAdvisorBody = z.object({ name: trimmed(1, 120).optional(), active: z.boolean().optional() }).strict();

export const createPhoneBody = z.object({
  advisorId: uuid,
  number: phoneNumber,
  label: z.string().trim().max(60).default(''),
  isPrimary: z.boolean().default(false),
  portfolioId: uuid.optional(), // sin él, va a la cartera por defecto
});
export const updatePhoneBody = z
  .object({
    number: phoneNumber.optional(),
    label: z.string().trim().max(60).optional(),
    isPrimary: z.boolean().optional(),
    active: z.boolean().optional(),
    portfolioId: uuid.optional(),
  })
  .strict();

/** `advisorId` fijo = contacto directo con ese asesor; null/omitido = cualquier asesor disponible (rotativo). */
export const createButtonBody = z.object({
  key: slug,
  advisorId: uuid.nullable().optional(),
  portfolioId: uuid.nullable().optional(), // sin asesor fijo: cartera del botón (null = cartera por defecto)
  label: trimmed(1, 60),
  color: hexColor.default('#0f766e'),
  textColor: hexColor.default('#ffffff'),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});
export const updateButtonBody = z
  .object({
    advisorId: uuid.nullable().optional(),
    portfolioId: uuid.nullable().optional(),
    label: trimmed(1, 60).optional(),
    color: hexColor.optional(),
    textColor: hexColor.optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    active: z.boolean().optional(),
  })
  .strict();

/** Palabras con las que el visitante nombra la cartera (p. ej. el nombre de la entidad); el chat las usa para elegirla. */
const aliasList = z.array(trimmed(2, 60)).max(20);
export const createPortfolioBody = z.object({
  key: slug,
  name: trimmed(1, 120),
  description: z.string().trim().max(500).default(''),
  aliases: aliasList.default([]),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});
export const updatePortfolioBody = z
  .object({
    name: trimmed(1, 120).optional(),
    description: z.string().trim().max(500).optional(),
    aliases: aliasList.optional(),
    isDefault: z.literal(true).optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

export const createAdminBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(200),
    name: trimmed(1, 120),
    password: z.string().min(12).max(200),
    role: z.enum(['superadmin', 'company_admin']),
    companyId: uuid.nullable().optional(),
  })
  .refine((v) => (v.role === 'company_admin' ? !!v.companyId : !v.companyId), 'company_admin requiere companyId; superadmin no lo lleva');
export const updateAdminBody = z
  .object({ name: trimmed(1, 120).optional(), active: z.boolean().optional(), password: z.string().min(12).max(200).optional() })
  .strict();

export const rangeQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ---------- público ---------- */
export const pagePath = z.string().trim().max(200).regex(/^\/[^\s]*$/).default('/');
export const createSessionBody = z.object({ pagePath: pagePath.optional() }).default({});
export const eventBody = z.object({
  type: z.enum(['page_view', 'chat_open', 'button_click']),
  buttonKey: slug.optional(),
  path: pagePath.optional(),
});
export const handoffBody = z.object({
  buttonKey: slug.optional(),
  portfolioKey: slug.optional(),
  // Opcionales: ir a WhatsApp no exige que el visitante deje datos.
  name: trimmed(2, 80).optional(),
  reason: trimmed(3, 300).optional(),
  idempotencyKey: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_\-:.]+$/).optional(),
});

export const contentSchema = z.object({
  slug: z.string().max(80).optional(),
  siteName: z.string().max(120).optional(),
  generatedAt: z.string().max(40).optional(),
  sections: z
    .array(
      z.object({
        slug: z.string().min(1).max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
        title: z.string().trim().min(1).max(160),
        route: z.string().max(200).regex(/^\/[^\s]*$/, 'La ruta debe empezar con /'),
        text: z.string().trim().min(1).max(8000),
      }),
    )
    .min(1)
    .max(200),
});
export type ChatbotContent = z.infer<typeof contentSchema>;
