-- 005: contenido publico sincronizado para el chatbot (por empresa)

ALTER TABLE companies
  ADD COLUMN content_url        text,
  ADD COLUMN content_json       jsonb,
  ADD COLUMN content_hash       text,
  ADD COLUMN content_synced_at  timestamptz,
  ADD COLUMN content_status     text NOT NULL DEFAULT 'never' CHECK (content_status IN ('never', 'ok', 'error')),
  ADD COLUMN content_error      text;
