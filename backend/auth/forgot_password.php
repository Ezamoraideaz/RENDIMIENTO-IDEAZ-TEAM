<?php
require_once __DIR__ . '/../bootstrap.php';

// Recuperación de contraseña self-service. Responde SIEMPRE el mismo mensaje
// genérico, exista o no el email, para no revelar qué correos están registrados.

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_body();
$email = trim($input['email'] ?? '');

if ($email === '') {
    json_error('Ingresa tu email', 400);
}

$stmt = db()->prepare('SELECT id, email, name FROM operators WHERE email = ? AND active = 1');
$stmt->execute([$email]);
$operator = $stmt->fetch();

if ($operator) {
    issue_password_reset(db(), $operator, 'self', $_SERVER['REMOTE_ADDR'] ?? null);
}

json_response([
    'ok' => true,
    'message' => 'Si el correo está registrado, enviaremos instrucciones para restablecer la contraseña.',
]);
