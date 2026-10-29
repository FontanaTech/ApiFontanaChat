-- 011: ingresos únicos (visitante = IP + navegador, con huella irreversible) y webhook de salida por empresa.

-- Visitante: huella (HMAC de IP + user-agent; la IP no se guarda en claro) y datos del dispositivo.
ALTER TABLE public_sessions
  ADD COLUMN visitor_hash text,
  ADD COLUMN browser text,
  ADD COLUMN os text,
  ADD COLUMN device text;

-- Un "ingreso" es el primer page_view de un visitante tras 30 minutos sin actividad; los cambios de vista no cuentan.
ALTER TABLE events
  ADD COLUMN visitor_hash text,
  ADD COLUMN is_visit boolean NOT NULL DEFAULT false;
CREATE INDEX events_visitor_idx ON events (company_id, visitor_hash, created_at) WHERE visitor_hash IS NOT NULL;
CREATE INDEX events_visit_idx ON events (company_id, created_at) WHERE is_visit;

-- Webhook de salida (una URL por empresa) con firma HMAC; el secreto nunca se devuelve por la API.
ALTER TABLE companies
  ADD COLUMN webhook_url text,
  ADD COLUMN webhook_secret text,
  ADD COLUMN webhook_status text,
  ADD COLUMN webhook_last_at timestamptz;
