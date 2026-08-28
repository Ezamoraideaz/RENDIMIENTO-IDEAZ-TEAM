<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Lista de correos del equipo comercial a notificar por cliente cuando se
// importa una base de leads orgánicos. Mismo espíritu que ad_lead_rules.php
// pero sin lógica de campaña/formulario — acá es simplemente un correo por cliente.

require_atencion_access();
$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $clientId = (int)($_GET['client_id'] ?? 0);
        if ($clientId <= 0) {
            json_error('client_id requerido', 400);
        }
        $stmt = $pdo->prepare('SELECT id, email FROM organic_lead_notify_emails WHERE client_id = ? ORDER BY id ASC');
        $stmt->execute([$clientId]);
        json_response(['emails' => $stmt->fetchAll()]);
        break;

    case 'POST':
        require_state_changing_request();
        $input = json_body();
        $clientId = (int)($input['client_id'] ?? 0);
        $email = trim($input['email'] ?? '');
        if ($clientId <= 0 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            json_error('client_id y un email válido son requeridos', 400);
        }
        $pdo->prepare('INSERT IGNORE INTO organic_lead_notify_emails (client_id, email) VALUES (?, ?)')
            ->execute([$clientId, $email]);
        json_response(['ok' => true], 201);
        break;

    case 'DELETE':
        require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $pdo->prepare('DELETE FROM organic_lead_notify_emails WHERE id = ?')->execute([$id]);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
