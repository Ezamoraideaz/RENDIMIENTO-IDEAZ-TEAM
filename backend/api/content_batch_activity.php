<?php
require_once __DIR__ . '/../bootstrap.php';

// Bitácora de actividad del portal de revisión (revisar.html) para una tanda
// — material probatorio de quién abrió el link y qué decidió, aparte del
// feedback ya visible en content_batches.php. Mismos roles que el resto del
// módulo de aprobaciones.
require_role(['cm', 'admin', 'superadmin']);

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();

switch ($method) {
    case 'GET':
        $batchId = (int)($_GET['batch_id'] ?? 0);
        if ($batchId <= 0) {
            json_error('batch_id requerido', 400);
        }

        $stmt = $pdo->prepare('
            SELECT a.id, a.content_item_id, a.event_type, a.reviewer_name, a.reviewer_role,
                   a.reviewer_device_id, a.ip, a.user_agent, a.metadata, a.created_at,
                   i.type AS item_type, i.caption AS item_caption
            FROM content_review_activity a
            LEFT JOIN content_items i ON i.id = a.content_item_id
            WHERE a.batch_id = ?
            ORDER BY a.created_at ASC, a.id ASC
        ');
        $stmt->execute([$batchId]);
        $rows = $stmt->fetchAll();
        foreach ($rows as &$row) {
            $row['metadata'] = $row['metadata'] ? json_decode($row['metadata'], true) : null;
        }
        unset($row);

        json_response(['activity' => $rows]);
        break;

    default:
        json_error('Método no permitido', 405);
}
