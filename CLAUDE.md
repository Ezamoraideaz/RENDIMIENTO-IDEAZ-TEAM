# CLAUDE.md — IDEAZ Dashboard · Reglas de colaboración

Este archivo es leído automáticamente por Claude Code. Aplica para todos los developers del proyecto.
<!-- deploy-test -->

---

## Descripción del proyecto

Dashboard web de rendimiento del equipo IDEAZ, conectado a Trello via API REST.
- **Stack:** HTML + CSS (Tailwind CDN) + JavaScript vanilla. Sin Node.js, sin bundlers.
- **Repositorio:** https://github.com/Ezamoraideaz/RENDIMIENTO-IDEAZ-TEAM
- **Dueño principal:** Ezamoraideaz (cuenta GitHub)

---

## Módulos existentes — NO modificar sin coordinación

| Archivo | Dueño | Descripción |
|---------|-------|-------------|
| `index.html` | Ezamoraideaz | Dashboard principal de rendimiento |
| `proyecto.html` | Ezamoraideaz | Vista detalle por proyecto |
| `configuracion.html` | Ezamoraideaz | Configuración de credenciales Trello |
| `protocolo-trello.html` | Ezamoraideaz | Protocolo de uso de Trello |
| `js/api.js` | Compartido | Clase `TrelloAPI` — no modificar la interfaz pública |
| `js/storage.js` | Compartido | Credenciales y datos por proyecto |
| `js/cache.js` | Compartido | Caché de peticiones Trello |
| `js/utils.js` | Compartido | Helpers globales |
| `js/timeCalc.js` | Compartido | Cálculo de horas laborales |
| `css/main.css` | Ezamoraideaz | Estilos globales |

---

## Módulo en desarrollo

| Archivo | Dueño | Descripción |
|---------|-------|-------------|
| `agenda.html` | Colaborador | Vista de tareas por día y por colaborador (para PM y CM) |
| `js/agenda.js` | Colaborador | Lógica exclusiva del módulo agenda |
| `atencion-cliente.html` | Ezamoraideaz | Automatización de conversaciones Messenger/Instagram por marca (estilo ManyChat) |
| `js/atencionCliente.js` | Ezamoraideaz | Controlador del panel: clientes, cuentas conectadas, inbox |
| `js/flowBuilder.js` | Ezamoraideaz | Constructor visual de flujos (envuelve Drawflow, vendorizado en `js/vendor/`) |
| `backend/` | Ezamoraideaz | Backend PHP + MySQL (webhooks/tokens de Meta + login global + configuración compartida) — ver secciones abajo |
| `login.html` | Ezamoraideaz | Login global del sitio (email + contraseña contra `backend/auth/login.php`) |
| `js/session.js` | Ezamoraideaz | Guard de sesión global: incluirlo en toda página nueva y esperar `Session.ready` antes de iniciar |
| `rendicion.html` / `js/rendicion.js` | Ezamoraideaz | Rendición Trimestral de Gestión — Formulario 1 (wizard interno del CM por cliente/trimestre) + su propia lista de rendiciones. Rol `cm` diligencia y puede reabrir sus propias rendiciones enviadas para corregirlas; `superadmin`/`admin` revisan y reabren cualquiera. |
| `js/rendicionSchema.js` | Ezamoraideaz | Esquema de pasos/campos del wizard (mismo patrón data-driven que `js/briefSchemas.js`) — fuente única de preguntas/opciones/lógica condicional |
| `rendicion-dashboard.html` / `js/rendicionDashboard.js` | Ezamoraideaz | Dashboard consolidado (solo `superadmin`/`admin`): indicadores por categoría, score/semáforo por CM, gestión del link de la encuesta al cliente, pipeline de oportunidades editable, y contraste "reportado vs. real" de Producción contra el módulo Aprobaciones (`content_items`) |
| `encuesta-publica.html` | Ezamoraideaz | Formulario 2 — Encuesta Trimestral de Satisfacción, portal público sin login (token en `?t=`), la responde el cliente final |
| `backend/api/rendicion_forms.php`, `backend/api/rendicion_dashboard.php`, `backend/api/client_surveys.php`, `backend/public/survey_public.php` | Ezamoraideaz | Backend del módulo de Rendición — ver `backend/sql/migration_020_rendicion.sql` para el modelo de datos y el cálculo del Score del CM |
| `backend/api/rendicion_opportunities.php` | Ezamoraideaz | Pipeline de oportunidades comerciales — permite actualizar el estado/valor de una oportunidad ya reportada (ej. a "Cotizada"/"Vendida") sin reabrir el formulario trimestral al que pertenece; visible en `rendicion.html` (propias) y `rendicion-dashboard.html` (todas) |
| `backend/cron/rendicion_reminders.php` | Ezamoraideaz | Correos automáticos a CM/PM(agenda_full)/superadmin/admin: 7 días antes de cerrar el trimestre (a diligenciar) y 1 día antes (agendar la socialización presencial). Requiere un **Cron Job nuevo en cPanel, una vez al día** (ver `backend/sql/migration_021_rendicion_reminders.sql`) — aparte del cron por minuto de `process_scheduled.php`. Lógica compartida en `backend/includes/rendicion_reminders.php` |
| `backend/api/rendicion_reminders_test.php` | Ezamoraideaz | Botón "Enviar correo de prueba" en `rendicion-dashboard.html` — prueba el envío real sin Terminal/SSH, solo a la dirección indicada, sin afectar el cron real |
| `backend/webhook/telegram.php`, `backend/cron/process_design_reviews.php`, `backend/includes/{telegram_api,review_parser,design_review_ai,design_review}.php`, `backend/setup/telegram_setup.php` | Ezamoraideaz | Revisión automática de piezas con IA vía bot de Telegram — ver sección "Revisión de piezas por Telegram" abajo y `plan-revision-ia-disenos.md` |
| `configurar-cliente.html` / `js/clienteSetup.js` / `backend/api/client_setup.php` | Ezamoraideaz | Asistente guiado para dejar montada una marca de retención (roles `superadmin`/`admin`/`cm`/`agenda_full`; presupuesto, ingreso y Pauta solo admin y PM). Resumen de avance de todas las marcas + checklist en orden: datos/logo, Trello (listas del protocolo y tarifas), proyecto, Sheet, Drive (exige Editor), Telegram (casilla + bot administrador + CM/PM), Meta (OAuth con `return=asistente`), flujos/leads/brief y Pauta (vincula la existente para no duplicar). Requiere `backend/sql/migration_026_client_setup.sql`. Al agregar una integración nueva por cliente, súmala aquí (`STEPS` en el JS + `setup_checklist()` en el PHP) para que no se olvide. |
| `reporte-pauta.html`, `backend/api/pauta_report_links.php`, `backend/public/pauta_report_public.php`, `api/spend_lib.php` | Ezamoraideaz | Reporte de pauta para el cliente final por link privado (token, solo hash en BD; modo tiempo real o rango de fechas; exporta PDF con imprimir). Se genera en `pauta.html` → detalle → pestaña "Reporte cliente". Requiere `backend/sql/migration_023_pauta_report_links.sql`. `api/spend_lib.php` contiene las consultas a Meta/Google que antes vivían en `api/spend.php` |
| `backend/api/pauta_lead_precheck.php` | Ezamoraideaz | Calificados preliminares de pauta (Pauta → detalle de una marca): si la marca tuvo inversión en el período, los leads que entraron a Leads Orgánicos (`organic_leads`, por `lead_date` o fecha de importación) y por formularios de Meta (`ad_leads`) cuentan como calificados; una misma persona en ambas fuentes (teléfono/correo) se cuenta una vez. El registro manual de `pauta_leads` tiene prioridad. Requiere `backend/sql/migration_025_pauta_organic_link.sql` para vincular cada cliente de Pauta con su cliente de Atención al Cliente |

---

## Pauta — Google Ads y marcas que requieren atención

- **Conexión con Google Ads:** botón "Conectar / Reconectar Google Ads" en `pauta.html` (solo superadmin/admin) → `backend/oauth/google_ads_connect.php` → `google_ads_callback.php`. El refresh token se guarda cifrado en `app_settings` (`google_ads_refresh_token`); si no hay, se usa `GOOGLE_REFRESH_TOKEN` de `api/config.php`. Lógica en `backend/includes/google_ads_auth.php` (también cachea el access token ~1 h). Estado: `backend/api/google_ads_status.php`.
- **Por qué se vencía ("OAuth error: Bad Request" = `invalid_grant`):** la app de OAuth en Google Cloud estaba en modo "Prueba", y ahí Google vence los refresh tokens a los 7 días. Configuración única en Google Cloud:
  1. Pantalla de consentimiento de OAuth → **Publicar app / "En producción"** (para uso propio no requiere verificación; al conectar aparece el aviso "app no verificada" → Avanzado → Continuar).
  2. El cliente OAuth debe ser **Aplicación web** con la URI de redireccionamiento `https://marketingdigitalideaz.com/dashboard/backend/oauth/google_ads_callback.php`.
  3. Pegar ese Client ID / Secret en `api/config.php` y pulsar "Conectar Google Ads" en Pauta.
- **Marcas que requieren atención:** `api/spend.php?platform=meta_status|google_status` informa el estado de la cuenta publicitaria (pago pendiente / fallido, límite de gasto alcanzado, deshabilitada, suspendida, presupuesto de cuenta agotado). Pauta además marca "posible pausa" si hubo gasto y los 2 últimos días quedó en $0. Se muestra en cada tarjeta, con filtro "Requieren atención" y las marcas afectadas primero. Google no informa por API los cobros fallidos de tarjeta: en ese caso solo aplica la regla de los 2 días.

---

## Revisión de piezas por Telegram (bot + Gemini + cronograma)

Los diseñadores envían la pieza al grupo de Telegram de la marca con un texto `#5 - 18 REEL FEED`
(`#ID` del post · día de publicación · formato). El bot cruza ese `#ID` con el cronograma de Google Sheets
(una pestaña por mes; A=post, C=día, D=indicaciones, E=mensaje de arte, F=copy), revisa la pieza con Gemini
y responde en el grupo con un reporte con score (🟢 ≥85, 🟡 60–84, 🔴 <60) y botones para CM/PM.
Los botones son **solo comunicación** (registran el evento en `design_review_events` y avisan en el grupo); no tocan Trello.

- **Contenido extra (fuera del cronograma):** el diseñador lo envía como `#extra - REEL FEED` (+ nota opcional). No se cruza con el Sheet: solo se revisa ortografía, diseño y formato (sin Texto de arte ni Copy). Se guarda con `post_number = 0`.
- **Mes:** como la publicación es siempre futura, un día `>=` al de hoy es este mes y uno menor es el mes siguiente.
- **Roles:** `telegram_role_rules` (texto que debe contener el @usuario/nombre de Telegram → `cm`/`pm`). Quien no coincide es diseñador. CM/PM no generan revisiones.
- **Límites:** el Bot API estándar solo permite descargar archivos de hasta 20 MB. Gemini usa la capa gratuita (cuota por minuto/día; Google puede usar los datos enviados).

### Puesta en marcha (una sola vez)
1. Correr `backend/sql/migration_022_telegram_design_review.sql` (ya incluida en `schema.sql` para instalaciones nuevas).
2. Crear el bot en @BotFather; completar `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GEMINI_API_KEY` (aistudio.google.com) en `config.php`.
3. **Recepción de mensajes:** por defecto el cron hace *polling* (`getUpdates`, `backend/includes/telegram_poll.php`) y no necesita webhook — útil si el firewall del hosting bloquea las peticiones entrantes de Telegram (409). Alternativa con webhook (solo si el hosting lo permite): visitar `backend/setup/telegram_setup.php?token=SETUP_TOKEN&action=set`; luego borrar ese archivo y vaciar `SETUP_TOKEN`. Con polling el webhook se elimina solo.
4. Agregar el bot como **administrador** de cada grupo de marca y escribir allí `/vincular slug-de-la-marca` (solo admins del grupo).
5. Crear un **Cron Job nuevo en cPanel, cada minuto**: `php backend/cron/process_design_reviews.php` (aparte de `process_scheduled.php`).
6. Compartir el Google Sheet de cada marca con la cuenta de servicio (ya hecho para Aprobaciones) y tener `clients.sheet_id` guardado.

---

## Módulo "Atención al Cliente" (backend PHP + MySQL)

A diferencia del resto del dashboard, este módulo requiere servidor propio porque Meta exige un
webhook HTTPS público y no permite guardar tokens de Página/Instagram en el navegador. Vive en
`/backend/`, separado del resto del sitio estático, y usa **su propio login por sesión** (tabla
`operators`), no las credenciales de Trello.

### Puesta en marcha (una sola vez)
1. Copiar `backend/config.example.php` a `backend/config.php` y completar credenciales (nunca commitear `config.php`).
2. Crear la base de datos MySQL en cPanel y correr `backend/sql/schema.sql` una sola vez (phpMyAdmin o CLI). Si la BD ya existía de antes del login global, correr también `backend/sql/migration_002_site_auth.sql`.
3. Crear el superadmin desde terminal: `php backend/cli/create_operator.php email@ejemplo.com contraseña superadmin "Tu Nombre"`. **Sin Terminal en cPanel:** definir `SETUP_TOKEN` en `config.php`, visitar `backend/setup/bootstrap_operator.php?token=EL_TOKEN`, llenar el formulario, y luego borrar ese archivo y vaciar `SETUP_TOKEN`.
4. Configurar un Cron Job en cPanel que ejecute cada minuto: `php backend/cron/process_scheduled.php`.
5. Crear la App de Meta (developers.facebook.com, tipo Business) y completar `META_APP_ID`/`META_APP_SECRET`/`WEBHOOK_VERIFY_TOKEN` en `config.php`. Mientras la App esté en modo Development, los admins/testers del App pueden usar `pages_messaging`/`instagram_business_manage_messages` sin esperar App Review.
6. Dar de alta el Webhook en Meta apuntando a `https://tudominio.com/dashboard/backend/webhook/webhook.php`, con el mismo `WEBHOOK_VERIFY_TOKEN`.
7. Para la tanda automática del módulo Aprobaciones (lectura en vivo de la parrilla de Excel/Google Sheets): crear una cuenta de servicio de Google y pegar el contenido completo del `.json` descargado en `GOOGLE_SERVICE_ACCOUNT_JSON` dentro de `config.php` (más simple que subir un archivo aparte en hosting compartido). Alternativa: subir el archivo a `backend/storage/google-service-account.json` y usar `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` en su lugar — `GOOGLE_SERVICE_ACCOUNT_JSON` tiene prioridad si ambas están definidas. Compartir el Google Sheet de cada cliente (como Lector) con el `client_email` de esa cuenta de servicio, y guardar el ID del Sheet en `configuracion.html` o vía `clients.sheet_id`.
8. Para que el contenido aprobado se mueva solo de "Para aprobación" hacia ARTES (`backend/includes/drive_approval_sync.php`, se dispara al aprobar en el portal público): compartir **ambas** carpetas de Drive — la carpeta "Para aprobación" de cada marca (`clients.drive_approval_folder_id`, se vincula desde `aprobaciones.html`) y la carpeta ARTES de cada tablero (`project_settings.drive_folder_id`, se vincula desde `configuracion.html`) — con el `client_email` de la misma cuenta de servicio, esta vez como **Editor** (no solo Lector, porque acá sí mueve/crea carpetas). Si el movimiento automático falla por carpetas no compartidas o mal configuradas, queda registrado en `content_items.drive_move_status`/`drive_move_error` sin bloquear la aprobación del cliente.
9. Para el autocompletado de comprobantes en el módulo Egresos (`backend/includes/google_vision.php` — lee la foto de una transferencia de Bancolombia/Nequi y prellena monto/fecha/concepto en `egresos.html`): en el mismo proyecto de Google Cloud de la cuenta de servicio, habilitar la **Cloud Vision API** y asegurarse de que el proyecto tenga una **cuenta de facturación** asociada (Vision API no funciona sin facturación habilitada, aunque haya cuota gratis mensual de sobra para este uso). No requiere compartir nada adicional — usa la misma `GOOGLE_SERVICE_ACCOUNT_JSON`/`GOOGLE_SERVICE_ACCOUNT_KEY_FILE` del paso 7.

### Reglas propias de este módulo
- El backend PHP sigue el mismo patrón que `api/spend.php` (config gitignored + `.htaccess` con CORS), pero con su propia carpeta, base de datos y `.htaccess`.
- Los tokens de Página/Instagram se cifran en BD (`backend/includes/crypto.php`, AES-256-GCM) — nunca se guardan en texto plano ni en el frontend.
- El motor de disparadores (`backend/includes/trigger_engine.php`) respeta la ventana de mensajería de 24h de Meta; fuera de esa ventana solo se permite el tag `HUMAN_AGENT` (respuesta manual de una persona, excepción de 7 días).
- Cambios a `backend/` no afectan al resto del dashboard estático — se puede iterar en `feature/atencion-cliente` sin coordinar con otros módulos.

---

## Reglas de desarrollo

### Ramas
- `main` → rama estable. Nunca trabajar directo aquí.
- Cada feature va en su propia rama: `feature/nombre-feature`
- Para mergear a `main` se requiere Pull Request aprobado por Ezamoraideaz.

### Archivos compartidos (`js/api.js`, `js/storage.js`, `js/cache.js`, `js/utils.js`)
- Se pueden **leer y usar**, pero **no modificar** sin avisar al otro developer primero.
- Si se necesita agregar una función de utilidad, agregarla al final del archivo y mencionarlo en el PR.

### Estilos
- Usar clases de **Tailwind CDN** (ya incluido en todos los HTML).
- Colores del sistema: `slate-900` fondo, `indigo-600` acento, `slate-100` texto.
- No agregar librerías CSS externas sin coordinación.

### JavaScript
- Vanilla JS únicamente. Sin frameworks, sin npm.
- Las clases globales (`TrelloAPI`, `Storage`, `TrelloCache`, `Utils`, `TimeCalc`) están disponibles en todos los HTML via `<script>` tags.
- Para un módulo nuevo, crear su propio archivo JS (`js/nombre-modulo.js`).

### Datos de Trello disponibles en cada tarjeta
```js
card.id           // ID único
card.name         // nombre de la tarea
card.due          // "2026-06-05T12:00:00.000Z" — fecha límite
card.dueComplete  // boolean — si está marcada como completada
card.idList       // ID de la lista donde está
card.idMembers    // ["memberId1", ...] — miembros asignados
card.labels       // etiquetas
card.closed       // boolean — si está archivada
```

### Credenciales
- Las credenciales de Trello y el Client ID de Google Drive son **un juego único compartido de la agencia**, guardado **cifrado en MySQL** (`app_settings`, AES-256-GCM). Solo el superadmin puede modificarlas desde `configuracion.html`.
- Los datos financieros por proyecto, carpetas Drive y tarifas/roles/nombres de miembros también viven en la BD (`project_settings` / `member_settings`) y se comparten entre usuarios; `js/storage.js` mantiene su interfaz pública de siempre pero respaldada por esos endpoints (caché en memoria precargado por `Session.ready`). Las horas por tarjeta (`ideaz_time`/`ideaz_overrides`) siguen en `localStorage`.
- Las credenciales **nunca** se guardan en el repositorio ni en `localStorage`.
- La carpeta `.claude/` está en `.gitignore` — cada developer tiene su configuración local de Claude.

### Login y roles (control de acceso)
- Todo el sitio requiere sesión: `login.html` + cookie de sesión PHP (la misma del módulo Atención al Cliente). `js/session.js` redirige a login si no hay sesión y aplica permisos por página.
- Roles (tabla `operators`): `superadmin` (todo + gestión de usuarios y credenciales), `admin` (todo menos usuarios), `agenda_full` (solo agenda), `agenda_member` (agenda + monitor, bloqueado a su miembro de Trello), `cm` (agenda + configuración solo Drive/carpetas + monitor + Atención al Cliente, bloqueado a sus propias faltas), `agent` (solo Atención al Cliente).
- Los usuarios se gestionan en `configuracion.html` → sección "Usuarios" (solo superadmin), vía `backend/api/users.php`.
- Las URLs de acceso antiguas (`?access=` con credenciales en base64) fueron eliminadas; `js/auth.js` es ahora un adaptador de permisos sobre `Session`.
- Página nueva = incluir `js/session.js`, envolver la inicialización en `Session.ready.then(...)` y registrar la página en los mapas de `js/session.js` (`PAGE_BY_FILE`, `ACCESS`, `FILE_BY_PAGE`).

---

## Cómo agregar navegación al sidebar

Cuando un módulo nuevo esté listo, el colaborador agrega el link en **su propio HTML** y crea un PR para que Ezamoraideaz agregue el mismo link en `index.html`, `proyecto.html` y `configuracion.html`.

Estructura del link de navegación:
```html
<a href="agenda.html" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold text-slate-400 hover:bg-slate-800 transition-colors">
  <span>📅</span> Agenda
</a>
```

---

## Flujo de trabajo colaborativo

```
1. git checkout main && git pull origin main
2. git checkout -b feature/mi-feature
3. Trabajar en los archivos asignados
4. git push origin feature/mi-feature
5. Crear Pull Request en GitHub
6. Ezamoraideaz revisa y aprueba el merge
```
