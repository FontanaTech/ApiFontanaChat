-- 003: sesiones publicas, derivaciones a WhatsApp y eventos

CREATE TABLE public_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  token_hash  text NOT NULL UNIQUE,
  origin      text NOT NULL,
  page_path   text NOT NULL DEFAULT '/',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  UNIQUE (id, company_id)
);
CREATE INDEX public_sessions_company_idx ON public_sessions (company_id, created_at);

CREATE TABLE handoffs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id),
  session_id          uuid NOT NULL,
  idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  area_id             uuid NOT NULL,
  button_id           uuid,
  advisor_id          uuid NOT NULL,
  phone_id            uuid NOT NULL,
  phone_number        text NOT NULL,
  visitor_name        text NOT NULL,
  reason              text NOT NULL,
  wa_url              text NOT NULL,
  status              text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'whatsapp_clicked')),
  whatsapp_clicked_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, session_id, idempotency_key),
  UNIQUE (id, company_id),
  FOREIGN KEY (session_id, company_id) REFERENCES public_sessions (id, company_id),
  FOREIGN KEY (area_id, company_id) REFERENCES areas (id, company_id),
  FOREIGN KEY (button_id, company_id) REFERENCES buttons (id, company_id),
  FOREIGN KEY (advisor_id, company_id) REFERENCES advisors (id, company_id),
  FOREIGN KEY (phone_id, company_id) REFERENCES phones (id, company_id)
);
CREATE INDEX handoffs_company_idx ON handoffs (company_id, created_at);

CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  session_id  uuid NOT NULL,
  type        text NOT NULL CHECK (type IN ('page_view', 'chat_open', 'button_click', 'handoff_created', 'whatsapp_click')),
  button_id   uuid,
  area_id     uuid,
  handoff_id  uuid,
  page_path   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, company_id) REFERENCES public_sessions (id, company_id),
  FOREIGN KEY (button_id, company_id) REFERENCES buttons (id, company_id),
  FOREIGN KEY (area_id, company_id) REFERENCES areas (id, company_id),
  FOREIGN KEY (handoff_id, company_id) REFERENCES handoffs (id, company_id)
);
CREATE INDEX events_company_idx ON events (company_id, created_at);
CREATE INDEX events_type_idx ON events (company_id, type, created_at);
