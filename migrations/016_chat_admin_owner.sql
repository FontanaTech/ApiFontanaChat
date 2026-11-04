-- "Tomar control" lo hace el usuario del panel que pulsa el botón: la conversación queda a su nombre y el visitante ve
-- que lo atiende en vivo. Los asesores de WhatsApp (números) solo reciben remisiones; si la cuenta está vinculada a uno,
-- también queda registrado (current_advisor_id).
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS current_admin_id uuid REFERENCES admins(id);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES admins(id);
ALTER TABLE chat_assignments ADD COLUMN IF NOT EXISTS admin_id uuid REFERENCES admins(id);
