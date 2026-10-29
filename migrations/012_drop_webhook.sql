-- 012: el webhook de salida se retira (el panel recibe los eventos en vivo por SSE); se eliminan sus columnas.
ALTER TABLE companies
  DROP COLUMN IF EXISTS webhook_url,
  DROP COLUMN IF EXISTS webhook_secret,
  DROP COLUMN IF EXISTS webhook_status,
  DROP COLUMN IF EXISTS webhook_last_at;
