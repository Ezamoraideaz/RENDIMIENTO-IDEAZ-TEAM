<?php
require_once __DIR__ . '/../bootstrap.php';

// Configuración por tablero de Trello (presupuestos, alias, carpeta Drive).
// Lectura: cualquier usuario logueado. Escritura: superadmin/admin (todo)
// y cm (únicamente la carpeta de Drive por tablero).

$operator = require_login();
$pdo = db();

// Mapa columna BD → campo del frontend (formato de Storage.getProjectData)
const PROJECT_FIELDS = [
    'budget'          => 'budget',
    'revenue'         => 'revenue',
    'currency'        => 'currency',
    'hours_estimated' => 'hoursEstimated',
    'alias'           => 'alias',
    'category'        => 'category',
    'period'          => 'period',
    'project_type'    => 'type',
    'drive_folder_id' => 'driveFolderId',
];

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $stmt = $pdo->query('SELECT * FROM project_settings');
        $projects = [];
        foreach ($stmt->fetchAll() as $row) {
            $item = [];
            foreach (PROJECT_FIELDS as $col => $field) {
                $item[$field] = in_array($col, ['budget', 'revenue', 'hours_estimated'], true)
                    ? (float)$row[$col]
                    : $row[$col];
            }
            $projects[$row['board_id']] = $item;
        }
        json_response(['projects' => $projects]);
        break;

    case 'POST':
        $operator = require_state_changing_request();
        if (!in_array($operator['role'], ['superadmin', 'admin', 'cm'], true)) {
            json_error('No autorizado para modificar la configuración de proyectos', 403);
        }
        $input = json_body();
        $incoming = $input['projects'] ?? null;
        if (!is_array($incoming) || $incoming === []) {
            json_error('Se requiere el objeto projects con al menos un tablero', 400);
        }

        // cm solo puede tocar la carpeta de Drive
        $writableCols = $operator['role'] === 'cm'
            ? ['drive_folder_id']
            : array_keys(PROJECT_FIELDS);

        $saved = [];
        foreach ($incoming as $boardId => $data) {
            $boardId = trim((string)$boardId);
            if ($boardId === '' || strlen($boardId) > 64 || !is_array($data)) {
                json_error('Tablero inválido en la petición', 400);
            }

            $cols = [];
            $values = [];
            foreach ($writableCols as $col) {
                $field = PROJECT_FIELDS[$col];
                if (!array_key_exists($field, $data)) {
                    continue;
                }
                $cols[] = $col;
                $values[] = in_array($col, ['budget', 'revenue', 'hours_estimated'], true)
                    ? (float)$data[$field]
                    : trim((string)$data[$field]);
            }
            if ($cols === []) {
                continue;
            }

            $insertCols = implode(', ', $cols);
            $placeholders = implode(', ', array_fill(0, count($cols), '?'));
            $updates = implode(', ', array_map(fn($c) => "{$c} = VALUES({$c})", $cols));
            $sql = "INSERT INTO project_settings (board_id, {$insertCols}) VALUES (?, {$placeholders})
                    ON DUPLICATE KEY UPDATE {$updates}";
            $pdo->prepare($sql)->execute(array_merge([$boardId], $values));
            $saved[] = $boardId;
        }
        json_response(['saved' => $saved]);
        break;

    default:
        json_error('Método no permitido', 405);
}
