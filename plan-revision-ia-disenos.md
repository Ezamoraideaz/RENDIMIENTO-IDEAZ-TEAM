# Plan — Revisión con IA de piezas (ortografía + diseño gráfico)

Contexto: ~170 piezas/mes (≈70% video / 30% estáticas). Requisito: sin costo, subida temporal, para los diseñadores.
Estado: **borrador para comparar** (no implementado). Rama sugerida: `feature/revision-diseno`.

---

## Solución A — Módulo web propio en el dashboard (subida manual)

Página nueva `revision-diseno.html` + `js/revisionDiseno.js` + `backend/api/design_review.php`.
Login y roles vía `js/session.js` (registrar en `PAGE_BY_FILE`, `ACCESS`, `FILE_BY_PAGE`).

### Flujo
1. El diseñador arrastra una o varias piezas (JPG/PNG/PDF/video).
2. **Estáticas:** se suben a `backend/storage/review_tmp/`. OCR con Cloud Vision (ya configurada) → ortografía con LanguageTool (es). Crítica de diseño con Gemini (plan gratuito, multimodal).
3. **Video:** el navegador extrae 8–12 fotogramas (`<video>` + `<canvas>`); el video NO viaja al servidor. Los fotogramas van a Gemini (texto en pantalla, contraste, legibilidad, márgenes seguros, logo, coherencia de marca). Audio opcional: Groq Whisper → revisar guion vs. subtítulos.
4. Se muestra el informe (errores ortográficos, observaciones de diseño, puntaje opcional).
5. Cron diario borra archivos/fotogramas > 24 h.

### Componentes gratuitos
| Tarea | Herramienta | Límite relevante |
|---|---|---|
| OCR estáticas | Google Vision (ya existe) | 1.000 imágenes/mes gratis |
| Ortografía | LanguageTool API pública | ~20 peticiones/min |
| Diseño / texto en video | Gemini API plan gratuito | límites por minuto/día; datos pueden usarse para mejorar productos |
| Transcripción | Groq Whisper (gratis) | límite de minutos de audio/hora |
| Respaldo visual | Groq / OpenRouter `:free` | calidad variable |

### Backend
- API keys en `backend/config.php` (gitignored), nunca en el frontend.
- Tabla opcional `design_reviews` (cliente, pieza, informe JSON, usuario, fecha) si se quiere historial.
- Cron nuevo de limpieza (aparte de `process_scheduled.php`).

### Pros
- Control total del prompt, formato y criterios por marca.
- Reutiliza login, roles, PHP/MySQL y Vision existentes.
- Video liviano: sin límites de subida del hosting.

### Contras / riesgos
- Los diseñadores deben acordarse de usarlo (paso extra manual).
- Dependencia de límites del plan gratuito (cambian sin aviso).
- Privacidad: Gemini gratuito puede usar datos → no subir material confidencial.
- Con fotogramas no se evalúa ritmo, transiciones ni sincronía de audio.
- Mantenimiento de código propio (extracción de fotogramas, colas, errores de cuota).

### Esfuerzo estimado
Medio: 1 página, 1 endpoint, 1 cron, esquema de prompts. Variante "video completo" (File API, preview 480p) = extra.

### Preguntas abiertas
1. ¿Material confidencial de clientes?
2. ¿Roles con acceso (`cm`, `admin`, agenda)?
3. ¿Historial en BD o informe efímero?
4. ¿Pueden exportar un preview ligero de video?
5. ¿Los videos llevan subtítulos quemados / locución?

---

## Solución B — Revisión automática integrada al flujo de Drive / Aprobaciones

(Ver comparación abajo; se detalla tras acordar dirección.)

Idea: el diseñador no usa una herramienta nueva. Al dejar la pieza en la carpeta Drive "Para aprobación" (ya existe: `clients.drive_approval_folder_id`), un cron la detecta, la revisa con IA y adjunta el informe a `content_items` (módulo Aprobaciones). El informe se ve en `aprobaciones.html` antes de enviar al cliente.

### Flujo
1. Pieza aparece en "Para aprobación" (cuenta de servicio de Google ya compartida).
2. Cron (cada 5–10 min) lista archivos nuevos sin revisar.
3. Descarga la pieza vía Drive API; estáticas → Gemini directo; video → Gemini File API (o fotogramas con ffmpeg si el hosting lo permite).
4. Guarda el informe en columnas nuevas de `content_items` (`ai_review_status`, `ai_review_json`, `ai_review_at`).
5. `aprobaciones.html` muestra semáforo + observaciones; el diseñador corrige y re-sube.
6. Archivos temporales se borran tras la revisión (nunca se almacenan en el servidor más que el tiempo del proceso).

### Pros
- Cero fricción: cae en el flujo que ya usan.
- Sin límites de subida del navegador/hosting (Drive es el almacenamiento).
- Informe queda ligado a la pieza y al cliente (trazabilidad).
- Revisión consistente: ninguna pieza se salta el control.

### Contras / riesgos
- Depende de Drive API y de que el hosting permita descargar/procesar video (tiempo máx. de cron, memoria, ffmpeg).
- Menos interactivo: no hay "prueba y corrige" inmediato (latencia del cron).
- Revisa también piezas que quizá no se querían revisar → consume cuota gratuita (~170/mes es viable).
- Mismos temas de privacidad del plan gratuito de Gemini.
- Requiere migración SQL y tocar el módulo Aprobaciones.

---

## Comparación (borrador)

| Criterio | A: Módulo manual | B: Automático en Drive |
|---|---|---|
| Fricción para diseñadores | Media (paso extra) | Ninguna |
| Riesgo de que no se use | Alto | Bajo |
| Interactividad / feedback inmediato | Alta | Media (cron) |
| Manejo de video pesado | Bueno (fotogramas en navegador) | Difícil (límites del hosting) |
| Trazabilidad por cliente/pieza | Opcional | Nativa |
| Consumo de cuota gratuita | Solo piezas subidas | Todas las piezas |
| Esfuerzo de desarrollo | Medio | Medio-alto |
| Toca módulos existentes | No | Sí (Aprobaciones, BD) |
| Costo | $0 | $0 |

Posible híbrido: A como herramienta de "borrador rápido" + B como control obligatorio previo a enviar al cliente.

---

## Solución C — Bot de Telegram en los grupos por marca + cronograma + IA (PRINCIPAL, acordada)

Se descarta la subida manual (A) y la integración con Drive/Aprobaciones (B) como primera fase: el proceso real ya ocurre en los grupos de Telegram (uno por marca), donde el diseñador publica la pieza con un mensaje. El bot se engancha ahí. Todo el ciclo CM + IA + PM ocurre **dentro de Telegram**, sin acciones internas en el sistema por ahora.

### Reglas de negocio confirmadas
- **Mensaje del diseñador:** `#5 - 18 REEL FEED ...` (archivo adjunto + texto).
  - `#5` → **ID del post** (lo más importante). Regex: `#\s*(\d+)`.
  - `18` → **día de publicación**. El mes se deduce porque la publicación **siempre es futura**: el mes es el de la próxima ocurrencia de ese día respecto a hoy (si `día > hoy.día` → mes actual; si no → mes siguiente). Confirmar con la fecha de la fila del cronograma como validación cruzada.
  - Resto del texto → tipo/formato (REEL, FEED, STORY, etc.).
- **Cronograma (Google Sheet por cliente, `clients.sheet_id`):**
  - **Columna A:** indicador del post. Las CM escriben `#1`, `Post 1`, etc. → extraer solo el número (`\d+`) y compararlo con el ID del mensaje.
  - **Columna D:** TEMA, REFERENCIA E INDICACIONES PARA EL DISEÑADOR.
  - **Columna E:** MENSAJE DE ARTE — únicamente los textos que van dentro de artes y videos.
  - **Columna F:** COPY / descripción del post (debe usar ganchos y CTA).
  - Las demás columnas (fecha, formato, plataforma, etc.) también se leen como contexto.
- **Archivos:** hasta ~20 MB por pieza → cabe en el Bot API estándar (límite de descarga 20 MB). Pedir que lo envíen como *video* o *archivo* comprimido; si `getFile` falla por tamaño, el bot avisa y pide un preview más liviano o enlace de Drive.
- **Bot administrador** en cada grupo (puede leer todos los mensajes). Se identifican CM y PM por su usuario de Telegram.
- **Aprobación:** CM y PM comentan ajustes según el **score del reporte IA**. Si queda aprobado hay una validación interna antes del cliente; cuando el cliente aprueba, CM/PM mueven el estado **manualmente en Trello**. Los botones del bot son solo comunicación: **sin acción interna** (ni Trello, ni `content_items`) en esta fase.

### Flujo
1. Diseñador envía en el grupo: archivo + `#5 - 18 REEL FEED ...`.
2. Webhook (`backend/webhook/telegram.php`) valida el secret token, resuelve el cliente por `chat_id`, parsea ID y día, calcula el mes, y encola el caso. Responde rápido a Telegram.
3. El bot confirma: «Recibido #5 (18/mm) — revisando…». Si falta el ID o no existe en el cronograma, avisa de inmediato.
4. Cron (cada minuto, mismo patrón que `process_scheduled.php`) toma casos pendientes: descarga el archivo, lee la fila del cronograma (A → D, E, F + contexto) y llama a Gemini.
5. La IA devuelve un **reporte con score (0–100) y desglose**:
   - Texto de la pieza vs. columna E (coincidencias, faltantes, sobrantes) y ortografía.
   - Cumplimiento de la columna D (indicaciones/referencia del diseñador).
   - Calidad de diseño (jerarquía, contraste, legibilidad, márgenes seguros, marca).
   - Formato/proporción vs. lo esperado (REEL/FEED/STORY).
   - Revisión del copy de la columna F: ¿tiene gancho y CTA?, ortografía.
   - Video: fotogramas (ffmpeg si el hosting lo permite) o video completo vía Gemini File API.
6. El bot responde al mensaje del diseñador con el reporte y **botones** (visibles solo para CM/PM): p. ej. «✅ Aprobar para cliente» / «✏️ Pedir ajustes» / «💬 Comentar». Al pulsar, el bot publica un mensaje en el grupo mencionando al diseñador. **Sin tocar Trello ni la BD de contenidos**; solo se registra el evento (quién, cuándo) para auditoría opcional.
7. Reenvío del mismo ID = nueva versión (v2, v3…) con comparación contra el reporte anterior.

### Componentes técnicos
- `backend/webhook/telegram.php` — recibe updates (mensajes y callbacks).
- `backend/includes/telegram_api.php` — envío/edición de mensajes, descarga de archivos, botones.
- `backend/includes/review_parser.php` — regex de ID/día/mes + extracción del número de la col. A.
- Reutiliza el lector de la parrilla de Google Sheets del módulo Aprobaciones.
- `backend/includes/ai_review.php` — prompts + llamada a Gemini (key en `config.php`), salida JSON con score.
- `backend/cron/process_telegram_reviews.php` — procesa la cola.
- Migración SQL: `telegram_groups` (chat_id ↔ client), `telegram_members` (telegram_user_id, rol: designer/cm/pm, cliente), `design_reviews` (caso, versión, score, informe JSON, estado), `design_review_events` (clics de botones).
- Config en `config.php`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GEMINI_API_KEY`.
- Limpieza de archivos temporales tras analizar (y a las 24 h como respaldo).
- Pantalla opcional en el dashboard (fase posterior): historial y métricas por diseñador/marca.

### Fases
1. **MVP estáticas:** bot, webhook, parseo, cruce con cronograma, reporte con score (ortografía, texto vs. col. E, col. F), botones de comunicación.
2. **Video:** fotogramas o video completo; audio opcional (Whisper en Groq).
3. **Pulido del flujo:** versiones, recordatorios de piezas sin revisar, manejo de álbumes (`media_group_id`).
4. **Panel en el dashboard:** historial y métricas.

### Riesgos
- Límite de 20 MB del Bot API (piezas justas en el borde).
- Plan gratuito de Gemini: cuotas y uso de datos por Google (excluir marcas sensibles).
- Pestañas/estructura del Sheet distinta entre marcas; IDs duplicados entre meses (se desambigua con día/mes).
- Ambigüedad si el día enviado es igual al de hoy (definir regla).
- Álbumes: el texto viene solo en el primer mensaje.
- Procesar video en hosting compartido (tiempo/memoria/ffmpeg) → probar antes de comprometer fase 2.

### Preguntas abiertas
1. ¿Cómo se organizan las pestañas del Sheet (una por mes? nombre?) y en qué columna está la fecha de publicación?
2. Regla si el día enviado coincide con el día de hoy: ¿mes actual o siguiente?
3. Lista de CM y PM por marca con su usuario de Telegram.
4. ¿Umbrales del score (p. ej. ≥85 verde, 60–84 amarillo, <60 rojo)?
5. ¿Hay marcas con material confidencial que deban excluirse de Gemini gratuito?
