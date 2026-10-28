-- 007: se elimina el concepto de areas. El contacto es directo con el asesor:
--   * un boton apunta a un asesor concreto (advisor_id) o, si es NULL, a cualquier asesor disponible (rotativo)
--   * el round robin vive ahora en la empresa (companies.rr_cursor)

ALTER TABLE companies ADD COLUMN rr_cursor integer NOT NULL DEFAULT 0;

ALTER TABLE buttons ADD COLUMN advisor_id uuid;
ALTER TABLE buttons
  ADD CONSTRAINT buttons_advisor_fk FOREIGN KEY (advisor_id, company_id) REFERENCES advisors (id, company_id);
ALTER TABLE buttons DROP COLUMN area_id;

-- Al quitar la columna se eliminan tambien sus llaves foraneas compuestas hacia areas.
ALTER TABLE events DROP COLUMN area_id;
ALTER TABLE handoffs DROP COLUMN area_id;

DROP TABLE area_advisors;
DROP TABLE area_terms;
DROP TABLE areas;

CREATE INDEX handoffs_advisor_idx ON handoffs (company_id, advisor_id);
