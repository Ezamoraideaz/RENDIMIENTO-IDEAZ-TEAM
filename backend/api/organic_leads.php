<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/organic_leads_csv.php';

// Listado / exportación / borrado de leads orgánicos ya importados. La
// importación en sí vive en organic_lead_import.php (multipart, distinto
// content-type).

require_atencion_access();
$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $clientId = (int)($_GET['client_id'] ?? 0);
        if ($clientId <= 0) {
            json_error('client_id requerido', 400);
        }
        $q = trim($_GET['q'] ?? '');

        $where = 'WHERE client_id = ?';
        $params = [$clientId];
        if ($q !== '') {
            $where .= ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)';
            $like = '%' . $q . '%';
            array_push($params, $like, $like, $like);
        }

        if (($_GET['export'] ?? '') === 'csv') {
            $stmt = $pdo->prepare("SELECT * FROM organic_leads {$where} ORDER BY created_at DESC");
            $stmt->execute($params);
            $clientStmt = $pdo->prepare('SELECT name FROM clients WHERE id = ?');
            $clientStmt->execute([$clientId]);
            organic_leads_stream_csv($stmt->fetchAll(), (string)$clientStmt->fetchColumn());
        }

        // Tope de 2000 para la tabla en pantalla; el export CSV de arriba no lo tiene.
        $stmt = $pdo->prepare("SELECT * FROM organic_leads {$where} ORDER BY created_at DESC LIMIT 2000");
        $stmt->execute($params);
        $countStmt = $pdo->prepare('SELECT COUNT(*) FROM organic_leads WHERE client_id = ?');
        $countStmt->execute([$clientId]);
        json_response(['leads' => $stmt->fetchAll(), 'total' => (int)$countStmt->fetchColumn()]);
        break;

    case 'DELETE':
        require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $pdo->prepare('DELETE FROM organic_leads WHERE id = ?')->execute([$id]);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
