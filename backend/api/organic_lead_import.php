<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/spreadsheet_reader.php';
require_once __DIR__ . '/../includes/organic_leads_notify.php';

// Importación de leads orgánicos desde un archivo .xlsx/.csv subido por el
// operador. multipart/form-data, así que no pasa por json_body() ni por el
// helper JS api() (que fuerza Content-Type: application/json) — ver
// importOrganicLeadsFile() en js/atencionCliente.js.

const ORGANIC_LEAD_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

$operator = require_atencion_access();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}
verify_csrf();

$pdo = db();

$clientId = (int)($_POST['client_id'] ?? 0);
if ($clientId <= 0) {
    json_error('client_id requerido', 400);
}
$stmt = $pdo->prepare('SELECT id, name FROM clients WHERE id = ?');
$stmt->execute([$clientId]);
$client = $stmt->fetch();
if (!$client) {
    json_error('Cliente no encontrado', 404);
}

if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    json_error('Sube un archivo .xlsx o .csv', 400);
}
$file = $_FILES['file'];

if ($file['size'] > ORGANIC_LEAD_IMPORT_MAX_BYTES) {
    json_error('El archivo supera el máximo de 5 MB', 400);
}

$ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
if (!in_array($ext, ['xlsx', 'csv'], true)) {
    json_error('Formato no soportado. Sube un archivo .xlsx o .csv', 400);
}

try {
    $rows = read_spreadsheet_rows($file['tmp_name'], $file['name']);
} catch (Throwable $e) {
    json_error($e->getMessage(), 400);
}

if (count($rows) < 2) {
    json_error('El archivo no tiene filas de datos (solo encabezados o está vacío)', 400);
}

$headers = array_shift($rows);
$colMap = map_lead_columns($headers);

$pdo->beginTransaction();
try {
    $importStmt = $pdo->prepare('INSERT INTO organic_lead_imports (client_id, filename, row_count, imported_by) VALUES (?, ?, 0, ?)');
    $importStmt->execute([$clientId, $file['name'], $operator['id']]);
    $importId = (int)$pdo->lastInsertId();

    $leadStmt = $pdo->prepare('INSERT INTO organic_leads (client_id, import_id, name, email, phone, lead_date, extra, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $mappedCols = [$colMap['name'], $colMap['email'], $colMap['phone'], $colMap['date'], $colMap['reason']];
    $inserted = 0;
    foreach ($rows as $row) {
        if (!array_filter($row, static fn($v) => trim((string)$v) !== '')) {
            continue; // fila completamente vacía
        }
        $name   = $colMap['name']   !== null ? ($row[$colMap['name']]   ?? '') : '';
        $email  = $colMap['email']  !== null ? ($row[$colMap['email']]  ?? '') : '';
        $phone  = $colMap['phone']  !== null ? ($row[$colMap['phone']]  ?? '') : '';
        $reason = $colMap['reason'] !== null ? trim((string)($row[$colMap['reason']] ?? '')) : '';
        $leadDate = $colMap['date'] !== null ? parse_lead_date((string)($row[$colMap['date']] ?? '')) : null;

        $extra = [];
        foreach ($headers as $i => $header) {
            if (in_array($i, $mappedCols, true)) {
                continue;
            }
            $header = trim((string)$header);
            if ($header === '') {
                continue;
            }
            $extra[$header] = $row[$i] ?? '';
        }

        $leadStmt->execute([
            $clientId,
            $importId,
            $name !== '' ? $name : null,
            $email !== '' ? $email : null,
            $phone !== '' ? $phone : null,
            $leadDate,
            $extra ? json_encode($extra, JSON_UNESCAPED_UNICODE) : null,
            $reason !== '' ? $reason : null,
        ]);
        $inserted++;
    }

    if ($inserted === 0) {
        $pdo->rollBack();
        json_error('No se encontró ninguna fila con datos para importar', 400);
    }

    $pdo->prepare('UPDATE organic_lead_imports SET row_count = ? WHERE id = ?')->execute([$inserted, $importId]);
    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    throw $e;
}

try {
    send_organic_lead_import_notification($pdo, $client, $file['name'], $inserted);
} catch (Throwable $e) {
    error_log('[organic_lead_import] notify failed: ' . $e->getMessage());
}

json_response(['import_id' => $importId, 'row_count' => $inserted], 201);
