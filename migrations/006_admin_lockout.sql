-- 006: bloqueo temporal por intentos fallidos de login

ALTER TABLE admins
  ADD COLUMN failed_logins  integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until   timestamptz;
