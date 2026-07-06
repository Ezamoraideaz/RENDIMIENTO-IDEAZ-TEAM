<?php
// Diagnóstico temporal: consulta directamente a la Graph API qué campos de webhook
// están realmente suscritos para una cuenta conectada, sin depender de la consola
// (confusa) de Meta. Requiere sesión de operador — no es público.
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
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => "https://graph.facebook.com/v21.0/{$account['page_id']}/subscribed_apps?access_token=" . urlencode($pageToken),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    json_response([
        'page_id' => $account['page_id'],
        'platform' => $account['platform'],
        'http_code' => $httpCode,
        'graph_response' => json_decode($response, true),
    ]);
} catch (Throwable $e) {
    json_error($e->getMessage(), 500);
}
