-- 001: empresas, origenes permitidos, administradores y sesiones administrativas

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE allowed_origins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  origin      text NOT NULL CHECK (origin ~ '^https?://[^/]+$'),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, origin)
);
CREATE INDEX allowed_origins_company_idx ON allowed_origins (company_id);

CREATE TABLE admins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE CHECK (email = lower(email)),
  name           text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('superadmin', 'company_admin')),
  company_id     uuid REFERENCES companies(id),
  active         boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'superadmin' AND company_id IS NULL) OR (role = 'company_admin' AND company_id IS NOT NULL))
);

CREATE TABLE admin_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid NOT NULL REFERENCES admins(id),
  token_hash  text NOT NULL UNIQUE,
  csrf_token  text NOT NULL,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);
