<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/meetings.php';

// Llaves personales de la extensión de Chrome (Reuniones → Conectar extensión).
// Cada usuario gestiona solo las suyas. La llave en claro se muestra UNA vez al crearla.
//
// GET                 → mis llaves (sin el valor)
// POST {label}        → crea una llave y la devuelve
// DELETE ?id=N        → revoca

$operator = require_meetings_access();
$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $stmt = $pdo->prepare('
            SELECT id, label, token_hint, last_used_at, created_at
            FROM meeting_extension_tokens
            WHERE operator_id = ? AND revoked_at IS NULL
            ORDER BY id DESC
        ');
        $stmt->execute([$operator['id']]);
        $rows = array_map(fn($r) => [
            'id'           => (int)$r['id'],
            'label'        => $r['label'],
            'token_hint'   => $r['token_hint'],
            'last_used_at' => meetings_iso($r['last_used_at']),
            'created_at'   => $r['created_at'],
        ], $stmt->fetchAll());
        json_response(['tokens' => $rows]);
        break;

    case 'POST':
        $operator = require_state_changing_request();
        $input = json_body();
        $label = mb_substr(trim((string)($input['label'] ?? '')), 0, 120) ?: 'Chrome';

        $count = $pdo->prepare('SELECT COUNT(*) FROM meeting_extension_tokens WHERE operator_id = ? AND revoked_at IS NULL');
        $count->execute([$operator['id']]);
        if ((int)$count->fetchColumn() >= 10) {
            json_error('Tienes demasiadas llaves activas. Revoca alguna antes de crear otra.', 400);
        }

        $token = 'idz_' . bin2hex(random_bytes(24));
        $pdo->prepare('
            INSERT INTO meeting_extension_tokens (operator_id, label, token_hash, token_hint)
            VALUES (?, ?, ?, ?)
        ')->execute([$operator['id'], $label, meetings_hash_token($token), substr($token, -6)]);
        json_response(['id' => (int)$pdo->lastInsertId(), 'token' => $token], 201);
        break;

    case 'DELETE':
        $operator = require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        $pdo->prepare('UPDATE meeting_extension_tokens SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND operator_id = ? AND revoked_at IS NULL')
            ->execute([$id, $operator['id']]);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
