<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Link público "vivo" por cliente para el equipo comercial (sin login) — ver
// registros y exportar CSV en leads-cliente.html?t=<token>. Mismo patrón de
// token que content_batches.php (crudo solo se devuelve al generarlo, en BD
// solo queda el hash), pero un solo link persistente por cliente en vez de
// uno por tanda.

require_atencion_access();
$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $clientId = (int)($_GET['client_id'] ?? 0);
        if ($clientId <= 0) {
            json_error('client_id requerido', 400);
        }
        $stmt = $pdo->prepare('SELECT 1 FROM organic_lead_share_links WHERE client_id = ?');
        $stmt->execute([$clientId]);
        json_response(['link_generated' => (bool)$stmt->fetchColumn()]);
        break;

    case 'POST':
        $operator = require_state_changing_request();
        $input = json_body();
        $clientId = (int)($input['client_id'] ?? 0);
        $action = $input['action'] ?? '';
        if ($clientId <= 0) {
            json_error('client_id requerido', 400);
        }

        if ($action === 'generate_link') {
            $rawToken = bin2hex(random_bytes(32));
            $tokenHash = hash('sha256', $rawToken);
            // Regenerar pisa el hash anterior (INSERT ... ON DUPLICATE KEY),
            // lo que invalida automáticamente cualquier link previo del cliente.
            $pdo->prepare('
                INSERT INTO organic_lead_share_links (client_id, token_hash, created_by)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), created_by = VALUES(created_by), created_at = NOW()
            ')->execute([$clientId, $tokenHash, $operator['id']]);
            json_response(['token' => $rawToken]);
            break;
        }

        if ($action === 'revoke_link') {
            $pdo->prepare('DELETE FROM organic_lead_share_links WHERE client_id = ?')->execute([$clientId]);
            json_response(['ok' => true]);
            break;
        }

        json_error('action inválida', 400);
        break;

    default:
        json_error('Método no permitido', 405);
}
