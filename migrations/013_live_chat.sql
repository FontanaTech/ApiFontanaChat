-- 013: atencion en vivo del chatbot por asesores.
-- Amplia el modelo existente; `phones` sigue siendo la fuente de rutas de WhatsApp.

ALTER TABLE admins ADD COLUMN advisor_id uuid;
ALTER TABLE admins DROP CONSTRAINT admins_role_check;
ALTER TABLE admins DROP CONSTRAINT admins_check;
ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('superadmin', 'company_admin', 'supervisor', 'advisor'));
ALTER TABLE admins ADD CONSTRAINT admins_role_scope_check CHECK (
  (role = 'superadmin' AND company_id IS NULL AND advisor_id IS NULL) OR
  (role IN ('company_admin', 'supervisor') AND company_id IS NOT NULL AND advisor_id IS NULL) OR
  (role = 'advisor' AND company_id IS NOT NULL AND advisor_id IS NOT NULL)
);
ALTER TABLE admins ADD CONSTRAINT admins_advisor_fk FOREIGN KEY (advisor_id, company_id) REFERENCES advisors (id, company_id);
CREATE UNIQUE INDEX admins_advisor_unique_idx ON admins (advisor_id) WHERE advisor_id IS NOT NULL;

CREATE TABLE advisor_portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), advisor_id uuid NOT NULL,
  portfolio_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (advisor_id, portfolio_id),
  FOREIGN KEY (advisor_id, company_id) REFERENCES advisors(id, company_id), FOREIGN KEY (portfolio_id, company_id) REFERENCES portfolios(id, company_id)
);
CREATE INDEX advisor_portfolios_company_idx ON advisor_portfolios(company_id, portfolio_id);
INSERT INTO advisor_portfolios (company_id, advisor_id, portfolio_id)
SELECT DISTINCT company_id, advisor_id, portfolio_id FROM phones WHERE portfolio_id IS NOT NULL ON CONFLICT (advisor_id, portfolio_id) DO NOTHING;

CREATE TABLE advisor_status (
  advisor_id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','busy','offline')),
  last_activity_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (advisor_id, company_id),
  FOREIGN KEY (advisor_id, company_id) REFERENCES advisors(id, company_id)
);
INSERT INTO advisor_status (advisor_id, company_id, status)
SELECT id, company_id, CASE WHEN active THEN 'available' ELSE 'offline' END FROM advisors ON CONFLICT (advisor_id) DO NOTHING;

CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), public_session_id uuid NOT NULL,
  portfolio_id uuid, document text, visitor_name text, subject text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'BOT_ACTIVO' CHECK (status IN ('BOT_ACTIVO','EN_ESPERA_ASESOR','TOMADO_POR_ASESOR','REMITIDO_WHATSAPP','CERRADO','ABANDONADO')),
  current_advisor_id uuid, pending_transfer_to uuid, waiting_since timestamptz, taken_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(), last_interaction_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  close_reason text, summary text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (public_session_id), UNIQUE (id, company_id), FOREIGN KEY (public_session_id, company_id) REFERENCES public_sessions(id, company_id),
  FOREIGN KEY (portfolio_id, company_id) REFERENCES portfolios(id, company_id), FOREIGN KEY (current_advisor_id, company_id) REFERENCES advisors(id, company_id),
  FOREIGN KEY (pending_transfer_to, company_id) REFERENCES advisors(id, company_id)
);
CREATE INDEX chat_sessions_queue_idx ON chat_sessions(company_id, status, last_interaction_at DESC);
CREATE INDEX chat_sessions_portfolio_idx ON chat_sessions(company_id, portfolio_id, status);
CREATE INDEX chat_sessions_advisor_idx ON chat_sessions(company_id, current_advisor_id, status);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), chat_session_id uuid NOT NULL,
  sender_type text NOT NULL CHECK (sender_type IN ('USER','BOT','ADVISOR','SYSTEM')), advisor_id uuid,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000), metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (id, company_id),
  FOREIGN KEY (chat_session_id, company_id) REFERENCES chat_sessions(id, company_id), FOREIGN KEY (advisor_id, company_id) REFERENCES advisors(id, company_id)
);
CREATE INDEX chat_messages_session_idx ON chat_messages(chat_session_id, created_at, id);

CREATE TABLE chat_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), chat_session_id uuid NOT NULL,
  advisor_id uuid, target_advisor_id uuid, action text NOT NULL CHECK (action IN ('TAKE','RELEASE_BOT','RELEASE_QUEUE','TRANSFER_REQUEST','TRANSFER_ACCEPT','CLOSE')),
  created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY (chat_session_id, company_id) REFERENCES chat_sessions(id, company_id),
  FOREIGN KEY (advisor_id, company_id) REFERENCES advisors(id, company_id), FOREIGN KEY (target_advisor_id, company_id) REFERENCES advisors(id, company_id)
);
CREATE INDEX chat_assignments_session_idx ON chat_assignments(chat_session_id, created_at DESC);

CREATE TABLE chat_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), chat_session_id uuid NOT NULL,
  admin_id uuid REFERENCES admins(id), advisor_id uuid, action text NOT NULL, before_data jsonb, after_data jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (chat_session_id, company_id) REFERENCES chat_sessions(id, company_id), FOREIGN KEY (advisor_id, company_id) REFERENCES advisors(id, company_id)
);
CREATE INDEX chat_audit_session_idx ON chat_audit_logs(chat_session_id, created_at DESC);

