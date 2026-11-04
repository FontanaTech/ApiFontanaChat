-- La cartera que el sistema asignó al pasar a la cola (la única activa o la cartera por defecto), sin que el visitante
-- la eligiera: si después dice la suya, la reemplaza y la conversación pasa a los asesores de esa cartera.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS portfolio_auto boolean NOT NULL DEFAULT false;
