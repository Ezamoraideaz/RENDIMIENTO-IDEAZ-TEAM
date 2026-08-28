<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/organic_leads_notify.php';

// Alta manual de leads orgánicos desde el panel — uno o varios de una vez, sin
// tener que armar un Excel para un puñado de leads. Cae en el mismo destino
// que la importación por archivo (organic_leads + organic_lead_imports), para
// que el historial y la notificación por correo sean consistentes; la única
// diferencia es que acá no hay archivo que parsear, solo JSON.

require_atencion_access();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}
$operator = require_state_changing_request();

$pdo = db();
$input = json_body();

$clientId = (int)($input['client_id'] ?? 0);
if ($clientId <= 0) {
    json_error('client_id requerido', 400);
}
$stmt = $pdo->prepare('SELECT id, name FROM clients WHERE id = ?');
$stmt->execute([$clientId]);
$client = $stmt->fetch();
if (!$client) {
    json_error('Cliente no encontrado', 404);
}

$leadsInput = is_array($input['leads'] ?? null) ? $input['leads'] : [];
if (!$leadsInput) {
    json_error('Agrega al menos un lead', 400);
}

$pdo->beginTransaction();
try {
    $importStmt = $pdo->prepare('INSERT INTO organic_lead_imports (client_id, filename, row_count, imported_by) VALUES (?, ?, 0, ?)');
    $importStmt->execute([$clientId, 'Entrada manual', $operator['id']]);
    $importId = (int)$pdo->lastInsertId();

    $leadStmt = $pdo->prepare('INSERT INTO organic_leads (client_id, import_id, name, email, phone, lead_date, reason) VALUES (?, ?, ?, ?, ?, ?, ?)');
    $inserted = 0;
    foreach ($leadsInput as $row) {
        if (!is_array($row)) {
            continue;
        }
        $name  = trim((string)($row['name'] ?? ''));
        $email = trim((string)($row['email'] ?? ''));
        $phone = trim((string)($row['phone'] ?? ''));
        $reason = trim((string)($row['reason'] ?? ''));
        if ($name === '' && $email === '' && $phone === '' && $reason === '') {
            continue; // fila vacía
        }
        // El input viene de <input type="date">, así que ya llega en Y-m-d — se
        // valida el formato en vez de reusar parse_lead_date() (pensado para
        // texto libre de un archivo importado).
        $leadDateRaw = trim((string)($row['lead_date'] ?? ''));
        $leadDate = preg_match('/^\d{4}-\d{2}-\d{2}$/', $leadDateRaw) ? $leadDateRaw : null;

        $leadStmt->execute([
            $clientId,
            $importId,
            $name !== '' ? $name : null,
            $email !== '' ? $email : null,
            $phone !== '' ? $phone : null,
            $leadDate,
            $reason !== '' ? $reason : null,
        ]);
        $inserted++;
    }

    if ($inserted === 0) {
        $pdo->rollBack();
        json_error('Completa al menos un campo en alguna fila', 400);
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
    send_organic_lead_import_notification($pdo, $client, 'Entrada manual', $inserted);
} catch (Throwable $e) {
    error_log('[organic_lead_manual] notify failed: ' . $e->getMessage());
}

json_response(['import_id' => $importId, 'row_count' => $inserted], 201);
