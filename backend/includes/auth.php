<?php
declare(strict_types=1);

// Login por sesión PHP (no llave compartida) — este módulo maneja tokens reales de
// Página/IG y puede enviar mensajes en nombre del negocio de un cliente, a diferencia
// de las credenciales de Trello (solo lectura) que sí viven en localStorage.

function current_operator(): ?array
{
    if (empty($_SESSION['operator_id'])) {
        return null;
    }
    $stmt = db()->prepare('SELECT id, email, name, role, trello_member_id FROM operators WHERE id = ? AND active = 1');
    $stmt->execute([$_SESSION['operator_id']]);
    $operator = $stmt->fetch();
    return $operator ?: null;
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

// Acceso al módulo Atención al Cliente (los roles de agenda/cm no entran aquí)
function require_atencion_access(): array
{
    return require_role(['superadmin', 'admin', 'agent']);
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
