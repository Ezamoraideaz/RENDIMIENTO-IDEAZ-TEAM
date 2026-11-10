<?php
declare(strict_types=1);

// Login por sesión PHP (no llave compartida) — este módulo maneja tokens reales de
// Página/IG y puede enviar mensajes en nombre del negocio de un cliente, a diferencia
// de las credenciales de Trello (solo lectura) que sí viven en localStorage.

// Un solo reloj para "qué día es hoy": el proyecto nunca llama
// date_default_timezone_set(), así que no se puede confiar en date()/time().
function bogota_today(): string
{
    return (new DateTime('now', new DateTimeZone('America/Bogota')))->format('Y-m-d');
}

function current_operator(): ?array
{
    if (empty($_SESSION['operator_id'])) {
        return null;
    }
    // Expiración explícita a medianoche America/Bogota, independiente de la
    // inactividad: si el día de login guardado ya no es "hoy" en Bogotá, la
    // sesión murió (fuerza volver a iniciar sesión cada mañana).
    if (($_SESSION['login_day'] ?? '') !== bogota_today()) {
        $_SESSION = [];
        session_destroy();
        return null;
    }
    $cols = 'id, email, name, role, trello_member_id' . (operators_have_permissions_column() ? ', permissions' : '');
    $stmt = db()->prepare("SELECT $cols FROM operators WHERE id = ? AND active = 1");
    $stmt->execute([$_SESSION['operator_id']]);
    $operator = $stmt->fetch();
    if (!$operator) {
        return null;
    }
    $operator['permissions'] = decode_permissions($operator['permissions'] ?? null);
    return $operator;
}

// ── Permisos por usuario (interruptores en Configuración → Equipo) ──────────────
// Catálogo único: clave => etiqueta/descripción. Para sumar un permiso nuevo basta
// agregarlo aquí (el panel de Equipo lo dibuja solo) y consultarlo con operator_can().
// superadmin y admin tienen todos los permisos implícitamente; el resto solo los que
// el superadmin les active. Requiere backend/sql/migration_027_operator_permissions.sql
// (mientras no se corra, nadie tiene permisos extra y el sitio sigue funcionando).
const OPERATOR_PERMISSIONS = [
    'create_brands' => [
        'label'       => 'Crear marcas',
        'description' => 'Puede crear marcas nuevas en Configuración → Marcas.',
    ],
];

function operators_have_permissions_column(): bool
{
    static $has = null;
    if ($has === null) {
        try {
            $has = (bool)db()->query("SHOW COLUMNS FROM operators LIKE 'permissions'")->fetch();
        } catch (Throwable $e) {
            $has = false;
        }
    }
    return $has;
}

function decode_permissions($raw): array
{
    $data = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        return [];
    }
    $out = [];
    foreach (array_keys(OPERATOR_PERMISSIONS) as $key) {
        if (!empty($data[$key])) {
            $out[] = $key;
        }
    }
    return $out;
}

function operator_can(array $operator, string $permission): bool
{
    if (in_array($operator['role'] ?? '', ['superadmin', 'admin'], true)) {
        return true;
    }
    return in_array($permission, $operator['permissions'] ?? [], true);
}

// Exige un permiso puntual (los roles superadmin/admin siempre lo cumplen).
function require_permission(array $operator, string $permission): void
{
    if (!operator_can($operator, $permission)) {
        json_error('No tienes permiso para esta acción. Pídele al superadministrador que te la active en Configuración → Equipo.', 403);
    }
}

function require_login(): array
{
    $operator = current_operator();
    if ($operator === null) {
        json_error('No autenticado', 401);
    }
    return $operator;
}

// Exige que el usuario logueado tenga uno de los roles indicados.
function require_role(array $roles): array
{
    $operator = require_login();
    if (!in_array($operator['role'], $roles, true)) {
        json_error('No autorizado para esta acción', 403);
    }
    return $operator;
}

// Acceso al módulo Atención al Cliente (los roles de agenda no entran aquí;
// cm sí, para poder delegar la gestión del módulo)
function require_atencion_access(): array
{
    return require_role(['superadmin', 'admin', 'agent', 'cm']);
}

// Asistente "Configurar cliente" (configurar-cliente.html): lo usan CM y PM
// (agenda_full) además de los roles de Atención al Cliente. Cubre también los
// endpoints que el asistente reutiliza (logo, conexión de Facebook/Instagram).
function require_client_setup_access(): array
{
    return require_role(['superadmin', 'admin', 'agent', 'cm', 'agenda_full']);
}

function csrf_token(): string
{
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

function verify_csrf(): void
{
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (empty($_SESSION['csrf_token']) || !hash_equals($_SESSION['csrf_token'], $sent)) {
        json_error('Token CSRF inválido', 403);
    }
}

// Para endpoints que cambian estado (POST/PUT/DELETE en /backend/api/*)
function require_state_changing_request(): array
{
    $operator = require_login();
    verify_csrf();
    return $operator;
}

// Acceso al módulo Egresos (gastos y préstamos del equipo) — "PM" en
// CLAUDE.md es el rol agenda_full (el módulo Agenda ya se hizo "para PM y CM").
function require_expenses_access(): array
{
    return require_role(['superadmin', 'admin', 'agenda_full']);
}

// Acceso al módulo Rendición Trimestral — cm diligencia sus propias cuentas,
// superadmin/admin además ven el dashboard consolidado y gestionan la
// encuesta al cliente.
function require_rendicion_access(): array
{
    return require_role(['superadmin', 'admin', 'cm']);
}

// Dashboard/encuesta de Rendición: solo el dueño/directivos, no el CM.
function require_rendicion_admin_access(): array
{
    return require_role(['superadmin', 'admin']);
}
