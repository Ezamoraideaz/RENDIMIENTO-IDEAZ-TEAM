<?php
require_once __DIR__ . '/../bootstrap.php';

// Registro manual de leads (total/calificados) por cliente y mes, capturado
// en el modal de detalle del Monitor de Pauta. Antes vivía en localStorage
// (localStorage.pauta_leads) — ahora compartido en BD, mismos permisos que
// pauta_clients.php.

$operator = require_login();
$pdo = db();

// Ver nota en pauta_clients.php: con display_errors apagado, el motivo real de
// un fallo de PDO viaja en la respuesta JSON, no solo en el log del servidor.
try {
    switch ($_SERVER['REQUEST_METHOD']) {
        case 'GET':
            $stmt = $pdo->query('SELECT client_id, month_key, total, qualified FROM pauta_leads');
            $leads = [];
            foreach ($stmt->fetchAll() as $row) {
                $leads[$row['client_id']][$row['month_key']] = [
                    'total'     => (int)$row['total'],
                    'qualified' => (int)$row['qualified'],
                ];
            }
            json_response(['leads' => $leads]);
            break;

        case 'POST':
            $operator = require_state_changing_request();
            if (!in_array($operator['role'], ['superadmin', 'admin'], true)) {
                json_error('No autorizado para registrar leads de pauta', 403);
            }

            $input     = json_body();
            $clientId  = trim((string)($input['client_id'] ?? ''));
            $monthKey  = trim((string)($input['month_key'] ?? ''));
            $total     = (int)($input['total']     ?? 0);
            $qualified = (int)($input['qualified'] ?? 0);

            if ($clientId === '' || !preg_match('/^\d{4}-\d{2}$/', $monthKey)) {
                json_error('client_id y month_key (YYYY-MM) son requeridos', 400);
            }
            if ($qualified > $total) {
                json_error('qualified no puede superar total', 400);
            }

            $sql = 'INSERT INTO pauta_leads (client_id, month_key, total, qualified) VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE total = VALUES(total), qualified = VALUES(qualified)';
            $pdo->prepare($sql)->execute([$clientId, $monthKey, $total, $qualified]);
            json_response(['saved' => true]);
            break;

        default:
            json_error('Método no permitido', 405);
    }
} catch (PDOException $e) {
    json_response(['error' => 'Error de base de datos en pauta_leads: ' . $e->getMessage()], 500);
}
