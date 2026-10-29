-- Permite eliminar teléfonos que ya no se usan sin perder el historial de derivaciones:
-- la derivación conserva el número en `phone_number` (instantánea) y `phone_id` queda en NULL.
ALTER TABLE handoffs DROP CONSTRAINT handoffs_phone_id_company_id_fkey;
ALTER TABLE handoffs ALTER COLUMN phone_id DROP NOT NULL;
ALTER TABLE handoffs
  ADD CONSTRAINT handoffs_phone_id_company_id_fkey
  FOREIGN KEY (phone_id, company_id) REFERENCES phones (id, company_id) ON DELETE SET NULL (phone_id);
