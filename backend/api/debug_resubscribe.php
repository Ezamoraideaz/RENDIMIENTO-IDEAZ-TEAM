<?php
// Diagnóstico temporal: vuelve a suscribir la Página con una lista de campos más
// amplia (incluyendo "comments"), y devuelve el resultado + la suscripción
// resultante para confirmar si cambia algo.
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/meta_client.php';

require_login();

$id = (int)($_GET['social_account_id'] ?? 0);
if ($id <= 0) {
    json_error('social_account_id requerido', 400);
}

$stmt = db()->prepare('SELECT * FROM social_accounts WHERE id = ?');
$stmt->execute([$id]);
$account = $stmt->fetch();
if (!$account) {
    json_error('Cuenta no encontrada', 404);
}

try {
    $pageToken = decrypt_token($account['page_access_token_encrypted'], $account['page_token_iv']);

    $subscribeResult = MetaClient::subscribePageToWebhook(
        $account['page_id'],
        $pageToken,
        ['messages', 'messaging_postbacks', 'feed', 'comments', 'message_reactions', 'messaging_seen']
    );

    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => "https://graph.facebook.com/v21.0/{$account['page_id']}/subscribed_apps?access_token=" . urlencode($pageToken),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $response = curl_exec($ch);
    curl_close($ch);

    json_response([
        'subscribe_result' => $subscribeResult,
        'current_subscription' => json_decode($response, true),
    ]);
} catch (Throwable $e) {
    json_error($e->getMessage(), 500);
}
