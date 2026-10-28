-- 002: areas/procesos, terminos, asesores, telefonos, asignacion y botones.
-- Todas las tablas llevan company_id; las FK compuestas impiden cruzar datos entre empresas.

CREATE TABLE areas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  key              text NOT NULL CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(key) <= 60),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description      text NOT NULL DEFAULT '',
  assignment_mode  text NOT NULL DEFAULT 'round_robin' CHECK (assignment_mode IN ('round_robin', 'fixed')),
  fixed_phone_id   uuid,
  rr_cursor        integer NOT NULL DEFAULT 0,
  sort_order       integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key),
  UNIQUE (id, company_id)
);

CREATE TABLE area_terms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  area_id     uuid NOT NULL,
  term        text NOT NULL CHECK (length(term) BETWEEN 2 AND 80),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (area_id, term),
  FOREIGN KEY (area_id, company_id) REFERENCES areas (id, company_id)
);
CREATE INDEX area_terms_company_idx ON area_terms (company_id);

CREATE TABLE advisors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id)
);
CREATE INDEX advisors_company_idx ON advisors (company_id);

CREATE TABLE phones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  advisor_id  uuid NOT NULL,
  number      text NOT NULL CHECK (number ~ '^[1-9][0-9]{7,14}$'),
  label       text NOT NULL DEFAULT '',
  is_primary  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  FOREIGN KEY (advisor_id, company_id) REFERENCES advisors (id, company_id)
);
CREATE INDEX phones_company_idx ON phones (company_id);
CREATE INDEX phones_advisor_idx ON phones (advisor_id);

ALTER TABLE areas
  ADD CONSTRAINT areas_fixed_phone_fk FOREIGN KEY (fixed_phone_id, company_id) REFERENCES phones (id, company_id),
  ADD CONSTRAINT areas_fixed_requires_phone CHECK (assignment_mode <> 'fixed' OR fixed_phone_id IS NOT NULL);

CREATE TABLE area_advisors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  area_id     uuid NOT NULL,
  advisor_id  uuid NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (area_id, advisor_id),
  FOREIGN KEY (area_id, company_id) REFERENCES areas (id, company_id),
  FOREIGN KEY (advisor_id, company_id) REFERENCES advisors (id, company_id)
);
CREATE INDEX area_advisors_company_idx ON area_advisors (company_id);

CREATE TABLE buttons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  key         text NOT NULL CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(key) <= 60),
  area_id     uuid NOT NULL,
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  color       text NOT NULL DEFAULT '#0f766e' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  text_color  text NOT NULL DEFAULT '#ffffff' CHECK (text_color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key),
  UNIQUE (id, company_id),
  FOREIGN KEY (area_id, company_id) REFERENCES areas (id, company_id)
);
CREATE INDEX buttons_company_idx ON buttons (company_id);
