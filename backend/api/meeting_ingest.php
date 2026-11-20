<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/meetings.php';

// Endpoint de la extensión de Chrome "IDEAZ Reuniones" (carpeta chrome-extension/).
// No usa la cookie de sesión del dashboard: se autentica con la llave personal
// (encabezado X-Ideaz-Token) que cada usuario genera en reuniones.html.
//
// POST JSON {action: 'ping'}
//   → {operator: {name, email}}  — la extensión valida la llave y conoce el nombre del usuario
// POST JSON {action: 'sync', client_session_id, meeting_code, title, started_at, last_activity_at,
//            ended_at?, language?, segments: [{id, speaker, text, started_at, ended_at}], participants: [nombre]}
//   → {meeting_id}  — crea la reunión la primera vez y luego actualiza (upsert por client_session_id).
//   Todas las fechas en epoch milisegundos.

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$operator = require_extension_operator();
$input = json_body();
$action = $input['action'] ?? '';

if ($action === 'ping') {
    json_response(['operator' => ['name' => $operator['name'], 'email' => $operator['email']]]);
}

if ($action !== 'sync') {
    json_error('Acción inválida', 400);
}

$pdo = db();

$sessionId = (string)($input['client_session_id'] ?? '');
if (!preg_match('/^[A-Za-z0-9_-]{8,64}$/', $sessionId)) {
    json_error('client_session_id inválido', 400);
}
$code = substr(preg_replace('/[^a-z0-9-]/', '', strtolower((string)($input['meeting_code'] ?? ''))) ?? '', 0, 32);
$title = mb_substr(trim((string)($input['title'] ?? '')), 0, 255);
$language = substr(preg_replace('/[^A-Za-z-]/', '', (string)($input['language'] ?? '')) ?? '', 0, 16);
$startedAt = meetings_ms_to_utc($input['started_at'] ?? null, false);
if ($startedAt === null) {
    json_error('started_at inválido', 400);
}
$lastActivity = meetings_ms_to_utc($input['last_activity_at'] ?? null, false) ?? $startedAt;
$endedAt = isset($input['ended_at']) ? meetings_ms_to_utc($input['ended_at'], false) : null;

$segments = is_array($input['segments'] ?? null) ? array_slice($input['segments'], 0, 500) : [];
$participants = is_array($input['participants'] ?? null) ? array_slice($input['participants'], 0, 200) : [];

$pdo->beginTransaction();
try {
    $stmt = $pdo->prepare('SELECT id, operator_id FROM meetings WHERE client_session_id = ? FOR UPDATE');
    $stmt->execute([$sessionId]);
    $meeting = $stmt->fetch();

    if ($meeting && (int)$meeting['operator_id'] !== (int)$operator['id']) {
        $pdo->rollBack();
        json_error('Esta grabación pertenece a otro usuario', 403);
    }

    if (!$meeting) {
        $pdo->prepare('
            INSERT INTO meetings (client_session_id, operator_id, meeting_code, title, started_at, last_activity_at, ended_at, caption_language)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ')->execute([$sessionId, $operator['id'], $code, $title, $startedAt, $lastActivity, $endedAt, $language]);
        $meetingId = (int)$pdo->lastInsertId();
    } else {
        $meetingId = (int)$meeting['id'];
        // El título solo se completa si estaba vacío: si el usuario lo editó en el
        // dashboard, la extensión no lo pisa.
        $pdo->prepare('
            UPDATE meetings
               SET title = IF(title = \'\', ?, title),
                   meeting_code = IF(meeting_code = \'\', ?, meeting_code),
                   caption_language = IF(? <> \'\', ?, caption_language),
                   last_activity_at = GREATEST(COALESCE(last_activity_at, ?), ?),
                   ended_at = ?
             WHERE id = ?
        ')->execute([$title, $code, $language, $language, $lastActivity, $lastActivity, $endedAt, $meetingId]);
    }

    $segStmt = $pdo->prepare('
        INSERT INTO meeting_segments (meeting_id, client_segment_id, speaker, text, started_at, ended_at, word_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE speaker = VALUES(speaker), text = VALUES(text),
            ended_at = GREATEST(ended_at, VALUES(ended_at)), word_count = VALUES(word_count)
    ');
    $saved = 0;
    foreach ($segments as $seg) {
        if (!is_array($seg)) {
            continue;
        }
        $segId = (string)($seg['id'] ?? '');
        $text = trim((string)($seg['text'] ?? ''));
        $segStart = meetings_ms_to_utc($seg['started_at'] ?? null);
        $segEnd = meetings_ms_to_utc($seg['ended_at'] ?? null) ?? $segStart;
        if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $segId) || $text === '' || $segStart === null) {
            continue;
        }
        $text = mb_substr($text, 0, 20000);
        $speaker = meetings_clean_name((string)($seg['speaker'] ?? ''));
        $segStmt->execute([$meetingId, $segId, $speaker, $text, $segStart, $segEnd, meetings_word_count($text)]);
        $saved++;
    }

    $partStmt = $pdo->prepare('
        INSERT INTO meeting_participants (meeting_id, name, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE last_seen_at = GREATEST(last_seen_at, VALUES(last_seen_at))
    ');
    foreach ($participants as $name) {
        $name = meetings_clean_name(is_string($name) ? $name : '');
        if ($name === '' || in_array(mb_strtolower($name), MEETINGS_SELF_LABELS, true)) {
            continue;
        }
        $partStmt->execute([$meetingId, $name, $lastActivity, $lastActivity]);
    }

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('meeting_ingest: ' . $e->getMessage());
    json_error('No se pudo guardar la transcripción', 500);
}

json_response(['meeting_id' => $meetingId, 'segments_saved' => $saved]);
