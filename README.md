# Fontanachat API

API central para los sitios estáticos de cuatro casas de cobranza (comienza con **AAgora BPO**, slug `aagora-bpo`).
Un único servicio Node.js/Express que:

- expone la API pública del chat/derivación a WhatsApp (`/api/v1/public/:slug/...`),
- expone la API administrativa (`/api/v1/admin/...`) y sirve el panel React en **`/admin`** (producción),
- se conecta a **PostgreSQL (Neon)** y, solo desde el backend, a **Ollama**.

Stack: Node ≥ 20, TypeScript, Express, `pg`, Zod, Argon2id (`@node-rs/argon2`), React + Vite (panel), Vitest + Supertest + PGlite (pruebas).

---

## 1. Estructura

```
.
├─ migrations/            SQL incremental 001..006 (+ tabla schema_migrations con checksum)
├─ docs/database.dbml     DBML actualizado (una prueba verifica que coincide con las migraciones)
├─ src/                   API (arquitectura MVC)
│  ├─ config/env.ts         variables de entorno validadas con Zod
│  ├─ db/                   pool pg (Neon), interfaz Db/Queryable, ejecutor de migraciones
│  ├─ models/               acceso a datos (consultas parametrizadas, siempre filtradas por company_id)
│  ├─ controllers/          admin, auth y público (validan con Zod, orquestan modelos/servicios)
│  ├─ routes/index.ts       rutas públicas y administrativas
│  ├─ middleware/security.ts  sesión admin + CSRF, autorización por empresa, CORS por empresa, rate limit, errores
│  ├─ services/             assignment (round robin entre asesores / botón con asesor fijo), handoff (idempotente), chat, ollama,
│  │                        contentSync (anti-SSRF), password (Argon2id)
│  ├─ validation/schemas.ts esquemas Zod
│  ├─ scripts/              migrate, createAdmin, seedAagora
│  ├─ app.ts / server.ts
├─ admin/                 panel administrativo (React + TS, Vite) → admin/dist
├─ client/                cliente TS reutilizable para los sitios (+ generador de chatbot-content.json)
├─ tests/ y client/tests/ pruebas
├─ .env.example · .gitignore · package-lock.json
```

## 2. Comandos locales

```bash
npm install
cp .env.example .env          # completa DATABASE_URL, SESSION_SECRET, OLLAMA_MODEL
npm run db:migrate            # aplica migraciones a la base de DATABASE_URL
npm run admin:create -- --email tu@correo --name "Tu Nombre"   # primer superadmin
npm run seed:aagora           # (opcional) empresa aagora-bpo SIN números
npm run dev                   # API en http://0.0.0.0:10000 (nodemon, reinicia al guardar; tarda ~20 s) + panel Vite en http://localhost:5174/admin/
npm run admin:password -- --email tu@correo   # cambia la contraseña de un admin (también lo desbloquea)
npm test                      # pruebas (no requieren Neon ni Ollama)
npm run build                 # compila API (dist/), panel (admin/dist) y cliente (client/dist)
npm start                     # node dist/server.js  (NODE_ENV=production sirve /admin)
npm run typecheck
```

- **Puertos en desarrollo (fijos):** API `10000` · panel admin `5174` (`strictPort`: si está ocupado, falla en vez de cambiar de puerto) · sitio de AAgora `5173`.
- La API escucha en `0.0.0.0:10000` (`HOST`/`PORT`).
- En desarrollo el panel corre en Vite (puerto fijo 5174) con proxy a la API; en producción lo sirve Express en `/admin`.
- `GET /health` → `{status, db}` (200 aunque la BD esté caída, con `status:"degraded"`).

## 3. Migrar Neon

1. En Neon crea el proyecto/base y copia la cadena de conexión (con `?sslmode=require`; la del *pooler* también sirve).
2. Ponla en `.env` como `DATABASE_URL=...` (nunca en el repositorio).
3. `npm run db:migrate`. Aplica en orden los `.sql` pendientes dentro de una transacción cada uno y guarda su checksum
   en `schema_migrations`. Es idempotente; si alguien edita una migración ya aplicada, falla (crea una nueva en su lugar).
4. Para cambios futuros: añade `migrations/008_*.sql` y actualiza `docs/database.dbml`.

## 4. Crear el primer administrador

No hay alta pública. El primer superadmin se crea solo por línea de comandos:

```bash
npm run admin:create -- --email tu@correo.com --name "Tu Nombre"            # pide la contraseña (≥ 12 caracteres)
npm run admin:create -- --email a@x.com --name "Ana" --role company_admin --company aagora-bpo
# no interactivo: ADMIN_PASSWORD=... npm run admin:create -- --email ... --name ...
```

Luego entra a `http://localhost:5174/admin/` (dev) o `https://TU-SERVICIO.onrender.com/admin` (prod).
Un superadmin puede crear más administradores desde el panel (Administradores). Seguridad: Argon2id, cookie de sesión
`HttpOnly` + `SameSite=Strict` (+ `Secure` y prefijo `__Host-` en producción), token de sesión guardado solo como HMAC,
CSRF por cabecera `X-CSRF-Token`, bloqueo de 15 min tras 5 fallos, rate limit en login.

## 5. Configurar AAgora

Opción A (panel, recomendada): *Empresas → Nueva empresa → «Prellenar AAgora BPO»* (slug `aagora-bpo`), con los dominios del sitio.
Opción B: `npm run seed:aagora` (opcionalmente `AAGORA_ORIGINS=https://...,http://localhost:5173` y `AAGORA_CONTENT_URL=...`; `--only-company` omite el botón).
El seed crea la empresa, dominios y un botón inicial «Hablar con un asesor». **No crea asesores ni teléfonos.**

No existen «áreas»: el contacto es directo con el asesor. Los teléfonos se organizan por **carteras** dentro de cada empresa (una cartera agrupa los teléfonos y asesores que atienden a un cliente acreedor).
Cada cartera reparte las conversaciones por turnos (round robin) entre sus asesores con teléfono activo; un botón puede fijarse a un asesor concreto o a una cartera. Toda empresa tiene una
cartera **por defecto** que recibe las derivaciones sin cartera identificada (AAgora arranca con «Cartera de pruebas», que contiene el número actual). Si el visitante nombra una cartera en el chat
(las *palabras que la identifican* se configuran en la pestaña **Carteras**), se le pasa con los asesores de esa cartera; si esa cartera no tiene asesores disponibles, cae a la por defecto.

La pestaña *General* muestra un checklist con lo que falta (`GET /companies/:id/setup`). Los pasos requeridos son tres:

0. **Carteras**: la cartera por defecto ya existe; crea las demás cuando recibas cada cartera y asigna sus teléfonos en **Asesores y números** (cada teléfono pertenece a una cartera).
1. **Dominios**: el origen real del sitio (ej. `https://www.tudominio.com`, sin ruta) y `http://localhost:5173` (o el puerto del sitio) para pruebas.
2. **Asesores y números**: crea asesores y escribe **los números reales** (formato internacional con código de país). El sistema no trae ninguno.
3. **General**: URL de `chatbot-content.json` (dominio permitido, https) → *Sincronizar ahora*.

Opcionales: **Botones** (texto, colores y asesor fijo o «cualquiera») y `OLLAMA_MODEL` en el `.env` (sin modelo, el chat deriva a un asesor en lugar de responder dudas).

Mientras no haya asesor activo con teléfono activo, `GET /config` devuelve `available:false`, `POST /handoffs` responde 409
`no_advisor_available` y el chat no ofrece números ni enlaces.

## 6. Contrato público (resumen)

Todas bajo `/api/v1/public/:slug`. Exigen cabecera `Origin` registrada para esa empresa (CORS por empresa).

| Método y ruta | Descripción |
|---|---|
| `POST /sessions` | Crea sesión → `{token, expiresAt}` (token temporal; se guarda hash) |
| `GET /config` | `{company, available, portfolios[{key,name}], buttons[{key,label,color,textColor,available}]}` (sin teléfonos) |
| `POST /events` | `page_view`, `chat_open`, `button_click` |
| `POST /chat` | `{message, history?}` → `{type: answer\|handoff_offer\|fallback, message, link?, waUrl?, handoffId?}` (con `waUrl`, el sitio muestra «Continuar en WhatsApp»; sin formulario) |
| `POST /handoffs` | `{buttonKey?, portfolioKey?, name?, reason?}` (nombre y motivo opcionales) + `Idempotency-Key` → `{handoffId, advisorName, waUrl, ...}` (sin `buttonKey` o con botón rotativo, reparte por turnos) |
| `POST /handoffs/:id/whatsapp-click` | Registra `whatsapp_click` (un clic, **no** «mensaje enviado») |

`Authorization: Bearer <token>` en todas salvo `sessions`. `waUrl` (`https://wa.me/<número vigente>?text=...`) solo la construye el servidor
con el teléfono leído de la base en ese instante; el usuario debe pulsar «Enviar» en WhatsApp.

**Datos de contacto.** El sitio se analiza al sincronizarlo: las líneas con teléfono, correo, dirección u horario se identifican (un NIT no cuenta como teléfono). Si el visitante pregunta por el teléfono, 
el correo, la dirección o el horario, el chat responde al instante con ese dato tal cual lo publica el sitio (sin repetirlo por cada sede y prefiriendo la sede que nombre), sin usar el modelo. Si el sitio no publica el dato, no lo inventa y pasa a un asesor.

**Chat.** Reglas deterministas del servidor primero (saludo, pedido de humano, pagos/acuerdos/saldos/paz y salvo/jurídico/datos personales →
ofrecer un asesor sin consultar al modelo). Si no, Ollama (solo backend, `OLLAMA_BASE_URL`/`OLLAMA_MODEL`, timeout `OLLAMA_TIMEOUT_MS`, salida JSON
validada con Zod) recibe **toda la información del sitio sincronizado** (hasta `CHAT_CONTEXT_MAX_CHARS`; si el sitio es más grande se priorizan las
secciones más relacionadas con la pregunta) y responde dudas rápidas combinando secciones. Cuando no tiene la información, el modelo responde `handoff` y el chat ofrece
pasar con un asesor **sin pedir datos**: el servidor crea la derivación (una por sesión) y devuelve el enlace `waUrl` de WhatsApp ya armado (`type:"handoff_offer"`). Una respuesta que incluya un teléfono,
correo o enlace que el sitio no publica se descarta y también se deriva. Si el modelo trae `sectionSlug`, el enlace se construye con el origen de la URL de contenido
de esa empresa. Si Ollama falla y la página no responde la pregunta → `type:"fallback"` con `waUrl`; si no hay asesores disponibles, `type:"fallback"` sin `waUrl`.

**Mensajes del chat variados.** Al pasar con un asesor, el modelo escribe una frase corta y específica de lo que preguntó el visitante (en la misma respuesta, sin gastar otra llamada; se descarta si trae datos, enlaces o afirmaciones negativas) y el cierre («Te paso con un asesor por WhatsApp», «Te conecto…») rota entre varias redacciones. Las respuestas sin modelo (pedir un asesor, temas sensibles, información no publicada) también rotan. El texto que viaja a WhatsApp es **preestablecido**: «Hola EMPRESA. Quiero hablar con un asesor. (Ref. XXXX)», sin consumir el modelo.

**Ingresos únicos.** Al crear la sesión pública el servidor toma la IP y el user-agent de la petición: guarda una huella irreversible (HMAC con `SESSION_SECRET` y la empresa; **la IP no se guarda**) y el navegador, sistema y tipo de dispositivo. Un `page_view` cuenta como **ingreso** solo si ese visitante no tuvo actividad en los últimos 30 minutos: cambiar de vista, recargar o abrir otra pestaña no suma. Los bots no cuentan. Las métricas muestran *Ingresos* (y visitantes únicos), *Vistas de página* y el desglose por dispositivo, navegador y sistema; el panel se actualiza solo cada 15 s. El sitio no necesita cambios: sigue enviando `page_view` en cada vista y el servidor decide si es un ingreso. Los ingresos se miden desde esta versión (los `page_view` anteriores no tienen huella).

**Datos en vivo en el panel (SSE).** *Métricas* y *Registros* cargan los datos una sola vez y abren `GET /api/v1/admin/companies/:id/live` (Server-Sent Events; sesión de administrador con acceso a la empresa). La API publica cada evento (`page_view` con `isVisit`, `chat_open`, `button_click`, `handoff_created`, `whatsapp_click`) en un bus **en memoria**: publicar no toca la base de datos y, sin paneles abiertos, no hace nada. El panel suma los contadores al instante; solo las derivaciones provocan una recarga agrupada (cuadros por asesor y cartera). Hay una recarga de respaldo cada 5 min, otra al reconectar o volver a la pestaña, y el canal se pausa con la pestaña oculta. Límites: 50 conexiones en total y 20 por empresa; cada conexión se renueva a los 30 min (una sesión revocada no queda escuchando) y se envía un `ping` cada 25 s para que el proxy no la cierre. Funciona con una sola instancia del servicio (plan gratuito de Render); con varias habría que pasar el bus por Postgres `LISTEN/NOTIFY` o Redis. Los eventos no incluyen teléfonos ni datos del visitante.

**Contenido (`/chatbot-content.json`).** Esquema: `{slug?, siteName?, sections:[{slug,title,route,text}]}`. El `client/` incluye
`buildChatbotContent()` y `chatbotContentPlugin()` (plugin Vite) para generarlo en el build desde el mismo módulo de textos que usan los componentes.
Sincronización (admin): solo la URL guardada por el admin; https (http solo con `ALLOW_LOCAL_CONTENT_URLS=true` y `NODE_ENV≠production`),
origen exacto igual a un dominio permitido de la empresa, sin credenciales, puerto 443, sin IP/host privados (se verifica también la IP resuelta en la conexión),
**sin redirecciones** (se rechazan todas; configura la URL final), `Content-Type` JSON, tope `CONTENT_MAX_BYTES`, timeout. Se guarda hash, fecha y estado.

**Cliente de los sitios** (`client/src`, compilado a `client/dist`): `FontanaChatClient({baseUrl, slug})` con `ensureSession`, `getConfig`, `track`, `chat`,
`createHandoff` (reutiliza la clave de idempotencia entre reintentos), `whatsappClicked`. Sesión en `sessionStorage` (por pestaña); ante 401 renueva y reintenta una vez;
errores → `ApiError` con `retryable` (la UI muestra «Reintentar»; nunca se inventa un teléfono).

**Apertura automática del chat** (`createAutoOpen` en `client/src/autoOpen.ts`): el widget se abre al cargar la página; si el visitante lo cierra y la página
permanece inactiva 2 minutos (`idleMs`, sin mouse, teclado, scroll ni toque), vuelve a aparecer. Con la pestaña oculta no reaparece. Se repite en cada cierre.

## 7. Despliegue en Render (un solo Web Service)

El repo incluye `render.yaml` (Blueprint). Pasos con el **plan gratuito** (pruebas):

1. Sube el proyecto a GitHub (el `.gitignore` ya excluye `.env`, `node_modules` y los builds).
2. En Render: **New → Blueprint** → elige el repositorio → te pide `DATABASE_URL` (cadena de Neon; solo se escribe ahí). `SESSION_SECRET` se genera solo.
3. Render ejecuta: Build `npm ci --include=dev && npm run build` · Start `npm run migrate:prod && npm start` (las migraciones son idempotentes) · Health `/health`.
4. Abre `https://TU-SERVICIO.onrender.com/admin`, entra con tu superadmin y, en la empresa **aagora-bpo**:
   - **Dominios**: el dominio https real del sitio (sin ruta). Quita `http://localhost…` cuando termines de probar.
   - **General**: URL `https://TU-DOMINIO/chatbot-content.json` → *Sincronizar ahora*. (`ALLOW_LOCAL_CONTENT_URLS` se ignora en producción.)
5. En el sitio, `VITE_API_BASE_URL=https://TU-SERVICIO.onrender.com` y vuelve a compilar.

Limitaciones del plan gratuito: el servicio **se duerme tras 15 min sin tráfico** y la primera visita espera ~30–60 s (el widget agota a los 15 s la carga inicial);
512 MB de RAM; no hay Ollama. Para pruebas, un ping cada 10 min a `/health` (p. ej. UptimeRobot) lo mantiene despierto. Sin `OLLAMA_MODEL` el chat responde
con el texto de la página (atajo) y pasa a WhatsApp cuando no alcanza.

- Variables: `NODE_ENV=production`, `DATABASE_URL`, `SESSION_SECRET` (≥ 32 caracteres), `OLLAMA_*`, `TRUST_PROXY=1`, `NODE_VERSION=22`.
- **Rendimiento:** empresa, orígenes y sesión pública se cachean `PUBLIC_CACHE_TTL_SECONDS` (15 s; los cambios hechos en el panel la invalidan al instante), el sitio procesado se guarda
  en memoria por hash de contenido y Ollama conserva el modelo cargado (`OLLAMA_KEEP_ALIVE`) con ventana fija (`OLLAMA_NUM_CTX`). Los teléfonos nunca se cachean. El chat responde **al instante, sin modelo**, cuando una sección del sitio cubre las palabras de la pregunta (`CHAT_FAST_SCORE`, 0 lo desactiva), guarda en caché las preguntas repetidas y precalienta el modelo al arrancar y al sincronizar. En CPU sin GPU, `qwen2.5:3b` tarda ~5–15 s por pregunta nueva y `qwen2.5:1.5b` ~3–6 s (menos preciso); con GPU o un servidor de modelos tarda 1–2 s. Neon suspende la base
  tras unos minutos sin uso: la primera petición después puede tardar 1–2 s.
- **Modelo de IA (opcional).** Render no incluye Ollama. Hay dos caminos:
  - **Proveedor alojado compatible con OpenAI** (recomendado para empezar, con plan gratuito): `LLM_PROVIDER=openai`, `LLM_BASE_URL`, `LLM_MODEL` y `LLM_API_KEY`.
    Con Groq: `https://api.groq.com/openai/v1` y `qwen/qwen3.8-27b` (el `render.yaml` ya los trae; solo falta pegar `LLM_API_KEY` en Render → Environment).
    Funciona igual con Gemini (`https://generativelanguage.googleapis.com/v1beta/openai/`) u OpenRouter. Los planes gratuitos tienen límites por minuto y por día: si se
    agotan, el proveedor responde 429, la API lo pausa unos segundos y el chat usa el texto del sitio o pasa a WhatsApp. Antes de enviar al modelo se enmascaran los números
    largos que escriba el visitante (cédulas, cuentas) y los temas sensibles ya se desvían a un asesor sin consultar al modelo. Revisa las condiciones de datos de cada proveedor.
  - **Ollama** en un servidor tuyo: `OLLAMA_BASE_URL`/`OLLAMA_MODEL` (`127.0.0.1:11434` solo existe si corre en la misma máquina).
  **Control de consumo.** Cada consulta al modelo suma sus tokens al día (UTC) de la empresa (`llm_usage`). `LLM_DAILY_TOKEN_LIMIT` pone un tope global y, en el panel
  (empresa → General → *Uso del modelo de IA*), el superadmin fija un límite diario por empresa para repartir la cuota gratuita. Al llegar al límite el chat **no se detiene**: deja de usar el
  modelo y responde con el texto del sitio o pasa a un asesor. Si el proveedor responde 429, la API se pausa (hasta 10 min) y reintenta sola.
  Sin ningún modelo, el chat responde con el texto de la página y, si no alcanza, pasa a WhatsApp.

## 8. Pruebas realizadas (`npm test`)

Las pruebas corren la API real contra **PGlite** (PostgreSQL real en memoria) aplicando las mismas migraciones SQL. Cubren: aislamiento entre empresas
(API y claves foráneas compuestas), teléfono actualizado sin recompilar y con historial, asesor/teléfono inactivo, doble handoff idempotente (también en paralelo),
round robin entre asesores y botón con asesor fijo, chat con todo el sitio como contexto, sin respuesta → asesor, respuestas con datos inventados descartadas, checklist de puesta en marcha,
caché invalidada desde el panel, Ollama caído, cliente Ollama real (puerto cerrado y parámetros de carga),
URL de contenido no permitida (dominio, http, localhost, IP privada/metadatos, IPv6, credenciales, puerto, redirección, tamaño, tipo, esquema, slug), eventos y métricas,
CORS/OPTIONS, rate limit, límites de tamaño, login/CSRF/bloqueo/Argon2id, ausencia de alta pública, auditoría sin secretos, seed idempotente, migraciones/DBML,
panel en `/admin` y cabeceras, y el cliente TypeScript.

### Probar en localhost (con tu base y tu Ollama)

```bash
npm run dev      # API :10000, panel :5174/admin/, sitio de AAgora :5173
curl http://127.0.0.1:10000/health
# Sesión pública (el Origin debe estar registrado en Dominios, ej. http://localhost:5173):
curl -s -X POST http://127.0.0.1:10000/api/v1/public/aagora-bpo/sessions -H "Origin: http://localhost:5173" -H "content-type: application/json" -d "{}"
curl -s -X POST http://127.0.0.1:10000/api/v1/public/aagora-bpo/chat -H "Origin: http://localhost:5173" -H "Authorization: Bearer <token>" -H "content-type: application/json" -d '{"message":"¿Qué servicios ofrecen?"}'
```
Para sincronizar contenido desde `http://localhost:5173/chatbot-content.json` en desarrollo: `ALLOW_LOCAL_CONTENT_URLS=true` y registrar ese origen.
Para probar la salida de producción: `npm run build && NODE_ENV=production npm start` y abrir `http://localhost:10000/admin`
(en producción la cookie es `Secure`: el navegador solo la acepta por https o `localhost`).

## 9. Qué NO se pudo probar sin tus datos

- **Conexión real a Neon** (`DATABASE_URL`): las migraciones se probaron en PGlite (PostgreSQL 17 real en WASM), no en tu instancia. Posibles diferencias: ninguna esperada, pero hay que ejecutar `npm run db:migrate` y confirmarlo. Tampoco `admin:create` ni `seed:aagora` contra Neon (sí sus funciones contra PGlite).
- **Ollama real y el modelo elegido**: la calidad de las respuestas, el formato JSON del modelo concreto y la latencia solo se validan con tu `OLLAMA_MODEL`. Se probó el comportamiento ante respuestas válidas, inválidas y caída.
- **AAgora real**: no hay números reales, dominios reales ni `chatbot-content.json` real del sitio; el botón semilla es una suposición editable. No se probó el enlace `wa.me` con un número real ni WhatsApp en un móvil.
- **Render**: no se desplegó; falta validar variables, proxy (`TRUST_PROXY`) y acceso a Ollama desde allí.
- **Navegador**: el panel compila y se sirve (probado por HTTP), pero no se recorrió manualmente en un navegador; el widget del chat de los sitios no forma parte de este repositorio (solo el cliente TS).
