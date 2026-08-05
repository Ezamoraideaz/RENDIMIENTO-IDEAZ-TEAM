<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/trello_sync.php';
require_once __DIR__ . '/../includes/drive_approval_sync.php';
require_once __DIR__ . '/../includes/content_batch_lookup.php';
require_once __DIR__ . '/../includes/google_drive.php';

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

// Bitácora de actividad (content_review_activity) — material probatorio de
// quién accedió al portal y qué hizo, aparte de content_reviews (que solo
// guarda decisiones finales). "Mejor esfuerzo": si falla, se registra en
// error_log y se ignora, nunca debe tirar abajo la request del cliente.
function content_review_log_activity(
    PDO $pdo,
    int $batchId,
    ?int $itemId,
    string $eventType,
    ?string $reviewerName,
    ?string $reviewerRole,
    ?string $deviceId,
    ?array $metadata = null
): void {
    try {
        $pdo->prepare('
            INSERT INTO content_review_activity
                (batch_id, content_item_id, event_type, reviewer_name, reviewer_role, reviewer_device_id, ip, user_agent, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ')->execute([
            $batchId,
            $itemId,
            $eventType,
            $reviewerName !== '' ? $reviewerName : null,
            $reviewerRole !== '' ? $reviewerRole : null,
            $deviceId !== '' ? $deviceId : null,
            $_SERVER['REMOTE_ADDR'] ?? null,
            mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 400) ?: null,
            $metadata ? json_encode($metadata) : null,
        ]);
    } catch (Throwable $e) {
        error_log('[content_review_activity] ' . $e->getMessage());
    }
}

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();

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

        // Cada apertura queda registrada (con o sin identidad todavía — la
        // primerísima carga de un dispositivo nuevo pasa por acá antes de que
        // revisar.html le pida el nombre) para que quede rastro de acceso aún
        // si esa persona nunca llega a decidir nada.
        content_review_log_activity(
            $pdo,
            (int)$batch['id'],
            null,
            'opened',
            trim((string)($_GET['reviewer_name'] ?? '')),
            trim((string)($_GET['reviewer_role'] ?? '')),
            trim((string)($_GET['device_id'] ?? ''))
        );

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

            // Contenido creado antes de que el frontend guardara mimeType: el
            // webViewLink de Drive no trae el nombre/extensión del archivo, así
            // que sin esto el portal no puede saber si es un video y cae al
            // iframe de Drive — que Google ahora bloquea embeber (CSP
            // frame-ancestors). Se resuelve una sola vez y se guarda en la BD.
            $mediaChanged = false;
            foreach ($item['media'] as &$m) {
                if (!empty($m['mimeType']) || empty($m['url'])) {
                    continue;
                }
                $fileId = google_drive_extract_file_id((string)$m['url']);
                if (!$fileId) {
                    continue;
                }
                $mime = google_drive_get_mime_type($fileId);
                if ($mime) {
                    $m['mimeType'] = $mime;
                    $mediaChanged = true;
                }
            }
            unset($m);
            if ($mediaChanged) {
                $pdo->prepare('UPDATE content_items SET media = ? WHERE id = ?')
                    ->execute([json_encode(array_values($item['media'])), $item['id']]);
            }
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
        if ($rawToken === '') {
            json_error('t requerido', 400);
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

        // Ping de identificación (nombre + cargo declarado una sola vez por
        // dispositivo, sin login) — no decide nada, solo deja constancia en la
        // bitácora de quién dijo ser desde ese dispositivo a partir de ahora.
        if (($input['event'] ?? '') === 'identified') {
            $reviewerName = trim((string)($input['reviewer_name'] ?? ''));
            if ($reviewerName === '') {
                json_error('reviewer_name requerido', 400);
            }
            content_review_log_activity(
                $pdo,
                (int)$batch['id'],
                null,
                'identified',
                $reviewerName,
                trim((string)($input['reviewer_role'] ?? '')),
                trim((string)($input['device_id'] ?? ''))
            );
            json_response(['ok' => true]);
            break;
        }

        $itemId = (int)($input['item_id'] ?? 0);
        $decision = $input['decision'] ?? '';
        if ($itemId <= 0) {
            json_error('item_id requerido', 400);
        }
        if (!in_array($decision, ['approved', 'changes_requested'], true)) {
            json_error('decision debe ser approved o changes_requested', 400);
        }

        $reviewerName = trim((string)($input['reviewer_name'] ?? '')) ?: null;
        $reviewerRole = trim((string)($input['reviewer_role'] ?? '')) ?: null;
        $deviceId = trim((string)($input['device_id'] ?? '')) ?: null;

        $comment = isset($input['comment']) ? trim((string)$input['comment']) : null;
        $reasonTags = $input['reason_tags'] ?? [];

        // Notas ancladas a un segundo del video (solo tiene sentido en piezas
        // de video — igual se valida acá por si el cliente manda basura) —
        // reemplazan al comentario general cuando el cliente prefirió señalar
        // momentos puntuales en vez de escribir un texto único.
        $timeNotes = [];
        if (isset($input['time_notes']) && is_array($input['time_notes'])) {
            foreach ($input['time_notes'] as $note) {
                if (!is_array($note)) continue;
                $t = $note['t'] ?? null;
                $noteText = isset($note['text']) ? trim((string)$note['text']) : '';
                if (!is_numeric($t) || $t < 0 || $noteText === '') continue;
                $timeNotes[] = ['t' => (int)round((float)$t), 'text' => mb_substr($noteText, 0, 500)];
            }
        }

        if ($decision === 'changes_requested') {
            if (($comment === null || $comment === '') && !$timeNotes) {
                json_error('Se requiere un comentario o al menos una nota en el video para pedir cambios', 400);
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
                INSERT INTO content_reviews
                    (content_item_id, decision, comment, reason_tags, time_notes, reviewer_ip, reviewer_name, reviewer_role, reviewer_device_id, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ')->execute([
                $itemId,
                $decision,
                $comment,
                $reasonTags ? json_encode($reasonTags) : null,
                $timeNotes ? json_encode($timeNotes) : null,
                $_SERVER['REMOTE_ADDR'] ?? null,
                $reviewerName,
                $reviewerRole,
                $deviceId,
                mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 400) ?: null,
            ]);
            $pdo->prepare('UPDATE content_items SET status = ?, decided_at = NOW() WHERE id = ?')
                ->execute([$decision, $itemId]);
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        content_review_log_activity(
            $pdo,
            (int)$batch['id'],
            $itemId,
            'decision',
            $reviewerName,
            $reviewerRole,
            $deviceId,
            ['decision' => $decision, 'comment_excerpt' => $comment ? mb_substr($comment, 0, 140) : null]
        );

        trello_sync_decision($pdo, $item['trello_card_id'], $decision, $comment, $reasonTags, $timeNotes);

        if ($decision === 'approved') {
            $driveResult = drive_approval_sync($pdo, $itemId, (int)$batch['client_id']);
            // Solo se avisa en Trello y se mueve a la lista de "subida a Drive"
            // si el archivo quedó efectivamente movido a la carpeta correcta
            // (verificado por drive_approval_sync) — si falló o se saltó, la
            // tarjeta se queda en "Aprobado" para que el equipo lo revise a mano.
            if (($driveResult['status'] ?? null) === 'moved') {
                trello_sync_mark_drive_uploaded($pdo, $item['trello_card_id'], $driveResult['post_label'] ?? null);
            }
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
