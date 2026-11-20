<?php
declare(strict_types=1);

// Sync del portal de aprobación hacia Trello: al decidir una pieza (aprobar o
// pedir cambios), mueve la tarjeta de origen a la lista correspondiente y
// comenta mencionando a quienes ya están asignados a esa tarjeta — es el
// mecanismo de aviso del módulo, no hay badge/sonido aparte (ver PRD §8).
//
// Reutiliza las credenciales de Trello (un solo juego, cifrado en app_settings)
// que ya usa el resto del dashboard — no requiere configuración nueva.
//
// Resuelve la lista destino por NOMBRE ("Aprobado" / "Cambios", sin distinguir
// mayúsculas/minúsculas ni espacios extra), igual que ya hace js/timeCalc.js
// para reconocer los estados del protocolo en cualquier tablero — no se
// guarda un mapeo de IDs de lista por proyecto.
//
// Por regla de negocio (PRD §10): si Trello no responde, la decisión del
// cliente ya quedó guardada en content_reviews antes de llamar aquí — este
// sync es "mejor esfuerzo" y nunca debe tirar una excepción hacia afuera.

const TRELLO_SYNC_TARGET_LIST = [
    'approved'          => 'Aprobado',
    'changes_requested' => 'Cambios',
];

function trello_sync_credentials(PDO $pdo): ?array
{
    $stmt = $pdo->prepare("SELECT setting_key, value_encrypted, iv FROM app_settings WHERE setting_key IN ('trello_key','trello_token')");
    $stmt->execute();
    $creds = [];
    foreach ($stmt->fetchAll() as $row) {
        try {
            $creds[$row['setting_key']] = decrypt_token($row['value_encrypted'], $row['iv']);
        } catch (RuntimeException $e) {
            return null;
        }
    }
    if (empty($creds['trello_key']) || empty($creds['trello_token'])) {
        return null;
    }
    return ['key' => $creds['trello_key'], 'token' => $creds['trello_token']];
}

function trello_sync_request(string $method, string $path, array $creds, array $query = [], ?array $body = null): array
{
    $query['key'] = $creds['key'];
    $query['token'] = $creds['token'];
    $url = 'https://api.trello.com/1' . $path . '?' . http_build_query($query);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    $raw = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($raw === false || $err) {
        throw new RuntimeException("Trello request failed: {$err}");
    }
    if ($status < 200 || $status >= 300) {
        throw new RuntimeException("Trello {$status}: {$raw}");
    }
    $decoded = json_decode((string)$raw, true);
    return is_array($decoded) ? $decoded : [];
}

// Aplica la decisión del cliente sobre una tarjeta de Trello: mueve la lista y
// comenta mencionando a los miembros ya asignados. No lanza excepciones — cualquier
// falla (credenciales ausentes, tarjeta borrada, lista sin ese nombre, Trello caído)
// se registra en error_log y se ignora, para no perder la decisión ya guardada.
function trello_sync_decision(PDO $pdo, ?string $cardId, string $decision, ?string $comment, array $reasonTags = [], array $timeNotes = []): void
{
    if (!$cardId) {
        return;
    }
    try {
        $creds = trello_sync_credentials($pdo);
        if ($creds === null) {
            return;
        }

        $card = trello_sync_request('GET', "/cards/{$cardId}", $creds, [
            'fields'        => 'idBoard,name',
            'members'       => 'true',
            'member_fields' => 'username',
        ]);
        $boardId = $card['idBoard'] ?? null;
        if (!$boardId) {
            return;
        }

        $mentions = array_filter(array_map(
            static fn($m) => isset($m['username']) ? '@' . $m['username'] : null,
            $card['members'] ?? []
        ));

        $targetListName = TRELLO_SYNC_TARGET_LIST[$decision] ?? null;
        if ($targetListName !== null) {
            $lists = trello_sync_request('GET', "/boards/{$boardId}/lists", $creds, ['fields' => 'id,name']);
            $targetList = null;
            $targetListNorm = mb_strtolower(trim($targetListName));
            foreach ($lists as $list) {
                if (mb_strtolower(trim((string)($list['name'] ?? ''))) === $targetListNorm) {
                    $targetList = $list;
                    break;
                }
            }
            if ($targetList !== null) {
                trello_sync_request('PUT', "/cards/{$cardId}", $creds, [], ['idList' => $targetList['id']]);
            }
        }

        $text = trello_sync_comment_text($decision, $comment, $reasonTags, $mentions, $timeNotes);
        trello_sync_request('POST', "/cards/{$cardId}/actions/comments", $creds, [], ['text' => $text]);
    } catch (Throwable $e) {
        error_log('[trello_sync] ' . $e->getMessage());
    }
}

// Segunda confirmación en Trello, que se llama solo cuando drive_approval_sync()
// ya verificó que el archivo terminó movido con éxito a la carpeta ARTES/año/
// mes/POST #N: mueve la tarjeta a la lista de "subida a Drive" — buscada por
// la palabra "drive" en el nombre (sin importar mayúsculas ni cómo la haya
// escrito cada tablero: "Subido a Drive", "Montado a Drive", "Montado en
// Drive", etc.) — y deja un comentario confirmando en qué carpeta quedó.
// Mismo criterio best-effort que trello_sync_decision(): nunca lanza excepción.
function trello_sync_mark_drive_uploaded(PDO $pdo, ?string $cardId, ?string $postLabel): void
{
    if (!$cardId) {
        return;
    }
    try {
        $creds = trello_sync_credentials($pdo);
        if ($creds === null) {
            return;
        }

        $card = trello_sync_request('GET', "/cards/{$cardId}", $creds, ['fields' => 'idBoard']);
        $boardId = $card['idBoard'] ?? null;
        if (!$boardId) {
            return;
        }

        $lists = trello_sync_request('GET', "/boards/{$boardId}/lists", $creds, ['fields' => 'id,name']);
        $targetList = null;
        foreach ($lists as $list) {
            if (mb_stripos((string)($list['name'] ?? ''), 'drive') !== false) {
                $targetList = $list;
                break;
            }
        }
        if ($targetList !== null) {
            trello_sync_request('PUT', "/cards/{$cardId}", $creds, [], ['idList' => $targetList['id']]);
        }

        $label = $postLabel ? " en {$postLabel}" : '';
        trello_sync_request('POST', "/cards/{$cardId}/actions/comments", $creds, [], [
            'text' => "📁 Contenido subido correctamente a Drive{$label}.",
        ]);
    } catch (Throwable $e) {
        error_log('[trello_sync] ' . $e->getMessage());
    }
}

function trello_sync_format_seconds(int $seconds): string
{
    $m = intdiv($seconds, 60);
    $s = $seconds % 60;
    return sprintf('%d:%02d', $m, $s);
}

// $timeNotes: [{"t": 4, "text": "..."}, ...] — notas que el cliente dejó
// ancladas a un segundo puntual del video (portal de revisión), en vez de
// (o además de) el comentario general.
function trello_sync_time_notes_block(array $timeNotes): string
{
    if (!$timeNotes) {
        return '';
    }
    usort($timeNotes, static fn($a, $b) => ($a['t'] ?? 0) <=> ($b['t'] ?? 0));
    $lines = array_map(
        static fn($n) => trello_sync_format_seconds((int)($n['t'] ?? 0)) . ' — ' . ($n['text'] ?? ''),
        $timeNotes
    );
    return "\nNotas por momento del video:\n" . implode("\n", $lines);
}

function trello_sync_comment_text(string $decision, ?string $comment, array $reasonTags, array $mentions, array $timeNotes = []): string
{
    $mentionLine = $mentions ? implode(' ', $mentions) . "\n\n" : '';

    if ($decision === 'approved') {
        $text = $mentionLine . '✅ Aprobado por el cliente vía portal de revisión.';
        return $text . trello_sync_time_notes_block($timeNotes);
    }

    $tagsLine = $reasonTags ? implode(', ', $reasonTags) . "\n" : '';
    $commentLine = $comment ? '"' . $comment . '"' : '';
    return $mentionLine . "🔁 El cliente solicitó cambios.\n" . $tagsLine . $commentLine . trello_sync_time_notes_block($timeNotes);
}
