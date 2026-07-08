<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/meta_client.php';
require_once __DIR__ . '/../includes/trigger_engine.php';

require_atencion_access();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

require_state_changing_request();

$input = json_body();
$conversationId = (int)($input['conversation_id'] ?? 0);
$text = trim($input['text'] ?? '');
$scheduledActionId = !empty($input['scheduled_action_id']) ? (int)$input['scheduled_action_id'] : null;

if ($conversationId <= 0 || $text === '') {
    json_error('conversation_id y text son requeridos', 400);
}

try {
    $result = TriggerEngine::sendManual($conversationId, $text);
} catch (Throwable $e) {
    json_error($e->getMessage(), 422);
}

if ($scheduledActionId) {
    db()->prepare('UPDATE scheduled_actions SET status = "sent", updated_at = NOW() WHERE id = ? AND conversation_id = ?')
        ->execute([$scheduledActionId, $conversationId]);
}

json_response(['ok' => true, 'tag' => $result['tag']]);
