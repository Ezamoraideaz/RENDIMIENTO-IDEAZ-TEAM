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
//   → {meeting_id, status: 'recording'|'standby', recorder, segments_saved}
//   Todas las fechas en epoch milisegundos.
//
// Una sola grabación por reunión (migration_030): si otra extensión ya está
// grabando la misma llamada (mismo código de Meet, con señal en los últimos
// MEETINGS_RECORDER_STALE_SECONDS), esta queda en 'standby': no se guarda nada
// de lo que envía y su usuario queda como asistente (meeting_viewers). Cuando
// quien graba deja de dar señal, la siguiente extensión en espera toma el relevo
// en la misma reunión y solo se guardan sus fragmentos desde ese momento.

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$operator = require_extension_operator();
$input = json_body();
$action = $input['action'] ?? '';

// self_name / self_aliases (ping y sync): nombre configurado en la extensión y
// nombre(s) de la cuenta de Google con que Meet muestra al usuario (migration_031).
if ($action === 'ping' || $action === 'sync') {
    meetings_save_aliases(db(), $operator, $input['self_name'] ?? '', $input['self_aliases'] ?? []);
}

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

$isFinal = $endedAt !== null;
$nowUtc = gmdate('Y-m-d H:i:s');
$staleBefore = gmdate('Y-m-d H:i:s', time() - MEETINGS_RECORDER_STALE_SECONDS);
$joinAfter = gmdate('Y-m-d H:i:s', time() - MEETINGS_JOIN_WINDOW_SECONDS);

// Dos extensiones que entran a la vez a la misma llamada no deben crear dos
// reuniones: se serializa por código de Meet con un candado con nombre.
$lockName = 'ideaz_meet_' . ($code !== '' ? $code : $sessionId);
$lockStmt = $pdo->prepare('SELECT GET_LOCK(?, 10)');
$lockStmt->execute([$lockName]);
if ((int)$lockStmt->fetchColumn() !== 1) {
    json_error('Servidor ocupado, se reintentará', 503);
}

$status = 'recording';
$recorderName = null;
$saved = 0;
$pdo->beginTransaction();
try {
    $stmt = $pdo->prepare('SELECT meeting_id, operator_id, accept_from FROM meeting_sessions WHERE client_session_id = ?');
    $stmt->execute([$sessionId]);
    $session = $stmt->fetch() ?: null;

    if ($session && (int)$session['operator_id'] !== (int)$operator['id']) {
        throw new DomainException('Esta grabación pertenece a otro usuario');
    }

    $meeting = null;
    if ($session) {
        $stmt = $pdo->prepare('SELECT * FROM meetings WHERE id = ? FOR UPDATE');
        $stmt->execute([$session['meeting_id']]);
        $meeting = $stmt->fetch() ?: null;
    } elseif ($code !== '') {
        // ¿Alguien ya está grabando (o grabó hace poco) esta misma llamada?
        // Los códigos de Meet se reutilizan en reuniones recurrentes: por eso
        // solo cuenta una reunión con señal reciente.
        $stmt = $pdo->prepare('
            SELECT * FROM meetings
            WHERE meeting_code = ? AND active_seen_at >= ?
            ORDER BY active_seen_at DESC LIMIT 1 FOR UPDATE
        ');
        $stmt->execute([$code, $joinAfter]);
        $meeting = $stmt->fetch() ?: null;
    }

    $acceptFrom = $session['accept_from'] ?? null;

    if (!$meeting) {
        // Primera extensión en la llamada: graba.
        $pdo->prepare('
            INSERT INTO meetings (client_session_id, operator_id, meeting_code, title, started_at, last_activity_at, ended_at,
                                  caption_language, active_session_id, active_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ')->execute([$sessionId, $operator['id'], $code, $title, $startedAt, $lastActivity, $endedAt,
                     $language, $isFinal ? null : $sessionId, $nowUtc]);
        $meetingId = (int)$pdo->lastInsertId();
        $pdo->prepare('INSERT INTO meeting_sessions (client_session_id, meeting_id, operator_id) VALUES (?, ?, ?)')
            ->execute([$sessionId, $meetingId, $operator['id']]);
    } else {
        $meetingId = (int)$meeting['id'];
        if (!$session) {
            $pdo->prepare('INSERT INTO meeting_sessions (client_session_id, meeting_id, operator_id) VALUES (?, ?, ?)')
                ->execute([$sessionId, $meetingId, $operator['id']]);
        }
        if ((int)$meeting['operator_id'] !== (int)$operator['id']) {
            $pdo->prepare('INSERT IGNORE INTO meeting_viewers (meeting_id, operator_id) VALUES (?, ?)')
                ->execute([$meetingId, $operator['id']]);
        }

        $isActive = $meeting['active_session_id'] === $sessionId;
        $otherAlive = !$isActive
            && $meeting['active_session_id'] !== null
            && (string)$meeting['active_seen_at'] >= $staleBefore;

        if ($otherAlive) {
            $status = 'standby';
            $stmt = $pdo->prepare('
                SELECT o.name, o.email FROM meeting_sessions s JOIN operators o ON o.id = s.operator_id
                WHERE s.client_session_id = ?
            ');
            $stmt->execute([$meeting['active_session_id']]);
            $rec = $stmt->fetch();
            $recorderName = $rec ? ($rec['name'] ?: $rec['email']) : null;
        } elseif (!$isActive) {
            // Relevo: quien grababa salió o dejó de dar señal. Lo anterior a su
            // última señal ya está guardado; de esta extensión solo se toma lo nuevo.
            if ($meeting['active_seen_at'] !== null) {
                $acceptFrom = $meeting['active_seen_at'] . '.000';
                $pdo->prepare('UPDATE meeting_sessions SET accept_from = ? WHERE client_session_id = ?')
                    ->execute([$acceptFrom, $sessionId]);
            }
        }

        if ($status === 'recording') {
            // El título solo se completa si estaba vacío: si el usuario lo editó en el
            // dashboard, la extensión no lo pisa.
            $pdo->prepare('
                UPDATE meetings
                   SET title = IF(title = \'\', ?, title),
                       meeting_code = IF(meeting_code = \'\', ?, meeting_code),
                       caption_language = IF(? <> \'\', ?, caption_language),
                       last_activity_at = GREATEST(COALESCE(last_activity_at, ?), ?),
                       ended_at = ?,
                       active_session_id = ?,
                       active_seen_at = ?
                 WHERE id = ?
            ')->execute([$title, $code, $language, $language, $lastActivity, $lastActivity, $endedAt,
                         $isFinal ? null : $sessionId, $nowUtc, $meetingId]);
        }
    }

    if ($status === 'standby') {
        // En espera no se guarda nada de lo que envía esta extensión
        $segments = [];
        $participants = [];
    }

    $segStmt = $pdo->prepare('
        INSERT INTO meeting_segments (meeting_id, client_segment_id, speaker, text, started_at, ended_at, word_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE speaker = VALUES(speaker), text = VALUES(text),
            ended_at = GREATEST(ended_at, VALUES(ended_at)), word_count = VALUES(word_count)
    ');
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
        if ($acceptFrom !== null && $segStart < $acceptFrom) {
            continue; // ya lo guardó quien grababa antes del relevo
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
    $pdo->prepare('SELECT RELEASE_LOCK(?)')->execute([$lockName]);
    if ($e instanceof DomainException) {
        json_error($e->getMessage(), 403);
    }
    error_log('meeting_ingest: ' . $e->getMessage());
    json_error('No se pudo guardar la transcripción', 500);
}
$pdo->prepare('SELECT RELEASE_LOCK(?)')->execute([$lockName]);

json_response([
    'meeting_id'     => $meetingId,
    'status'         => $status,
    'recorder'       => $status === 'standby' ? $recorderName : $operator['name'],
    'segments_saved' => $saved,
]);
