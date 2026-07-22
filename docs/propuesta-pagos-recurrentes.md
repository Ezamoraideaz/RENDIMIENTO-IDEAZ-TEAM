# Propuesta: Módulo de Pagos Recurrentes (Wompi)

**Estado:** Propuesta para revisión de Ezamoraideaz — no implementado todavía.
**Autor:** Colaborador (rama `agenda`)
**Fecha:** 2026-07-22
**Métodos de pago:** Tarjeta + Nequi únicamente (cobro 100% automático).
**Arquitectura:** Extender el `backend/` existente.

---

## 1. Objetivo

El acceso a la app se condiciona al pago: los clientes a quienes se les vende el uso del
dashboard deben tener una suscripción activa cobrada de forma recurrente vía Wompi para poder
iniciar sesión. Si la suscripción está vencida o el cobro falla, se bloquea o redirige el acceso.

Alcance adicional solicitado:
- Pago con Tarjeta y Nequi (cobro automático).
- Descarga de comprobantes/recibos de pago.
- Comunicación del ciclo de facturación al cliente.

---

## 2. Métodos de pago — Tarjeta y Nequi

Wompi Colombia solo soporta **cobro automático real** (sin intervención del cliente en cada
ciclo) para **Tarjeta** y **Nequi**, mediante tokenización de "fuentes de pago"
(`docs.wompi.co/en/docs/colombia/fuentes-de-pago`). El token se guarda una vez y luego se usa
para cobrar mes a mes sin que el cliente vuelva a autorizar.

**Decisión tomada:** el módulo se limita a estos dos métodos, precisamente porque son los únicos
que permiten recurrencia 100% automática. Quedan fuera PSE y Transferencia/Botón Bancolombia, ya
que no son tokenizables y requerirían que el cliente reautorice manualmente cada ciclo (no es
recurrencia automática real).

---

## 3. Arquitectura — extender el backend existente

Se extiende el `backend/` existente (PHP + MySQL) en vez de crear un backend paralelo, porque el
gate de acceso necesita hablar directo con el sistema de sesión/login ya construido
(`js/session.js`, tabla `operators`). Un backend aparte obligaría a que dos sistemas de sesión se
comuniquen entre sí, lo cual es más complejidad, no menos.

Esto implica tocar código que **hoy es propiedad de Ezamoraideaz** según `CLAUDE.md`, por lo que
esta propuesta existe precisamente para pedir su aprobación antes de empezar.

### 3.1 Nuevas tablas

| Tabla | Contenido |
|---|---|
| `subscriptions` | cliente, plan, estado (activa/vencida/cancelada), fecha próximo cobro |
| `payment_sources` | tokens Wompi (tarjeta/Nequi) cifrados con `crypto.php`, método, cliente |
| `payments` | historial de transacciones: monto, estado, referencia Wompi, fecha |
| `billing_cycles` | ciclo de facturación por suscripción: fecha de corte, intentos de cobro |

### 3.2 Componentes nuevos

- `backend/webhook/wompi_webhook.php` — confirma transacciones (paralelo al webhook de Meta ya
  existente, misma carpeta `backend/webhook/`).
- Tarea de cobro agregada al cron ya existente (`backend/cron/process_scheduled.php`), en vez de
  pedir un cron nuevo en cPanel.
- Reutilización de `backend/includes/crypto.php` (AES-256-GCM) para cifrar tokens y credenciales
  de Wompi en `config.php` / `app_settings`.
- Gate de acceso: `js/session.js` consulta el estado de la suscripción al iniciar sesión y
  bloquea o redirige si está vencida.

---

## 4. Documentos de pago

Recibo/comprobante simple en PDF (sin validez fiscal DIAN), generado por el sistema en cada pago
confirmado, descargable desde el dashboard. Librería PHP tipo `dompdf` (sin Composer, cargada
como vendor, siguiendo el mismo patrón que `js/vendor/` para Drawflow).

---

## 5. Comunicación del ciclo de facturación

Email automático (requiere SMTP configurado en `config.php`) en tres momentos:
1. Recordatorio antes del cobro programado.
2. Confirmación de pago exitoso (adjunta o enlaza el recibo PDF).
3. Aviso de cobro fallido, con instrucciones para regularizar.

---

## 6. Puntos que requieren aprobación explícita de Ezamoraideaz

1. Tocar `backend/`: tablas nuevas, endpoints nuevos, ajuste al cron existente.
2. Agregar credenciales de Wompi (API key/secret) a `config.php` / `app_settings` cifrado.
3. Dónde vive el gate de acceso: ¿dentro de `js/session.js` directamente, o en un archivo nuevo
   que él revise antes de integrarlo?

---

## 7. Próximos pasos

1. Ezamoraideaz revisa esta propuesta y responde los puntos de la sección 6.
2. Con el ok, se crea la rama `feature/pagos-recurrentes`.
3. Implementación en el orden: esquema de BD → integración Wompi (tokenización + cobro cron) →
   webhook → generación de PDF → emails → gate de acceso en `js/session.js` → PR para revisión.
