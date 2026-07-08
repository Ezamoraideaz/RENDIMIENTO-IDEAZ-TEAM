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
- Roles (tabla `operators`): `superadmin` (todo + gestión de usuarios y credenciales), `admin` (todo menos usuarios), `agenda_full` (solo agenda), `agenda_member` (agenda + monitor, bloqueado a su miembro de Trello), `cm` (agenda + configuración solo Drive/carpetas), `agent` (solo Atención al Cliente).
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
