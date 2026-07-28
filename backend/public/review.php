<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/trello_sync.php';
require_once __DIR__ . '/../includes/drive_approval_sync.php';

// Portal público de revisión del cliente (revisar.html?t=<token>). Sin sesión,
// sin CSRF — el cliente no es un operator, se autentica solo con el token del
// link (igual que password_resets). Ver PRD §8.

const CONTENT_REVIEW_REASON_TAGS = [
    'Cambiar el copy',
    'Cambiar la foto/video',
    'Corregir logo',
    'Ortografía',
    'Precio/fecha',
    'Hashtags',
    'Otro',
];

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();

function content_review_find_batch(PDO $pdo, string $rawToken): ?array
{
    $tokenHash = hash('sha256', $rawToken);
    $stmt = $pdo->prepare('
        SELECT b.id, b.client_id, b.label, b.expires_at, b.opened_at, b.completed_at,
               c.name AS client_name, c.logo_url AS client_logo_url, c.timezone AS client_timezone
        FROM content_batches b
        JOIN clients c ON c.id = b.client_id
        WHERE b.token_hash = ?
    ');
    $stmt->execute([$tokenHash]);
    $batch = $stmt->fetch();
    return $batch ?: null;
}

switch ($method) {
    case 'GET':
        $rawToken = trim($_GET['t'] ?? '');
        if ($rawToken === '') {
            json_error('t requerido', 400);
        }

        $batch = content_review_find_batch($pdo, $rawToken);
        if (!$batch) {
            json_response(['status' => 'invalid']);
            break;
        }
        if ($batch['completed_at'] !== null) {
            json_response(['status' => 'completed']);
            break;
        }
        $now = (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');
        if ($batch['expires_at'] < $now) {
            json_response(['status' => 'expired']);
            break;
        }

        if ($batch['opened_at'] === null) {
            $pdo->prepare('UPDATE content_batches SET opened_at = NOW() WHERE id = ?')->execute([$batch['id']]);
        }

        $itemsStmt = $pdo->prepare('
            SELECT id, type, caption, scheduled_at, media, position, status
            FROM content_items
            WHERE batch_id = ?
            ORDER BY position ASC, id ASC
        ');
        $itemsStmt->execute([$batch['id']]);
        $items = $itemsStmt->fetchAll();
        foreach ($items as &$item) {
            $item['media'] = json_decode($item['media'], true) ?? [];
        }
        unset($item);

        json_response([
            'status' => 'ok',
            'client' => [
                'name'     => $batch['client_name'],
                'logo_url' => $batch['client_logo_url'],
                'timezone' => $batch['client_timezone'],
            ],
            'items' => $items,
        ]);
        break;

    case 'POST':
        $input = json_body();
        $rawToken = trim($input['t'] ?? '');
        $itemId = (int)($input['item_id'] ?? 0);
        $decision = $input['decision'] ?? '';

        if ($rawToken === '' || $itemId <= 0) {
            json_error('t e item_id son requeridos', 400);
        }
        if (!in_array($decision, ['approved', 'changes_requested'], true)) {
            json_error('decision debe ser approved o changes_requested', 400);
        }

        $batch = content_review_find_batch($pdo, $rawToken);
        if (!$batch) {
            json_error('Link inválido', 404);
        }
        if ($batch['completed_at'] !== null) {
            json_error('Esta tanda ya fue completada', 410);
        }
        $now = (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');
        if ($batch['expires_at'] < $now) {
            json_error('Este link ya no es válido, pide uno nuevo', 410);
        }

        $comment = isset($input['comment']) ? trim((string)$input['comment']) : null;
        $reasonTags = $input['reason_tags'] ?? [];
        if ($decision === 'changes_requested') {
            if ($comment === null || $comment === '') {
                json_error('Se requiere un comentario para pedir cambios', 400);
            }
            if (!is_array($reasonTags) || $reasonTags === []) {
                json_error('Se requiere al menos una etiqueta de motivo', 400);
            }
            foreach ($reasonTags as $tag) {
                if (!in_array($tag, CONTENT_REVIEW_REASON_TAGS, true)) {
                    json_error("Etiqueta de motivo no válida: {$tag}", 400);
                }
            }
        } else {
            $reasonTags = [];
        }

        $stmt = $pdo->prepare('SELECT id, trello_card_id, status FROM content_items WHERE id = ? AND batch_id = ?');
        $stmt->execute([$itemId, $batch['id']]);
        $item = $stmt->fetch();
        if (!$item) {
            json_error('Pieza no encontrada en esta tanda', 404);
        }
        if ($item['status'] !== 'pending') {
            json_error('Ya se registró una decisión para esta pieza', 409);
        }

        $pdo->beginTransaction();
        try {
            $pdo->prepare('
                INSERT INTO content_reviews (content_item_id, decision, comment, reason_tags, reviewer_ip)
                VALUES (?, ?, ?, ?, ?)
            ')->execute([
                $itemId,
                $decision,
                $comment,
                $reasonTags ? json_encode($reasonTags) : null,
                $_SERVER['REMOTE_ADDR'] ?? null,
            ]);
            $pdo->prepare('UPDATE content_items SET status = ?, decided_at = NOW() WHERE id = ?')
                ->execute([$decision, $itemId]);
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        trello_sync_decision($pdo, $item['trello_card_id'], $decision, $comment, $reasonTags);

        if ($decision === 'approved') {
            drive_approval_sync($pdo, $itemId, (int)$batch['client_id']);
        }

        $pendingStmt = $pdo->prepare("SELECT COUNT(*) FROM content_items WHERE batch_id = ? AND status = 'pending'");
        $pendingStmt->execute([$batch['id']]);
        $pendingLeft = (int)$pendingStmt->fetchColumn();
        $batchCompleted = false;
        if ($pendingLeft === 0) {
            $pdo->prepare('UPDATE content_batches SET completed_at = NOW() WHERE id = ?')->execute([$batch['id']]);
            $batchCompleted = true;
        }

        json_response(['ok' => true, 'batch_completed' => $batchCompleted]);
        break;

    default:
        json_error('Método no permitido', 405);
}
