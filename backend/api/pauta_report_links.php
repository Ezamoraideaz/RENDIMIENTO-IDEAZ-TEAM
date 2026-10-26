<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Links privados del reporte de pauta para el cliente final. Solo superadmin/admin
// (mismos roles que gestionan los clientes de pauta). El token crudo solo se devuelve
// al crearlo; en BD queda su hash. Lo consume backend/public/pauta_report_public.php.

$operator = require_login();
if (!in_array($operator['role'], ['superadmin', 'admin'], true)) {
    json_error('No autorizado', 403);
}
$pdo = db();

function valid_date(?string $d): bool
{
    return is_string($d) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) && checkdate((int)substr($d, 5, 2), (int)substr($d, 8, 2), (int)substr($d, 0, 4));
}

try {
    switch ($_SERVER['REQUEST_METHOD']) {
        case 'GET':
            $clientId = trim((string)($_GET['client_id'] ?? ''));
            if ($clientId === '') {
                json_error('client_id requerido', 400);
            }
            $stmt = $pdo->prepare('SELECT id, mode, date_from, date_to, title, message, lead_goal, created_at
                                   FROM pauta_report_links WHERE pauta_client_id = ? ORDER BY created_at DESC');
            $stmt->execute([$clientId]);
            json_response(['links' => $stmt->fetchAll()]);
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
                $goal     = (int)($input['lead_goal'] ?? 0);
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
                    if (!valid_date($from) || !valid_date($to) || $from > $to) {
                        json_error('Para un reporte por rango indica fechas válidas (desde ≤ hasta)', 400);
                    }
                } else {
                    $from = $to = null;
                }

                $rawToken = bin2hex(random_bytes(32));
                $pdo->prepare('INSERT INTO pauta_report_links (pauta_client_id, token_hash, mode, date_from, date_to, title, message, lead_goal, created_by)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    ->execute([$clientId, hash('sha256', $rawToken), $mode, $from, $to, $title, $message !== '' ? $message : null, $goal > 0 ? $goal : null, $operator['id']]);
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
