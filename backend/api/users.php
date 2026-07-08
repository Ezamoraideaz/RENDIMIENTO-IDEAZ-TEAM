<?php
require_once __DIR__ . '/../bootstrap.php';

// Gestión de usuarios del sitio — exclusivo del superadministrador.

$operator = require_role(['superadmin']);
$pdo = db();

const VALID_ROLES = ['superadmin', 'admin', 'agent', 'agenda_full', 'agenda_member', 'cm'];

function count_other_active_superadmins(PDO $pdo, int $excludeId): int
{
    $stmt = $pdo->prepare("SELECT COUNT(*) FROM operators WHERE role = 'superadmin' AND active = 1 AND id != ?");
    $stmt->execute([$excludeId]);
    return (int)$stmt->fetchColumn();
}

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $stmt = $pdo->query('SELECT id, email, name, role, trello_member_id, active, created_at FROM operators ORDER BY active DESC, name ASC, email ASC');
        json_response(['users' => $stmt->fetchAll()]);
        break;

    case 'POST':
        require_state_changing_request();
        $input = json_body();
        $email = trim($input['email'] ?? '');
        $name = trim($input['name'] ?? '');
        $password = (string)($input['password'] ?? '');
        $role = trim($input['role'] ?? '');
        $trelloMemberId = trim($input['trello_member_id'] ?? '') ?: null;

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            json_error('Email inválido', 400);
        }
        if (strlen($password) < 8) {
            json_error('La contraseña debe tener al menos 8 caracteres', 400);
        }
        if (!in_array($role, VALID_ROLES, true)) {
            json_error('Rol inválido', 400);
        }
        if ($role === 'agenda_member' && $trelloMemberId === null) {
            json_error('El rol de agenda bloqueada requiere un miembro de Trello', 400);
        }

        $stmt = $pdo->prepare('INSERT INTO operators (email, name, password_hash, role, trello_member_id) VALUES (?, ?, ?, ?, ?)');
        try {
            $stmt->execute([$email, $name, password_hash($password, PASSWORD_DEFAULT), $role, $trelloMemberId]);
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                json_error('Ya existe un usuario con ese email', 409);
            }
            throw $e;
        }
        json_response(['id' => (int)$pdo->lastInsertId()], 201);
        break;

    case 'PUT':
        require_state_changing_request();
        $input = json_body();
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $stmt = $pdo->prepare('SELECT id, role, active FROM operators WHERE id = ?');
        $stmt->execute([$id]);
        $target = $stmt->fetch();
        if (!$target) {
            json_error('Usuario no encontrado', 404);
        }

        $fields = [];
        $values = [];

        if (array_key_exists('name', $input)) {
            $fields[] = 'name = ?';
            $values[] = trim((string)$input['name']);
        }
        if (array_key_exists('email', $input)) {
            $email = trim((string)$input['email']);
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                json_error('Email inválido', 400);
            }
            $fields[] = 'email = ?';
            $values[] = $email;
        }
        if (array_key_exists('role', $input)) {
            $role = trim((string)$input['role']);
            if (!in_array($role, VALID_ROLES, true)) {
                json_error('Rol inválido', 400);
            }
            if ($target['role'] === 'superadmin' && $role !== 'superadmin' && count_other_active_superadmins($pdo, $id) === 0) {
                json_error('No puedes quitar el rol al único superadministrador activo', 400);
            }
            $fields[] = 'role = ?';
            $values[] = $role;
        }
        if (array_key_exists('trello_member_id', $input)) {
            $fields[] = 'trello_member_id = ?';
            $values[] = trim((string)$input['trello_member_id']) ?: null;
        }
        if (array_key_exists('active', $input)) {
            $active = (int)(!empty($input['active']));
            if ($active === 0 && $target['role'] === 'superadmin' && count_other_active_superadmins($pdo, $id) === 0) {
                json_error('No puedes desactivar al único superadministrador activo', 400);
            }
            $fields[] = 'active = ?';
            $values[] = $active;
        }
        if (array_key_exists('password', $input) && (string)$input['password'] !== '') {
            $password = (string)$input['password'];
            if (strlen($password) < 8) {
                json_error('La contraseña debe tener al menos 8 caracteres', 400);
            }
            $fields[] = 'password_hash = ?';
            $values[] = password_hash($password, PASSWORD_DEFAULT);
        }

        if ($fields === []) {
            json_error('Nada que actualizar', 400);
        }
        $values[] = $id;
        try {
            $pdo->prepare('UPDATE operators SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($values);
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                json_error('Ya existe un usuario con ese email', 409);
            }
            throw $e;
        }
        json_response(['updated' => $id]);
        break;

    default:
        json_error('Método no permitido', 405);
}
