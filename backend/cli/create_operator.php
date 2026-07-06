<?php
// Uso: php backend/cli/create_operator.php email@ejemplo.com contraseñaSegura
// Solo ejecutable desde terminal (bloqueado vía HTTP por backend/.htaccess).

declare(strict_types=1);

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Este script solo puede ejecutarse desde la línea de comandos.');
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';

[$script, $email, $password] = $argv + [null, null, null];
if (!$email || !$password) {
    fwrite(STDERR, "Uso: php create_operator.php email@ejemplo.com contraseña\n");
    exit(1);
}

$hash = password_hash($password, PASSWORD_DEFAULT);
$stmt = db()->prepare(
    'INSERT INTO operators (email, password_hash, role) VALUES (?, ?, "admin")
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)'
);
$stmt->execute([$email, $hash]);

echo "Operador creado/actualizado: {$email}\n";
