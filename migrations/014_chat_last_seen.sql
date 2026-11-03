-- Última actividad del visitante en cualquier parte de la página (no solo en el chat): define el abandono.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
