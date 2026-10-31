# Chat en vivo y toma de control

La migración `013_live_chat.sql` agrega conversaciones persistentes, mensajes, autorizaciones por cartera, presencia, asignaciones y auditoría. `phones` continúa siendo la fuente única de rutas de WhatsApp.

## Estados

`BOT_ACTIVO` → `EN_ESPERA_ASESOR` → `TOMADO_POR_ASESOR` → `REMITIDO_WHATSAPP` o `CERRADO`. Después de 30 minutos sin interacción, una sesión abierta puede pasar a `ABANDONADO`. La toma bloquea la fila SQL: solo un asesor obtiene el control y cualquier respuesta del bot que estuviera en curso se descarta.

## API pública

Base: `/api/v1/public/:slug`. Requiere origen permitido y token Bearer de sesión.

| Método | Ruta | Uso |
|---|---|---|
| `POST` | `/chat` | Con `live: true` registra el mensaje. Acepta `portfolioKey`, `document`, `name`, `subject` e `history`. |
| `GET` | `/conversation` | Estado e historial persistido de la sesión. |
| `WS` | `/live` | Entrega snapshots al widget cuando cambia la conversación. |

El WebSocket autentica el token en el subprotocolo `fc-token.*`, no en la URL, y valida el encabezado `Origin`. `FontanaChatClient.watchConversation()` lo utiliza automáticamente y cae a sondeo corto si el proxy no admite WebSocket. El cliente actualizado envía `live: true`; widgets anteriores conservan la derivación directa a WhatsApp hasta ser actualizados.

## API administrativa

Base: `/api/v1/admin/companies/:companyId`. Requiere cookie, CSRF, empresa y permiso de cartera para el rol `advisor`.

| Método | Ruta | Acción |
|---|---|---|
| `GET` | `/chat-sessions` | Bandeja. Filtros: `status`, `portfolioId`, `advisorId`, `search`, `pending`. |
| `GET` | `/chat-sessions/:chatId` | Detalle e historial. |
| `POST` | `/chat-sessions/:chatId/take` | Toma exclusiva; un gestor envía `advisorId`. |
| `POST` | `/chat-sessions/:chatId/messages` | Envía `{message}` como asesor. |
| `PATCH` | `/chat-sessions/:chatId/portfolio` | Corrige `{portfolioId}` con auditoría. |
| `POST` | `/chat-sessions/:chatId/release` | `{destination: "bot" | "queue"}`. |
| `POST` | `/chat-sessions/:chatId/transfer` | Solicita `{advisorId}`. |
| `POST` | `/chat-sessions/:chatId/accept-transfer` | El destino acepta. |
| `POST` | `/chat-sessions/:chatId/whatsapp` | Selección manual o asesor disponible con menor carga de la cartera. |
| `POST` | `/chat-sessions/:chatId/close` | `{reason, summary?}`. |
| `GET` | `/advisor-presence` | Presencia, carga, carteras y atención diaria. |
| `PATCH` | `/advisor-presence/:advisorId` | Cambia a `available`, `busy` u `offline`. |

Motivos de cierre: `resuelto`, `remitido`, `abandono`, `informacion_entregada`, `otro`.

## Eventos del panel

El SSE autenticado `GET /api/v1/admin/companies/:companyId/live` publica `conversation_created`, `chat_message`, `chat_status`, `chat_portfolio`, `chat_assignment` y `advisor_status`, además de los eventos históricos. El sobre es `{type, at, data}` y nunca contiene números ni enlaces `wa.me`.

## Seed ficticio

Después de migrar, `npm run seed:live-demo` crea `fontanaweb-demo`, Flamingo, Offcorss, Supra y Lebon, ocho asesores y cuatro cuentas de panel. La contraseña predeterminada es `FontanaDemo2026!`; en un entorno compartido se debe definir `LIVE_DEMO_PASSWORD`.

