<?php
require_once __DIR__ . '/../bootstrap.php';

// Consumo del token de recuperación. Público (sin login) — el token de un solo
// uso hace las veces de credencial temporal.

$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $token = trim($_GET['token'] ?? '');
        $valid = $token !== '' && find_valid_reset_token($pdo, $token) !== null;
        json_response(['valid' => $valid]);
        break;

    case 'POST':
        $input = json_body();
        $token = trim($input['token'] ?? '');
        $password = (string)($input['password'] ?? '');

        if ($token === '') {
            json_error('El enlace es inválido o ya expiró. Solicita uno nuevo.', 400);
        }
        if (strlen($password) < 8) {
            json_error('La contraseña debe tener al menos 8 caracteres', 400);
        }

        $reset = find_valid_reset_token($pdo, $token);
        if ($reset === null) {
            json_error('El enlace es inválido o ya expiró. Solicita uno nuevo.', 400);
        }

        consume_reset_token($pdo, (int)$reset['operator_id'], password_hash($password, PASSWORD_DEFAULT));
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
