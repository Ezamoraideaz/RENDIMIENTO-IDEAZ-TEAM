<?php
// Alternativa a backend/cli/create_operator.php para hosting SIN Terminal/SSH.
// Crea (o resetea la contraseña de) un operador admin, protegido por SETUP_TOKEN.
//
// IMPORTANTE: borra este archivo del servidor en cuanto termines de usarlo — es un
// endpoint público mientras exista, aunque esté protegido por token.

declare(strict_types=1);

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';

if (!defined('SETUP_TOKEN') || SETUP_TOKEN === '') {
    http_response_code(500);
    echo 'Define SETUP_TOKEN en backend/config.php (un valor aleatorio propio) antes de usar este script.';
    exit;
}

function render_form(string $error = '', string $success = ''): void
{
    echo '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Crear operador</title>
    <style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    form{background:#1e293b;padding:2rem;border-radius:12px;width:100%;max-width:360px}
    input{width:100%;box-sizing:border-box;padding:.6rem;margin:.4rem 0;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0}
    button{width:100%;padding:.7rem;border-radius:6px;border:none;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer;margin-top:.5rem}
    .err{color:#f87171;font-size:.85rem} .ok{color:#34d399;font-size:.85rem}</style></head><body>
    <form method="post">
        <h3>Crear operador</h3>';
    if ($error) echo '<p class="err">' . htmlspecialchars($error) . '</p>';
    if ($success) echo '<p class="ok">' . htmlspecialchars($success) . '</p>';
    echo '
        <input type="text" name="token" placeholder="Setup token" required>
        <input type="email" name="email" placeholder="Email" required>
        <input type="password" name="password" placeholder="Contraseña" required>
        <button type="submit">Crear</button>
    </form></body></html>';
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    render_form();
    exit;
}

$token = $_POST['token'] ?? '';
if (!hash_equals(SETUP_TOKEN, (string)$token)) {
    render_form('Token inválido.');
    exit;
}

$email = trim($_POST['email'] ?? '');
$password = (string)($_POST['password'] ?? '');
if ($email === '' || $password === '') {
    render_form('Email y contraseña son requeridos.');
    exit;
}

$hash = password_hash($password, PASSWORD_DEFAULT);
$stmt = db()->prepare(
    'INSERT INTO operators (email, password_hash, role) VALUES (?, ?, "admin")
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)'
);
$stmt->execute([$email, $hash]);

render_form('', "Operador creado/actualizado: {$email}. Ya puedes iniciar sesión en atencion-cliente.html — BORRA ESTE ARCHIVO DEL SERVIDOR AHORA.");
