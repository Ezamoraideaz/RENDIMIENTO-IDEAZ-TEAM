<?php
require_once __DIR__ . '/../bootstrap.php';

// Configuración por miembro del equipo (nombre, rol operativo, tarifa por hora).
// Lectura: cualquier usuario logueado. Escritura: nombres los actualiza cualquier
// usuario (son un caché de Trello que el dashboard refresca al navegar); tarifa y
// rol operativo solo superadmin/admin.

$operator = require_login();
$pdo = db();

// Cumpleaños (solo día y mes): requiere migration_028_member_birthday.sql. Sin la
// migración todo lo demás sigue funcionando y el cumpleaños simplemente no se guarda.
$hasBirthday = false;
try {
    $hasBirthday = (bool)$pdo->query("SHOW COLUMNS FROM member_settings LIKE 'birth_month'")->fetch();
} catch (Throwable $e) {
    $hasBirthday = false;
}

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $stmt = $pdo->query('SELECT member_id, name, member_role, hourly_rate' . ($hasBirthday ? ', birth_month, birth_day' : '') . ' FROM member_settings');
        $members = [];
        foreach ($stmt->fetchAll() as $row) {
            $members[$row['member_id']] = [
                'name' => $row['name'],
                'role' => $row['member_role'],
                'rate' => (float)$row['hourly_rate'],
                'birth_month' => isset($row['birth_month']) ? (int)$row['birth_month'] : null,
                'birth_day' => isset($row['birth_day']) ? (int)$row['birth_day'] : null,
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
            if (array_key_exists('birth_month', $data) || array_key_exists('birth_day', $data)) {
                if (!$isAdmin) {
                    json_error('Solo un administrador puede cambiar cumpleaños', 403);
                }
                if (!$hasBirthday) {
                    json_error('Falta correr backend/sql/migration_028_member_birthday.sql en la base de datos', 500);
                }
                $month = ($data['birth_month'] ?? null) === null || $data['birth_month'] === '' ? null : (int)$data['birth_month'];
                $day = ($data['birth_day'] ?? null) === null || $data['birth_day'] === '' ? null : (int)$data['birth_day'];
                if (($month === null) !== ($day === null)) {
                    json_error('El cumpleaños requiere día y mes', 400);
                }
                // 2000 es bisiesto: permite el 29 de febrero
                if ($month !== null && !checkdate($month, $day, 2000)) {
                    json_error('Fecha de cumpleaños inválida', 400);
                }
                $cols[] = 'birth_month';
                $values[] = $month;
                $cols[] = 'birth_day';
                $values[] = $day;
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
