<?php
require_once __DIR__ . '/../bootstrap.php';

require_atencion_access();

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();

// Reconstruye flow_triggers a partir de los nodos disparadores del graph_json.
// node_id apunta al nodo siguiente conectado (el disparador en sí no envía nada).
function rebuild_flow_triggers(PDO $pdo, int $flowId, array $graph): void
{
    // tipo de nodo del builder => trigger_type del esquema
    $triggerTypes = [
        'trigger_keyword'          => 'keyword',
        'trigger_comment'          => 'comment_on_post',
        'trigger_new_conversation' => 'new_conversation',
    ];

    $nodes = $graph['nodes'] ?? [];
    $edges = $graph['edges'] ?? [];

    $pdo->prepare('DELETE FROM flow_triggers WHERE flow_id = ?')->execute([$flowId]);

    $insert = $pdo->prepare('
        INSERT INTO flow_triggers (flow_id, platform_scope, trigger_type, match_config, node_id, priority, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
    ');

    $priority = 0;
    foreach ($nodes as $node) {
        $type = $triggerTypes[$node['type'] ?? ''] ?? null;
        if ($type === null) {
            continue;
        }
        $nextId = null;
        foreach ($edges as $edge) {
            if (($edge['from'] ?? null) === $node['id']) {
                $nextId = $edge['to'];
                break;
            }
        }
        if ($nextId === null) {
            continue; // disparador sin nodo siguiente conectado: se ignora
        }
        $keywords = $node['data']['keywords'] ?? [];
        $scope = $node['data']['platform_scope'] ?? 'both';
        $insert->execute([$flowId, $scope, $type, json_encode(['keywords' => $keywords]), $nextId, $priority]);
        $priority++;
    }
}

switch ($method) {
    case 'GET':
        if (!empty($_GET['id'])) {
            $stmt = $pdo->prepare('SELECT * FROM flows WHERE id = ?');
            $stmt->execute([(int)$_GET['id']]);
            $flow = $stmt->fetch();
            if (!$flow) {
                json_error('Flujo no encontrado', 404);
            }
            json_response(['flow' => $flow]);
        }

        $clientId = (int)($_GET['client_id'] ?? 0);
        if ($clientId <= 0) {
            json_error('client_id requerido', 400);
        }
        $stmt = $pdo->prepare('SELECT id, name, status, version, social_account_id, updated_at FROM flows WHERE client_id = ? ORDER BY updated_at DESC');
        $stmt->execute([$clientId]);
        json_response(['flows' => $stmt->fetchAll()]);
        break;

    case 'POST':
        require_state_changing_request();
        $input = json_body();
        $clientId = (int)($input['client_id'] ?? 0);
        $name = trim($input['name'] ?? '');
        if ($clientId <= 0 || $name === '') {
            json_error('client_id y name son requeridos', 400);
        }
        $socialAccountId = !empty($input['social_account_id']) ? (int)$input['social_account_id'] : null;
        $operator = current_operator();

        $stmt = $pdo->prepare('
            INSERT INTO flows (client_id, social_account_id, name, status, graph_json, created_by)
            VALUES (?, ?, ?, "draft", ?, ?)
        ');
        $stmt->execute([$clientId, $socialAccountId, $name, json_encode(['nodes' => [], 'edges' => []]), $operator['id'] ?? null]);
        json_response(['id' => (int)$pdo->lastInsertId()], 201);
        break;

    case 'PUT':
        require_state_changing_request();
        $input = json_body();
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }

        $stmt = $pdo->prepare('SELECT * FROM flows WHERE id = ?');
        $stmt->execute([$id]);
        $flow = $stmt->fetch();
        if (!$flow) {
            json_error('Flujo no encontrado', 404);
        }

        $fields = [];
        $values = [];
        if (array_key_exists('name', $input)) {
            $fields[] = 'name = ?';
            $values[] = $input['name'];
        }
        if (array_key_exists('graph_json', $input)) {
            $fields[] = 'graph_json = ?';
            $values[] = json_encode($input['graph_json']);
            $fields[] = 'version = version + 1';
        }
        if (array_key_exists('status', $input) && in_array($input['status'], ['draft', 'active', 'paused'], true)) {
            $fields[] = 'status = ?';
            $values[] = $input['status'];
        }
        if (!$fields) {
            json_error('Nada para actualizar', 400);
        }
        $values[] = $id;
        $pdo->prepare('UPDATE flows SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($values);

        // Publicar (o re-guardar un flujo ya activo) reconstruye los disparadores indexados
        $newStatus = $input['status'] ?? $flow['status'];
        if ($newStatus === 'active') {
            $graph = array_key_exists('graph_json', $input) ? $input['graph_json'] : json_decode($flow['graph_json'], true);
            rebuild_flow_triggers($pdo, $id, is_array($graph) ? $graph : ['nodes' => [], 'edges' => []]);
        } elseif ($newStatus !== 'active' && $flow['status'] === 'active') {
            $pdo->prepare('UPDATE flow_triggers SET active = 0 WHERE flow_id = ?')->execute([$id]);
        }

        json_response(['ok' => true]);
        break;

    case 'DELETE':
        require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $pdo->prepare('DELETE FROM flows WHERE id = ?')->execute([$id]);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
