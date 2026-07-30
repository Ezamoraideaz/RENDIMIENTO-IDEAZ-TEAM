<?php
require_once __DIR__ . '/../bootstrap.php';

// Piezas dentro de una tanda del portal de aprobación. Mismos roles que
// content_batches.php — ver PRD §4.
require_role(['cm', 'admin', 'superadmin']);

const CONTENT_ITEM_TYPES = ['feed', 'story', 'reel', 'carousel'];

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();

function content_item_row(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM content_items WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    $row['media'] = json_decode($row['media'], true) ?? [];
    return $row;
}

switch ($method) {
    case 'GET':
        $id = (int)($_GET['id'] ?? 0);
        if ($id > 0) {
            $item = content_item_row($pdo, $id);
            if (!$item) {
                json_error('Pieza no encontrada', 404);
            }
            json_response(['item' => $item]);
            break;
        }

        $batchId = (int)($_GET['batch_id'] ?? 0);
        if ($batchId <= 0) {
            json_error('batch_id requerido', 400);
        }
        $stmt = $pdo->prepare('SELECT * FROM content_items WHERE batch_id = ? ORDER BY position ASC, id ASC');
        $stmt->execute([$batchId]);
        $items = $stmt->fetchAll();
        foreach ($items as &$item) {
            $item['media'] = json_decode($item['media'], true) ?? [];
        }
        unset($item);
        json_response(['items' => $items]);
        break;

    case 'POST':
        require_state_changing_request();
        $input = json_body();
        $batchId = (int)($input['batch_id'] ?? 0);
        $type = $input['type'] ?? '';
        $media = $input['media'] ?? [];

        if ($batchId <= 0) {
            json_error('batch_id es requerido', 400);
        }
        if (!in_array($type, CONTENT_ITEM_TYPES, true)) {
            json_error('type debe ser uno de: ' . implode(', ', CONTENT_ITEM_TYPES), 400);
        }
        if (!is_array($media) || $media === []) {
            json_error('media es requerido (al menos un archivo)', 400);
        }

        $stmt = $pdo->prepare('SELECT id FROM content_batches WHERE id = ?');
        $stmt->execute([$batchId]);
        if (!$stmt->fetch()) {
            json_error('La tanda indicada no existe', 400);
        }

        $caption = isset($input['caption']) ? trim((string)$input['caption']) : null;
        $scheduledAt = $input['scheduled_at'] ?? null;
        $trelloCardId = $input['trello_card_id'] ?? null;
        $position = (int)($input['position'] ?? 0);
        // Necesario para ubicar la carpeta ARTES/año/mes/POST # al momento de
        // mover automáticamente el contenido aprobado (drive_approval_sync.php).
        $postNumber = isset($input['post_number']) && $input['post_number'] !== null ? (int)$input['post_number'] : null;

        $stmt = $pdo->prepare('
            INSERT INTO content_items (batch_id, trello_card_id, type, post_number, caption, scheduled_at, media, position)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ');
        $stmt->execute([
            $batchId,
            $trelloCardId ?: null,
            $type,
            $postNumber,
            $caption,
            $scheduledAt ?: null,
            json_encode(array_values($media)),
            $position,
        ]);
        json_response(['id' => (int)$pdo->lastInsertId()], 201);
        break;

    case 'PUT':
        require_state_changing_request();
        $input = json_body();
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $existing = content_item_row($pdo, $id);
        if (!$existing) {
            json_error('Pieza no encontrada', 404);
        }

        // Reenviar a revisión: el diseñador ya corrigió la pieza (tras
        // "Cambios") y hay que hacerla aparecer de nuevo para el cliente sin
        // crear una tanda nueva — alcanza con devolverla a 'pending' (el
        // historial de decisiones previas queda intacto en content_reviews).
        // Si la tanda ya se había marcado completed_at (porque esta era la
        // última pieza pendiente), se limpia para que el portal no la trate
        // como cerrada; el link solo hay que regenerarlo aparte si venció.
        if (($input['action'] ?? null) === 'resend_for_review') {
            $pdo->prepare("UPDATE content_items SET status = 'pending', decided_at = NULL WHERE id = ?")->execute([$id]);
            $pdo->prepare('UPDATE content_batches SET completed_at = NULL WHERE id = ?')->execute([$existing['batch_id']]);
            json_response(['ok' => true]);
            break;
        }

        $fields = [];
        $values = [];
        foreach (['trello_card_id', 'post_number', 'caption', 'scheduled_at', 'position'] as $field) {
            if (array_key_exists($field, $input)) {
                $fields[] = "{$field} = ?";
                $values[] = $input[$field];
            }
        }
        if (array_key_exists('type', $input)) {
            if (!in_array($input['type'], CONTENT_ITEM_TYPES, true)) {
                json_error('type debe ser uno de: ' . implode(', ', CONTENT_ITEM_TYPES), 400);
            }
            $fields[] = 'type = ?';
            $values[] = $input['type'];
        }
        if (array_key_exists('media', $input)) {
            if (!is_array($input['media']) || $input['media'] === []) {
                json_error('media no puede quedar vacío', 400);
            }
            $fields[] = 'media = ?';
            $values[] = json_encode(array_values($input['media']));
        }
        if (!$fields) {
            json_error('Nada para actualizar', 400);
        }
        $values[] = $id;
        $pdo->prepare('UPDATE content_items SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($values);
        json_response(['ok' => true]);
        break;

    case 'DELETE':
        require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $pdo->prepare('DELETE FROM content_items WHERE id = ?')->execute([$id]);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
