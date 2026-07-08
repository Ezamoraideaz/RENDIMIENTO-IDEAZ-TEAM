<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/meta_client.php';

require_atencion_access();

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $pending = $_SESSION['fb_oauth_pending'] ?? null;
    if (!$pending) {
        json_error('No hay una conexión pendiente. Vuelve a iniciar "Conectar Facebook/Instagram".', 404);
    }
    // No se expone el access_token al frontend, solo lo necesario para elegir.
    $pages = array_map(static function (array $p): array {
        return [
            'id'                 => $p['id'],
            'name'               => $p['name'],
            'has_instagram'      => !empty($p['instagram_business_account']),
            'instagram_username' => $p['instagram_business_account']['username'] ?? null,
        ];
    }, $pending['pages']);
    json_response(['client_id' => (int)$pending['client_id'], 'pages' => $pages]);
}

if ($method === 'POST') {
    require_state_changing_request();
    $input = json_body();
    $pageId = trim($input['page_id'] ?? '');

    $pending = $_SESSION['fb_oauth_pending'] ?? null;
    if (!$pending) {
        json_error('No hay una conexión pendiente. Vuelve a iniciar "Conectar Facebook/Instagram".', 404);
    }

    $selected = null;
    foreach ($pending['pages'] as $p) {
        if ($p['id'] === $pageId) {
            $selected = $p;
            break;
        }
    }
    if (!$selected) {
        json_error('Página no encontrada en la selección pendiente', 400);
    }

    $clientId = (int)$pending['client_id'];
    $operator = current_operator();
    $pdo = db();

    $userEnc = encrypt_token($pending['user_token']);
    $pageEnc = encrypt_token($selected['access_token']);

    $stmt = $pdo->prepare('
        INSERT INTO social_accounts
            (client_id, platform, page_id, page_name, page_access_token_encrypted, page_token_iv,
             user_access_token_encrypted, user_token_iv, token_obtained_at, last_verified_at, status, connected_by)
        VALUES (?, "facebook_page", ?, ?, ?, ?, ?, ?, NOW(), NOW(), "active", ?)
        ON DUPLICATE KEY UPDATE
            client_id = VALUES(client_id),
            page_name = VALUES(page_name),
            page_access_token_encrypted = VALUES(page_access_token_encrypted),
            page_token_iv = VALUES(page_token_iv),
            user_access_token_encrypted = VALUES(user_access_token_encrypted),
            user_token_iv = VALUES(user_token_iv),
            token_obtained_at = NOW(),
            last_verified_at = NOW(),
            status = "active"
    ');
    $stmt->execute([
        $clientId, $selected['id'], $selected['name'], $pageEnc['ciphertext'], $pageEnc['iv'],
        $userEnc['ciphertext'], $userEnc['iv'], $operator['id'] ?? null,
    ]);

    try {
        MetaClient::subscribePageToWebhook($selected['id'], $selected['access_token'], ['messages', 'messaging_postbacks', 'feed']);
    } catch (Throwable $e) {
        // No bloquea la conexión si la suscripción al webhook falla — se puede
        // reintentar después; la cuenta ya queda guardada como conectada.
    }

    $igAccount = $selected['instagram_business_account'] ?? null;
    if ($igAccount) {
        $stmt = $pdo->prepare('
            INSERT INTO social_accounts
                (client_id, platform, page_id, ig_business_id, ig_username, page_name,
                 page_access_token_encrypted, page_token_iv, user_access_token_encrypted, user_token_iv,
                 token_obtained_at, last_verified_at, status, connected_by)
            VALUES (?, "instagram_business", ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), "active", ?)
            ON DUPLICATE KEY UPDATE
                client_id = VALUES(client_id),
                ig_username = VALUES(ig_username),
                page_name = VALUES(page_name),
                page_access_token_encrypted = VALUES(page_access_token_encrypted),
                page_token_iv = VALUES(page_token_iv),
                user_access_token_encrypted = VALUES(user_access_token_encrypted),
                user_token_iv = VALUES(user_token_iv),
                token_obtained_at = NOW(),
                last_verified_at = NOW(),
                status = "active"
        ');
        $stmt->execute([
            $clientId, $selected['id'], $igAccount['id'], $igAccount['username'] ?? null, $selected['name'],
            $pageEnc['ciphertext'], $pageEnc['iv'], $userEnc['ciphertext'], $userEnc['iv'], $operator['id'] ?? null,
        ]);
    }

    unset($_SESSION['fb_oauth_pending']);
    json_response(['ok' => true]);
}

json_error('Método no permitido', 405);
