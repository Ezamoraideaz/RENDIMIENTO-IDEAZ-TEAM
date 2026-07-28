<?php
declare(strict_types=1);

require_once __DIR__ . '/google_drive.php';

// Se llama desde backend/public/review.php cuando el cliente aprueba una
// pieza. Mueve el/los archivo(s) de "Para aprobación" (carpeta externa por
// marca, clients.drive_approval_folder_id) hacia ARTES/año/mes/POST #
// (carpeta por tablero, project_settings.drive_folder_id) — antes esto lo
// hacía el diseñador a mano.
//
// Best-effort: si algo falla (carpetas no configuradas o no compartidas con
// la cuenta de servicio, post_number ausente, etc.) NUNCA debe bloquear la
// aprobación del cliente — el portal público ya guardó la decisión antes de
// llamar esta función. El resultado queda en content_items.drive_move_status/
// drive_move_error para que el equipo lo revise si algo no se movió solo.
function drive_approval_sync(PDO $pdo, int $itemId, int $clientId): void
{
    $mark = function (string $status, ?string $error = null) use ($pdo, $itemId): void {
        $pdo->prepare('UPDATE content_items SET drive_move_status = ?, drive_move_error = ? WHERE id = ?')
            ->execute([$status, $error, $itemId]);
    };

    $stmt = $pdo->prepare('SELECT post_number, scheduled_at, media FROM content_items WHERE id = ?');
    $stmt->execute([$itemId]);
    $item = $stmt->fetch();
    if (!$item) {
        return;
    }
    if (!$item['post_number'] || !$item['scheduled_at']) {
        $mark('skipped', 'Sin número de post o fecha programada — no se puede ubicar la carpeta destino en ARTES');
        return;
    }

    $stmt = $pdo->prepare('
        SELECT c.drive_approval_folder_id, ps.drive_folder_id AS artes_folder_id
        FROM clients c
        LEFT JOIN project_settings ps ON ps.board_id = c.trello_board_id
        WHERE c.id = ?
    ');
    $stmt->execute([$clientId]);
    $folders = $stmt->fetch();
    if (!$folders || !$folders['drive_approval_folder_id'] || !$folders['artes_folder_id']) {
        $mark('skipped', 'Falta configurar la carpeta "Para aprobación" del cliente o la carpeta ARTES del tablero vinculado');
        return;
    }

    try {
        $date = new DateTime((string)$item['scheduled_at']);
    } catch (Exception $e) {
        $mark('error', 'scheduled_at inválido: ' . $item['scheduled_at']);
        return;
    }
    $year = (int)$date->format('Y');
    $monthIdx = (int)$date->format('n') - 1;

    $destFolderId = google_drive_find_or_create_post_folder((string)$folders['artes_folder_id'], $year, $monthIdx, (int)$item['post_number']);
    if (!$destFolderId) {
        $mark('error', google_drive_last_error() ?: 'No se pudo ubicar/crear la carpeta destino en ARTES');
        return;
    }

    $media = json_decode((string)$item['media'], true) ?: [];
    $moved = 0;
    $errors = [];
    foreach ($media as $m) {
        $url = (string)($m['url'] ?? '');
        $fileId = google_drive_extract_file_id($url);
        if (!$fileId) {
            $errors[] = "No se pudo identificar el archivo de Drive en: {$url}";
            continue;
        }
        if (google_drive_move_file($fileId, $destFolderId)) {
            $moved++;
        } else {
            $errors[] = google_drive_last_error() ?: "Fallo moviendo el archivo {$fileId}";
        }
    }

    if ($moved === 0 && $errors) {
        $mark('error', implode(' · ', $errors));
    } elseif ($errors) {
        $mark('error', "Se movieron {$moved} de " . count($media) . ' archivo(s). Fallos: ' . implode(' · ', $errors));
    } else {
        $mark('moved', null);
    }
}
