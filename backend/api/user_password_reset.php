<?php
require_once __DIR__ . '/../bootstrap.php';

// Reenvío admin de la notificación de recuperación de contraseña — solo superadmin.
// Vive aparte de api/users.php porque no es un CRUD del recurso "usuario", es una
// acción (disparar correo) que comparte lógica con el flujo self-service.

require_role(['superadmin']);
require_state_changing_request();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$pdo = db();
$input = json_body();
$id = (int)($input['id'] ?? 0);

if ($id <= 0) {
    json_error('id requerido', 400);
}

$stmt = $pdo->prepare('SELECT id, email, name FROM operators WHERE id = ?');
$stmt->execute([$id]);
$operator = $stmt->fetch();

if (!$operator) {
    json_error('Usuario no encontrado', 404);
}

$result = issue_password_reset($pdo, $operator, 'admin', $_SERVER['REMOTE_ADDR'] ?? null);
json_response($result);
