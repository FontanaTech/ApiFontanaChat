-- 004: auditoria de cambios administrativos

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid REFERENCES admins(id),
  company_id  uuid REFERENCES companies(id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  before_data jsonb,
  after_data  jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_company_idx ON audit_log (company_id, created_at);
CREATE INDEX audit_admin_idx ON audit_log (admin_id, created_at);
