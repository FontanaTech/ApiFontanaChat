-- 008: consumo diario del modelo de IA por empresa y limite de tokens por empresa.
-- Sirve para repartir la cuota gratuita del proveedor entre los sitios y no quedarse sin servicio de IA a media jornada.

ALTER TABLE companies
  ADD COLUMN llm_daily_tokens integer CHECK (llm_daily_tokens IS NULL OR llm_daily_tokens >= 0);

CREATE TABLE llm_usage (
  company_id  uuid NOT NULL REFERENCES companies(id),
  day         date NOT NULL,
  requests    integer NOT NULL DEFAULT 0,
  tokens      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, day)
);
CREATE INDEX llm_usage_day_idx ON llm_usage (day);
