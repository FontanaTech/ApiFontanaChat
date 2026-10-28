-- 009: carteras. Los telefonos se organizan por cartera dentro de cada empresa.
-- Una cartera agrupa los telefonos/asesores que atienden a un cliente acreedor; cada una reparte por turnos
-- entre sus asesores. Una cartera por empresa es "por defecto" y recibe las derivaciones sin cartera identificada.

CREATE TABLE portfolios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  key         text NOT NULL CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(key) <= 60),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  aliases     text[] NOT NULL DEFAULT '{}',
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  rr_cursor   integer NOT NULL DEFAULT 0,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key),
  UNIQUE (id, company_id)
);
-- A lo sumo una cartera por defecto por empresa.
CREATE UNIQUE INDEX portfolios_one_default_idx ON portfolios (company_id) WHERE is_default;

-- Cada empresa existente recibe la cartera inicial "pruebas" (por defecto) y sus telefonos actuales pasan a ella.
INSERT INTO portfolios (company_id, key, name, description, is_default)
SELECT id, 'pruebas', 'Cartera de pruebas', 'Cartera inicial: agrupa los numeros de prueba hasta recibir cada cartera real.', true
FROM companies;

-- portfolio_id queda NULL-able por compatibilidad con la version anterior de la API durante el despliegue;
-- la aplicacion siempre lo asigna (cartera por defecto si no se indica).
ALTER TABLE phones ADD COLUMN portfolio_id uuid;
ALTER TABLE phones
  ADD CONSTRAINT phones_portfolio_fk FOREIGN KEY (portfolio_id, company_id) REFERENCES portfolios (id, company_id);
UPDATE phones p SET portfolio_id = (SELECT w.id FROM portfolios w WHERE w.company_id = p.company_id AND w.is_default);
CREATE INDEX phones_portfolio_idx ON phones (portfolio_id);

-- Un boton puede apuntar a una cartera (NULL = cartera por defecto); si ademas tiene asesor fijo, manda el asesor.
ALTER TABLE buttons ADD COLUMN portfolio_id uuid;
ALTER TABLE buttons
  ADD CONSTRAINT buttons_portfolio_fk FOREIGN KEY (portfolio_id, company_id) REFERENCES portfolios (id, company_id);

-- Cada derivacion guarda la cartera que la atendio (para registros y metricas).
ALTER TABLE handoffs ADD COLUMN portfolio_id uuid;
ALTER TABLE handoffs
  ADD CONSTRAINT handoffs_portfolio_fk FOREIGN KEY (portfolio_id, company_id) REFERENCES portfolios (id, company_id);
CREATE INDEX handoffs_portfolio_idx ON handoffs (company_id, portfolio_id);
