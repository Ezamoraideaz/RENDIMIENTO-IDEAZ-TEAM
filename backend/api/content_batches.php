<?php
require_once __DIR__ . '/../bootstrap.php';

// Tandas del portal de aprobación (módulo aprobaciones). Roles: cm (Community
// Manager) y admin/superadmin (los PM se dan de alta como admin — ver PRD §4,
// no existe un rol "pm" en operators). El diseñador no entra a este endpoint.
require_role(['cm', 'admin', 'superadmin']);

const CONTENT_BATCH_LINK_TTL_SECONDS = 3 * 24 * 60 * 60; // fijo, 3 días (PRD §13)

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();

function content_batch_status(array $itemStatuses): string
{
    if (!$itemStatuses) {
        return 'draft';
    }
    if (in_array('pending', $itemStatuses, true)) {
        return 'pending';
    }
    return in_array('changes_requested', $itemStatuses, true) ? 'changes_requested' : 'approved';
}

switch ($method) {
    case 'GET':
        $id = (int)($_GET['id'] ?? 0);

        if ($id > 0) {
            $stmt = $pdo->prepare('
                SELECT b.id, b.client_id, b.label, b.expires_at, b.opened_at, b.completed_at, b.created_at,
                       c.name AS client_name, c.logo_url AS client_logo_url,
                       (b.token_hash IS NOT NULL) AS link_generated
                FROM content_batches b
                JOIN clients c ON c.id = b.client_id
                WHERE b.id = ?
            ');
            $stmt->execute([$id]);
            $batch = $stmt->fetch();
            if (!$batch) {
                json_error('Tanda no encontrada', 404);
            }
            $batch['link_generated'] = (bool)$batch['link_generated'];

            $itemsStmt = $pdo->prepare('
                SELECT i.id, i.trello_card_id, i.type, i.caption, i.scheduled_at, i.media, i.position, i.status, i.decided_at,
                       r.decision AS last_decision, r.comment AS last_comment, r.reason_tags AS last_reason_tags, r.reviewed_at AS last_reviewed_at
                FROM content_items i
                LEFT JOIN content_reviews r ON r.id = (
                    SELECT r2.id FROM content_reviews r2 WHERE r2.content_item_id = i.id ORDER BY r2.reviewed_at DESC LIMIT 1
                )
                WHERE i.batch_id = ?
                ORDER BY i.position ASC, i.id ASC
            ');
            $itemsStmt->execute([$id]);
            $items = $itemsStmt->fetchAll();
            foreach ($items as &$item) {
                $item['media'] = json_decode($item['media'], true) ?? [];
                $item['last_reason_tags'] = $item['last_reason_tags'] ? json_decode($item['last_reason_tags'], true) : null;
            }
            unset($item);

            $batch['status'] = content_batch_status(array_column($items, 'status'));
            $batch['items'] = $items;
            json_response(['batch' => $batch]);
            break;
        }

        $clientId = (int)($_GET['client_id'] ?? 0);
        $where = $clientId > 0 ? 'WHERE b.client_id = ?' : '';
        $params = $clientId > 0 ? [$clientId] : [];
        $stmt = $pdo->prepare("
            SELECT b.id, b.client_id, b.label, b.expires_at, b.opened_at, b.completed_at, b.created_at,
                   c.name AS client_name,
                   (b.token_hash IS NOT NULL) AS link_generated,
                   (SELECT COUNT(*) FROM content_items i WHERE i.batch_id = b.id) AS item_count,
                   (SELECT COUNT(*) FROM content_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending_count,
                   (SELECT COUNT(*) FROM content_items i WHERE i.batch_id = b.id AND i.status = 'changes_requested') AS changes_count
            FROM content_batches b
            JOIN clients c ON c.id = b.client_id
            {$where}
            ORDER BY b.created_at DESC
        ");
        $stmt->execute($params);
        $batches = $stmt->fetchAll();
        foreach ($batches as &$b) {
            $b['link_generated'] = (bool)$b['link_generated'];
        }
        unset($b);
        json_response(['batches' => $batches]);
        break;

    case 'POST':
        $operator = require_state_changing_request();
        $input = json_body();
        $clientId = (int)($input['client_id'] ?? 0);
        $label = trim($input['label'] ?? '');
        if ($clientId <= 0 || $label === '') {
            json_error('client_id y label son requeridos', 400);
        }
        $stmt = $pdo->prepare('INSERT INTO content_batches (client_id, label, created_by) VALUES (?, ?, ?)');
        $stmt->execute([$clientId, $label, $operator['id']]);
        json_response(['id' => (int)$pdo->lastInsertId()], 201);
        break;

    case 'PUT':
        require_state_changing_request();
        $input = json_body();
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $stmt = $pdo->prepare('SELECT id FROM content_batches WHERE id = ?');
        $stmt->execute([$id]);
        if (!$stmt->fetch()) {
            json_error('Tanda no encontrada', 404);
        }

        $action = $input['action'] ?? null;
        if ($action === 'generate_link') {
            $rawToken = bin2hex(random_bytes(32));
            $tokenHash = hash('sha256', $rawToken);
            $expiresAt = (new DateTime('now', new DateTimeZone('UTC')))
                ->modify('+' . CONTENT_BATCH_LINK_TTL_SECONDS . ' seconds')
                ->format('Y-m-d H:i:s');
            // Regenerar invalida cualquier link anterior de esta tanda al pisar el hash.
            $pdo->prepare('UPDATE content_batches SET token_hash = ?, expires_at = ?, opened_at = NULL, completed_at = NULL WHERE id = ?')
                ->execute([$tokenHash, $expiresAt, $id]);
            json_response(['token' => $rawToken, 'expires_at' => $expiresAt]);
            break;
        }

        if (array_key_exists('label', $input)) {
            $label = trim($input['label'] ?? '');
            if ($label === '') {
                json_error('label no puede estar vacío', 400);
            }
            $pdo->prepare('UPDATE content_batches SET label = ? WHERE id = ?')->execute([$label, $id]);
        }
        json_response(['ok' => true]);
        break;

    case 'DELETE':
        require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $pdo->prepare('DELETE FROM content_batches WHERE id = ?')->execute([$id]);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
