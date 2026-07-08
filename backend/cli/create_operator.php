<?php
// Uso: php backend/cli/create_operator.php email@ejemplo.com contraseñaSegura [rol] [nombre]
// Roles válidos: superadmin | admin | agent | agenda_full | agenda_member | cm (default: admin)
// Solo ejecutable desde terminal (bloqueado vía HTTP por backend/.htaccess).

declare(strict_types=1);

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Este script solo puede ejecutarse desde la línea de comandos.');
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';

[$script, $email, $password, $role, $name] = $argv + [null, null, null, 'admin', ''];
if (!$email || !$password) {
    fwrite(STDERR, "Uso: php create_operator.php email@ejemplo.com contraseña [rol] [nombre]\n");
    exit(1);
}

$validRoles = ['superadmin', 'admin', 'agent', 'agenda_full', 'agenda_member', 'cm'];
if (!in_array($role, $validRoles, true)) {
    fwrite(STDERR, 'Rol inválido. Usa uno de: ' . implode(' | ', $validRoles) . "\n");
    exit(1);
}

$hash = password_hash($password, PASSWORD_DEFAULT);
$stmt = db()->prepare(
    'INSERT INTO operators (email, name, password_hash, role, active) VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role), name = VALUES(name), active = 1'
);
$stmt->execute([$email, $name, $hash, $role]);

echo "Usuario creado/actualizado: {$email} (rol: {$role})\n";
