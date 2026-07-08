<?php
require_once __DIR__ . '/../bootstrap.php';

require_atencion_access();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_error('Método no permitido', 405);
}

$pdo = db();

if (!empty($_GET['id'])) {
    $id = (int)$_GET['id'];
    $stmt = $pdo->prepare('
        SELECT conv.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone,
               c.profile_pic_url, sa.platform, sa.page_name, sa.ig_username
        FROM conversations conv
        JOIN contacts c ON c.id = conv.contact_id
        JOIN social_accounts sa ON sa.id = conv.social_account_id
        WHERE conv.id = ?
    ');
    $stmt->execute([$id]);
    $conversation = $stmt->fetch();
    if (!$conversation) {
        json_error('Conversación no encontrada', 404);
    }

    $stmt = $pdo->prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC');
    $stmt->execute([$id]);
    $messages = $stmt->fetchAll();

    $stmt = $pdo->prepare('SELECT * FROM scheduled_actions WHERE conversation_id = ? AND status = "needs_manual_followup" ORDER BY run_at ASC');
    $stmt->execute([$id]);
    $pendingFollowups = $stmt->fetchAll();

    json_response(['conversation' => $conversation, 'messages' => $messages, 'pending_followups' => $pendingFollowups]);
}

$clientId = (int)($_GET['client_id'] ?? 0);
if ($clientId <= 0) {
    json_error('client_id requerido', 400);
}

$stmt = $pdo->prepare('
    SELECT conv.id, conv.status, conv.last_inbound_at, conv.window_expires_at, conv.human_agent_tag_until,
           c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone,
           sa.platform, sa.page_name, sa.ig_username,
           (SELECT content FROM messages m WHERE m.conversation_id = conv.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
           (SELECT COUNT(*) FROM scheduled_actions sch WHERE sch.conversation_id = conv.id AND sch.status = "needs_manual_followup") AS pending_followups
    FROM conversations conv
    JOIN contacts c ON c.id = conv.contact_id
    JOIN social_accounts sa ON sa.id = conv.social_account_id
    WHERE c.client_id = ?
    ORDER BY conv.last_inbound_at DESC
');
$stmt->execute([$clientId]);
json_response(['conversations' => $stmt->fetchAll()]);
