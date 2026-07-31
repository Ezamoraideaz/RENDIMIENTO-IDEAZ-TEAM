<?php
require_once __DIR__ . '/../bootstrap.php';

// Clientes del Monitor de Pauta (pauta.html): nombre, presupuesto global por
// mes y configuración por plataforma (Meta/Google/TikTok). Antes vivía en
// localStorage — cada usuario veía su propia lista. Ahora es compartido en BD:
// lectura para cualquier logueado, escritura solo superadmin/admin (mismos
// roles que ya tienen acceso a la página según js/session.js ACCESS['pauta']).

$operator = require_login();
$pdo = db();

// En hosting compartido display_errors suele estar apagado (ver bootstrap.php),
// así que una excepción de PDO se convierte en un 500 en blanco sin pista alguna.
// Igual que en google_sheets.php, el motivo real viaja en la respuesta JSON.
try {
    switch ($_SERVER['REQUEST_METHOD']) {
        case 'GET':
            $stmt = $pdo->query('SELECT id, name, budgets, platforms FROM pauta_clients ORDER BY created_at ASC');
            $clients = [];
            foreach ($stmt->fetchAll() as $row) {
                $clients[] = [
                    'id'        => $row['id'],
                    'name'      => $row['name'],
                    'budgets'   => json_decode($row['budgets'], true) ?: (object)[],
                    'platforms' => json_decode($row['platforms'], true) ?: [],
                ];
            }
            json_response(['clients' => $clients]);
            break;

        case 'POST':
            $operator = require_state_changing_request();
            if (!in_array($operator['role'], ['superadmin', 'admin'], true)) {
                json_error('No autorizado para modificar clientes de pauta', 403);
            }

            $input = json_body();
            $id        = trim((string)($input['id'] ?? ''));
            $name      = trim((string)($input['name'] ?? ''));
            $budgets   = $input['budgets']   ?? null;
            $platforms = $input['platforms'] ?? null;

            if ($id === '' || strlen($id) > 32) {
                json_error('id de cliente inválido', 400);
            }
            if ($name === '') {
                json_error('El nombre del cliente es requerido', 400);
            }
            if (!is_array($budgets) || !is_array($platforms)) {
                json_error('budgets y platforms deben ser objetos/arreglos válidos', 400);
            }

            $sql = 'INSERT INTO pauta_clients (id, name, budgets, platforms) VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE name = VALUES(name), budgets = VALUES(budgets), platforms = VALUES(platforms)';
            $pdo->prepare($sql)->execute([
                $id,
                $name,
                json_encode($budgets, JSON_UNESCAPED_UNICODE),
                json_encode($platforms, JSON_UNESCAPED_UNICODE),
            ]);
            json_response(['saved' => $id]);
            break;

        case 'DELETE':
            $operator = require_state_changing_request();
            if (!in_array($operator['role'], ['superadmin', 'admin'], true)) {
                json_error('No autorizado para eliminar clientes de pauta', 403);
            }
            $id = trim((string)($_GET['id'] ?? ''));
            if ($id === '') {
                json_error('Se requiere id', 400);
            }
            $pdo->prepare('DELETE FROM pauta_clients WHERE id = ?')->execute([$id]);
            json_response(['deleted' => $id]);
            break;

        default:
            json_error('Método no permitido', 405);
    }
} catch (PDOException $e) {
    json_response(['error' => 'Error de base de datos en pauta_clients: ' . $e->getMessage()], 500);
}
