<?php
require_once __DIR__ . '/../bootstrap.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();

switch ($method) {
    case 'GET':
        $clientId = (int)($_GET['client_id'] ?? 0);
        if ($clientId <= 0) {
            json_error('client_id requerido', 400);
        }
        $stmt = $pdo->prepare('
            SELECT id, platform, page_id, page_name, ig_business_id, ig_username, status, last_verified_at, created_at
            FROM social_accounts
            WHERE client_id = ?
            ORDER BY platform ASC
        ');
        $stmt->execute([$clientId]);
        json_response(['accounts' => $stmt->fetchAll()]);
        break;

    case 'DELETE':
        require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        // No se borra el registro (conserva historial de conversaciones/mensajes),
        // se marca como revocada y deja de recibir/enviar.
        $pdo->prepare('UPDATE social_accounts SET status = "revoked" WHERE id = ?')->execute([$id]);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
