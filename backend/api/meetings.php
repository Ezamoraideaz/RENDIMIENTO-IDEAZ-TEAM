<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/meetings.php';

// Módulo Reuniones (reuniones.html). superadmin/admin ven todas las grabaciones;
// el resto de roles con acceso ve solo las que grabó con su extensión.
//
// GET                         → listado (filtros: date_from, date_to [días de Bogotá], q, operator_id)
// GET ?id=N                   → detalle: reunión + transcripción + participación
// GET ?operators=1            → (admin) usuarios que han grabado, para el filtro
// PUT {id, title?, notes?}    → editar
// DELETE ?id=N                → eliminar

$operator = require_meetings_access();
$pdo = db();
$isAdmin = meetings_is_admin($operator);

function meetings_load_owned(PDO $pdo, int $id, array $operator, bool $isAdmin): array
{
    $stmt = $pdo->prepare('
        SELECT m.*, o.name AS operator_name, o.email AS operator_email
        FROM meetings m LEFT JOIN operators o ON o.id = m.operator_id
        WHERE m.id = ?
    ');
    $stmt->execute([$id]);
    $meeting = $stmt->fetch();
    if (!$meeting) {
        json_error('Reunión no encontrada', 404);
    }
    if (!$isAdmin && (int)$meeting['operator_id'] !== (int)$operator['id']) {
        json_error('No tienes acceso a esta reunión', 403);
    }
    return $meeting;
}

// Sin hora de fin y con actividad en los últimos 3 minutos = la llamada sigue en curso.
// (Si se cerró la pestaña sin avisar, deja de figurar en vivo sola.)
function meetings_is_live(array $m): bool
{
    return $m['ended_at'] === null
        && meetings_utc_seconds((string)($m['last_activity_at'] ?: $m['started_at'])) > time() - 180;
}

function meetings_effective_end(array $m): string
{
    return $m['ended_at'] ?: ($m['last_activity_at'] ?: $m['started_at']);
}

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        if (($_GET['operators'] ?? '') === '1') {
            if (!$isAdmin) {
                json_response(['operators' => []]);
            }
            $rows = $pdo->query('
                SELECT DISTINCT o.id, o.name, o.email
                FROM meetings m JOIN operators o ON o.id = m.operator_id
                ORDER BY o.name
            ')->fetchAll();
            json_response(['operators' => $rows]);
        }

        if (isset($_GET['id'])) {
            $meeting = meetings_load_owned($pdo, (int)$_GET['id'], $operator, $isAdmin);
            $segStmt = $pdo->prepare('
                SELECT id, speaker, text, started_at, ended_at, word_count
                FROM meeting_segments WHERE meeting_id = ? ORDER BY started_at ASC, id ASC
            ');
            $segStmt->execute([$meeting['id']]);
            $segments = $segStmt->fetchAll();

            $partStmt = $pdo->prepare('SELECT name FROM meeting_participants WHERE meeting_id = ? ORDER BY first_seen_at');
            $partStmt->execute([$meeting['id']]);
            $participantNames = array_column($partStmt->fetchAll(), 'name');

            $end = meetings_effective_end($meeting);
            json_response([
                'meeting' => [
                    'id'               => (int)$meeting['id'],
                    'title'            => $meeting['title'],
                    'notes'            => $meeting['notes'],
                    'meeting_code'     => $meeting['meeting_code'],
                    'caption_language' => $meeting['caption_language'],
                    'started_at'       => meetings_iso($meeting['started_at']),
                    'ended_at'         => meetings_iso($end),
                    'is_live'          => meetings_is_live($meeting),
                    'duration_seconds' => max(0, (int)round(meetings_utc_seconds($end) - meetings_utc_seconds($meeting['started_at']))),
                    'operator_id'      => (int)$meeting['operator_id'],
                    'operator_name'    => $meeting['operator_name'] ?: $meeting['operator_email'],
                    'can_edit'         => $isAdmin || (int)$meeting['operator_id'] === (int)$operator['id'],
                ],
                'segments' => array_map(fn($s) => [
                    'id'         => (int)$s['id'],
                    'speaker'    => $s['speaker'] !== '' ? $s['speaker'] : 'Sin identificar',
                    'text'       => $s['text'],
                    'started_at' => meetings_iso($s['started_at']),
                    'ended_at'   => meetings_iso($s['ended_at']),
                ], $segments),
                'participation' => meetings_participation($segments, $participantNames),
            ]);
        }

        // ── Listado ──
        $where = [];
        $params = [];
        if (!$isAdmin) {
            $where[] = 'm.operator_id = ?';
            $params[] = $operator['id'];
        } elseif ((int)($_GET['operator_id'] ?? 0) > 0) {
            $where[] = 'm.operator_id = ?';
            $params[] = (int)$_GET['operator_id'];
        }
        if ($from = meetings_bogota_day_to_utc((string)($_GET['date_from'] ?? ''), false)) {
            $where[] = 'm.started_at >= ?';
            $params[] = $from;
        }
        if ($to = meetings_bogota_day_to_utc((string)($_GET['date_to'] ?? ''), true)) {
            $where[] = 'm.started_at <= ?';
            $params[] = $to;
        }
        $q = trim((string)($_GET['q'] ?? ''));
        if ($q !== '') {
            $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_substr($q, 0, 100)) . '%';
            $where[] = '(m.title LIKE ? OR m.meeting_code LIKE ?
                OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.name LIKE ?)
                OR EXISTS (SELECT 1 FROM meeting_segments s WHERE s.meeting_id = m.id AND (s.speaker LIKE ? OR s.text LIKE ?)))';
            array_push($params, $like, $like, $like, $like, $like);
        }
        $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';

        $stmt = $pdo->prepare("
            SELECT m.id, m.title, m.meeting_code, m.started_at, m.ended_at, m.last_activity_at, m.operator_id,
                   o.name AS operator_name, o.email AS operator_email,
                   (SELECT COUNT(*) FROM meeting_segments s WHERE s.meeting_id = m.id) AS segment_count,
                   (SELECT COALESCE(SUM(s.word_count), 0) FROM meeting_segments s WHERE s.meeting_id = m.id) AS word_count
            FROM meetings m LEFT JOIN operators o ON o.id = m.operator_id
            {$whereSql}
            ORDER BY m.started_at DESC
            LIMIT 500
        ");
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        // Participación resumida por reunión (para mostrar quién habló más en el listado)
        $speakersBy = [];
        if ($rows) {
            $ids = array_column($rows, 'id');
            $in = implode(',', array_fill(0, count($ids), '?'));
            $segStmt = $pdo->prepare("SELECT meeting_id, speaker, started_at, ended_at, word_count FROM meeting_segments WHERE meeting_id IN ($in)");
            $segStmt->execute($ids);
            $segsBy = [];
            foreach ($segStmt->fetchAll() as $s) {
                $segsBy[$s['meeting_id']][] = $s;
            }
            $partStmt = $pdo->prepare("SELECT meeting_id, name FROM meeting_participants WHERE meeting_id IN ($in)");
            $partStmt->execute($ids);
            $partsBy = [];
            foreach ($partStmt->fetchAll() as $p) {
                $partsBy[$p['meeting_id']][] = $p['name'];
            }
            foreach ($ids as $id) {
                $speakersBy[$id] = meetings_participation($segsBy[$id] ?? [], $partsBy[$id] ?? []);
            }
        }

        $meetings = array_map(function ($m) use ($speakersBy, $operator, $isAdmin) {
            $end = meetings_effective_end($m);
            $participation = $speakersBy[$m['id']] ?? [];
            return [
                'id'               => (int)$m['id'],
                'title'            => $m['title'],
                'meeting_code'     => $m['meeting_code'],
                'started_at'       => meetings_iso($m['started_at']),
                'ended_at'         => meetings_iso($end),
                'is_live'          => meetings_is_live($m),
                'duration_seconds' => max(0, (int)round(meetings_utc_seconds($end) - meetings_utc_seconds($m['started_at']))),
                'operator_id'      => (int)$m['operator_id'],
                'operator_name'    => $m['operator_name'] ?: $m['operator_email'],
                'segment_count'    => (int)$m['segment_count'],
                'word_count'       => (int)$m['word_count'],
                'participants'     => array_map(fn($p) => ['name' => $p['name'], 'percent' => $p['percent']], $participation),
                'can_edit'         => $isAdmin || (int)$m['operator_id'] === (int)$operator['id'],
            ];
        }, $rows);

        json_response(['meetings' => $meetings, 'is_admin' => $isAdmin]);
        break;

    case 'PUT':
        $operator = require_state_changing_request();
        $input = json_body();
        $meeting = meetings_load_owned($pdo, (int)($input['id'] ?? 0), $operator, $isAdmin);
        $fields = [];
        $values = [];
        if (array_key_exists('title', $input)) {
            $fields[] = 'title = ?';
            $values[] = mb_substr(trim((string)$input['title']), 0, 255);
        }
        if (array_key_exists('notes', $input)) {
            $fields[] = 'notes = ?';
            $notes = trim((string)$input['notes']);
            $values[] = $notes !== '' ? mb_substr($notes, 0, 20000) : null;
        }
        if (!empty($input['mark_ended']) && $meeting['ended_at'] === null) {
            $fields[] = 'ended_at = COALESCE(last_activity_at, started_at)';
        }
        if (!$fields) {
            json_error('Nada para actualizar', 400);
        }
        $values[] = $meeting['id'];
        $pdo->prepare('UPDATE meetings SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($values);
        json_response(['ok' => true]);
        break;

    case 'DELETE':
        $operator = require_state_changing_request();
        $meeting = meetings_load_owned($pdo, (int)($_GET['id'] ?? 0), $operator, $isAdmin);
        $pdo->prepare('DELETE FROM meetings WHERE id = ?')->execute([$meeting['id']]);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
