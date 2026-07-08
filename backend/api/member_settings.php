<?php
require_once __DIR__ . '/../bootstrap.php';

// Configuración por miembro del equipo (nombre, rol operativo, tarifa por hora).
// Lectura: cualquier usuario logueado. Escritura: nombres los actualiza cualquier
// usuario (son un caché de Trello que el dashboard refresca al navegar); tarifa y
// rol operativo solo superadmin/admin.

$operator = require_login();
$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $stmt = $pdo->query('SELECT member_id, name, member_role, hourly_rate FROM member_settings');
        $members = [];
        foreach ($stmt->fetchAll() as $row) {
            $members[$row['member_id']] = [
                'name' => $row['name'],
                'role' => $row['member_role'],
                'rate' => (float)$row['hourly_rate'],
            ];
        }
        json_response(['members' => $members]);
        break;

    case 'POST':
        $operator = require_state_changing_request();
        $isAdmin = in_array($operator['role'], ['superadmin', 'admin'], true);

        $input = json_body();
        $incoming = $input['members'] ?? null;
        if (!is_array($incoming) || $incoming === []) {
            json_error('Se requiere el objeto members con al menos un miembro', 400);
        }

        $saved = [];
        foreach ($incoming as $memberId => $data) {
            $memberId = trim((string)$memberId);
            if ($memberId === '' || strlen($memberId) > 64 || !is_array($data)) {
                json_error('Miembro inválido en la petición', 400);
            }

            $cols = [];
            $values = [];
            if (array_key_exists('name', $data)) {
                $cols[] = 'name';
                $values[] = trim((string)$data['name']);
            }
            if (array_key_exists('role', $data)) {
                if (!$isAdmin) {
                    json_error('Solo un administrador puede cambiar roles de miembros', 403);
                }
                $cols[] = 'member_role';
                $values[] = trim((string)$data['role']);
            }
            if (array_key_exists('rate', $data)) {
                if (!$isAdmin) {
                    json_error('Solo un administrador puede cambiar tarifas', 403);
                }
                $cols[] = 'hourly_rate';
                $values[] = (float)$data['rate'];
            }
            if ($cols === []) {
                continue;
            }

            $insertCols = implode(', ', $cols);
            $placeholders = implode(', ', array_fill(0, count($cols), '?'));
            $updates = implode(', ', array_map(fn($c) => "{$c} = VALUES({$c})", $cols));
            $sql = "INSERT INTO member_settings (member_id, {$insertCols}) VALUES (?, {$placeholders})
                    ON DUPLICATE KEY UPDATE {$updates}";
            $pdo->prepare($sql)->execute(array_merge([$memberId], $values));
            $saved[] = $memberId;
        }
        json_response(['saved' => $saved]);
        break;

    default:
        json_error('Método no permitido', 405);
}
