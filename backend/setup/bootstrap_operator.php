<?php
// Crear el superadmin SIN acceso a Terminal/SSH (para cPanel sin Terminal).
//
// Uso (una sola vez):
//   1. En backend/config.php define SETUP_TOKEN con un string aleatorio largo
//      (p. ej. 40+ caracteres; puedes generarlo en cualquier generador de contraseñas).
//   2. Sube este archivo al servidor y visita en el navegador:
//      https://tudominio.com/dashboard/backend/setup/bootstrap_operator.php?token=EL_TOKEN
//   3. Completa el formulario. Al terminar, el script intenta borrarse a sí mismo;
//      si no puede, BORRA este archivo del servidor y vacía SETUP_TOKEN en config.php.

declare(strict_types=1);

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';

if (!defined('SETUP_TOKEN') || SETUP_TOKEN === '') {
    http_response_code(403);
    exit('SETUP_TOKEN no está configurado en backend/config.php. Define un valor aleatorio y vuelve a intentar.');
}

$token = (string)($_GET['token'] ?? '');
if ($token === '' || !hash_equals(SETUP_TOKEN, $token)) {
    http_response_code(403);
    exit('Token inválido. Visita esta página con ?token=EL_VALOR_DE_SETUP_TOKEN.');
}

$msg = '';
$ok = false;
$done = false;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $email = trim($_POST['email'] ?? '');
    $name = trim($_POST['name'] ?? '');
    $pass = (string)($_POST['password'] ?? '');
    $pass2 = (string)($_POST['password2'] ?? '');

    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $msg = 'Email inválido.';
    } elseif (strlen($pass) < 8) {
        $msg = 'La contraseña debe tener al menos 8 caracteres.';
    } elseif ($pass !== $pass2) {
        $msg = 'Las contraseñas no coinciden.';
    } else {
        $stmt = db()->prepare(
            'INSERT INTO operators (email, name, password_hash, role, active)
             VALUES (?, ?, ?, "superadmin", 1)
             ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), name = VALUES(name), role = "superadmin", active = 1'
        );
        $stmt->execute([$email, $name, password_hash($pass, PASSWORD_DEFAULT)]);

        $ok = true;
        $done = true;
        $deleted = @unlink(__FILE__);
        $msg = "✅ Superadmin creado/actualizado: {$email}. Ya puedes entrar en login.html. "
            . ($deleted
                ? 'Este archivo se eliminó automáticamente del servidor.'
                : '⚠️ No se pudo autoeliminar: BORRA backend/setup/bootstrap_operator.php manualmente.')
            . ' Vacía también SETUP_TOKEN en config.php.';
    }
}

function esc(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
}
?>
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crear superadmin – Monitor Ideaz</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; padding: 3rem 1rem; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.5rem; width: 100%; max-width: 380px; }
    h1 { font-size: 1.1rem; margin: 0 0 1rem; }
    label { display: block; font-size: 0.8rem; color: #94a3b8; margin: 0.8rem 0 0.25rem; }
    input { width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #475569; border-radius: 8px; padding: 0.5rem 0.7rem; color: #e2e8f0; font-size: 0.9rem; }
    button { margin-top: 1.2rem; width: 100%; background: #4f46e5; border: 0; border-radius: 8px; padding: 0.6rem; color: #fff; font-weight: 600; font-size: 0.9rem; cursor: pointer; }
    .msg { padding: 0.7rem; border-radius: 8px; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .err { background: rgba(244,63,94,.12); border: 1px solid rgba(244,63,94,.4); color: #fda4af; }
    .ok  { background: rgba(16,185,129,.12); border: 1px solid rgba(16,185,129,.4); color: #6ee7b7; }
    p.note { font-size: 0.75rem; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>👑 Crear superadministrador</h1>
    <?php if ($msg !== ''): ?>
      <div class="msg <?= $ok ? 'ok' : 'err' ?>"><?= esc($msg) ?></div>
    <?php endif; ?>
    <?php if (!$done): ?>
    <form method="post" action="?token=<?= esc(urlencode($token)) ?>">
      <label for="name">Nombre</label>
      <input id="name" name="name" type="text" value="<?= esc($_POST['name'] ?? '') ?>" placeholder="Tu nombre">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required value="<?= esc($_POST['email'] ?? '') ?>" placeholder="tu@email.com">
      <label for="password">Contraseña (mín. 8 caracteres)</label>
      <input id="password" name="password" type="password" required minlength="8">
      <label for="password2">Repetir contraseña</label>
      <input id="password2" name="password2" type="password" required minlength="8">
      <button type="submit">Crear superadmin</button>
    </form>
    <p class="note">Este formulario es de un solo uso: al crear el usuario, el archivo se elimina del servidor. Si el email ya existe, se actualiza su contraseña y se le da rol superadmin.</p>
    <?php else: ?>
    <p class="note">Listo. Entra al dashboard desde <strong>login.html</strong>.</p>
    <?php endif; ?>
  </div>
</body>
</html>
