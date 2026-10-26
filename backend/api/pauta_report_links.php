<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Links privados del reporte de pauta para el cliente final. Solo superadmin/admin
// (mismos roles que gestionan los clientes de pauta). El portal público valida por token_hash;
// además se guarda el token cifrado (migration_024) para poder volver a copiar/reenviar el link.
// Lo consume backend/public/pauta_report_public.php.

$operator = require_login();
if (!in_array($operator['role'], ['superadmin', 'admin'], true)) {
    json_error('No autorizado', 403);
}
$pdo = db();

function pauta_report_valid_date($d): bool
{
    return is_string($d) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) === 1
        && checkdate((int)substr($d, 5, 2), (int)substr($d, 8, 2), (int)substr($d, 0, 4));
}

try {
    switch ($_SERVER['REQUEST_METHOD']) {
        case 'GET':
            $clientId = trim((string)($_GET['client_id'] ?? ''));
            if ($clientId === '') {
                json_error('client_id requerido', 400);
            }
            $cols = 'id, mode, date_from, date_to, title, message, lead_goal, created_at';
            try {
                $stmt = $pdo->prepare("SELECT {$cols}, token_encrypted, token_iv FROM pauta_report_links WHERE pauta_client_id = ? ORDER BY created_at DESC");
                $stmt->execute([$clientId]);
            } catch (PDOException $e) {
                // migration_024 aún no corrida: se listan sin token (no se pueden volver a copiar)
                $stmt = $pdo->prepare("SELECT {$cols} FROM pauta_report_links WHERE pauta_client_id = ? ORDER BY created_at DESC");
                $stmt->execute([$clientId]);
            }
            $links = [];
            foreach ($stmt->fetchAll() as $row) {
                $token = null;
                if (!empty($row['token_encrypted']) && !empty($row['token_iv'])) {
                    try { $token = decrypt_token($row['token_encrypted'], $row['token_iv']); } catch (Throwable $e) { $token = null; }
                }
                unset($row['token_encrypted'], $row['token_iv']);
                $row['id']        = (int)$row['id'];
                $row['lead_goal'] = $row['lead_goal'] !== null ? (int)$row['lead_goal'] : null;
                $row['token']     = $token;
                $links[] = $row;
            }
            json_response(['links' => $links]);
            break;

        case 'POST':
            $operator = require_state_changing_request();
            $input  = json_body();
            $action = $input['action'] ?? '';

            if ($action === 'create') {
                $clientId = trim((string)($input['client_id'] ?? ''));
                $mode     = ($input['mode'] ?? '') === 'range' ? 'range' : 'live';
                $title    = mb_substr(trim((string)($input['title'] ?? '')), 0, 190);
                $message  = mb_substr(trim((string)($input['message'] ?? '')), 0, 1000);
                $goal     = max(0, (int)($input['lead_goal'] ?? 0));
                $from     = $input['date_from'] ?? null;
                $to       = $input['date_to'] ?? null;

                if ($clientId === '') {
                    json_error('client_id requerido', 400);
                }
                $exists = $pdo->prepare('SELECT 1 FROM pauta_clients WHERE id = ?');
                $exists->execute([$clientId]);
                if (!$exists->fetchColumn()) {
                    json_error('Cliente de pauta no encontrado', 404);
                }
                if ($mode === 'range') {
                    if (!pauta_report_valid_date($from) || !pauta_report_valid_date($to) || $from > $to) {
                        json_error('Para un reporte por rango indica fechas válidas (desde ≤ hasta)', 400);
                    }
                } else {
                    $from = $to = null;
                }

                $rawToken = bin2hex(random_bytes(32));
                $params = [$clientId, hash('sha256', $rawToken), $mode, $from, $to, $title, $message !== '' ? $message : null, $goal > 0 ? $goal : null, $operator['id']];
                try {
                    $enc = encrypt_token($rawToken);
                    $pdo->prepare('INSERT INTO pauta_report_links (pauta_client_id, token_hash, mode, date_from, date_to, title, message, lead_goal, created_by, token_encrypted, token_iv)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                        ->execute(array_merge($params, [$enc['ciphertext'], $enc['iv']]));
                } catch (Throwable $e) {
                    // Sin migration_024 (o sin ENCRYPTION_KEY válida): el link funciona igual, solo que no se podrá volver a copiar.
                    $pdo->prepare('INSERT INTO pauta_report_links (pauta_client_id, token_hash, mode, date_from, date_to, title, message, lead_goal, created_by)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                        ->execute($params);
                }
                json_response(['token' => $rawToken, 'id' => (int)$pdo->lastInsertId()]);
                break;
            }

            if ($action === 'revoke') {
                $id = (int)($input['id'] ?? 0);
                if ($id <= 0) {
                    json_error('id requerido', 400);
                }
                $pdo->prepare('DELETE FROM pauta_report_links WHERE id = ?')->execute([$id]);
                json_response(['ok' => true]);
                break;
            }

            json_error('action inválida', 400);
            break;

        default:
            json_error('Método no permitido', 405);
    }
} catch (PDOException $e) {
    json_response(['error' => 'Error de base de datos en pauta_report_links: ' . $e->getMessage()], 500);
}
