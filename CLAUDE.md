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
- Cada developer usa **sus propias credenciales de Trello** guardadas localmente via `configuracion.html`.
- Las credenciales **nunca** se guardan en el repositorio (están en `localStorage` del navegador).
- La carpeta `.claude/` está en `.gitignore` — cada developer tiene su configuración local de Claude.

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
