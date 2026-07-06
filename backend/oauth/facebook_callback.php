<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/meta_client.php';

require_login();

$redirectBase = APP_BASE_URL . '/atencion-cliente.html';

$code  = $_GET['code'] ?? '';
$state = $_GET['state'] ?? '';
$error = $_GET['error_description'] ?? $_GET['error'] ?? '';

if ($error !== '') {
    header('Location: ' . $redirectBase . '?oauth_error=' . urlencode($error));
    exit;
}

if (empty($_SESSION['fb_oauth_state']) || !hash_equals($_SESSION['fb_oauth_state'], $state)) {
    header('Location: ' . $redirectBase . '?oauth_error=' . urlencode('Estado inválido, intenta de nuevo'));
    exit;
}

$clientId = (int)($_SESSION['fb_oauth_client_id'] ?? 0);
unset($_SESSION['fb_oauth_state'], $_SESSION['fb_oauth_client_id']);

try {
    $shortToken = MetaClient::exchangeCodeForUserToken($code);
    $longToken  = MetaClient::exchangeForLongLivedUserToken($shortToken);
    $pages      = MetaClient::listManagedPages($longToken);

    if (empty($pages)) {
        header('Location: ' . $redirectBase . '?oauth_error=' . urlencode('No se encontraron Páginas de Facebook administradas por esta cuenta'));
        exit;
    }

    $userEnc = encrypt_token($longToken);
    $operator = current_operator();
    $pdo = db();

    foreach ($pages as $page) {
        $pageId    = $page['id'];
        $pageName  = $page['name'];
        $pageToken = $page['access_token'];
        $pageEnc   = encrypt_token($pageToken);

        $stmt = $pdo->prepare('
            INSERT INTO social_accounts
                (client_id, platform, page_id, page_name, page_access_token_encrypted, page_token_iv,
                 user_access_token_encrypted, user_token_iv, token_obtained_at, last_verified_at, status, connected_by)
            VALUES (?, "facebook_page", ?, ?, ?, ?, ?, ?, NOW(), NOW(), "active", ?)
            ON DUPLICATE KEY UPDATE
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
            $clientId, $pageId, $pageName, $pageEnc['ciphertext'], $pageEnc['iv'],
            $userEnc['ciphertext'], $userEnc['iv'], $operator['id'] ?? null,
        ]);

        MetaClient::subscribePageToWebhook($pageId, $pageToken, ['messages', 'messaging_postbacks', 'feed']);

        $igAccount = $page['instagram_business_account'] ?? null;
        if ($igAccount) {
            $stmt = $pdo->prepare('
                INSERT INTO social_accounts
                    (client_id, platform, page_id, ig_business_id, ig_username, page_name,
                     page_access_token_encrypted, page_token_iv, user_access_token_encrypted, user_token_iv,
                     token_obtained_at, last_verified_at, status, connected_by)
                VALUES (?, "instagram_business", ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), "active", ?)
                ON DUPLICATE KEY UPDATE
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
                $clientId, $pageId, $igAccount['id'], $igAccount['username'] ?? null, $pageName,
                $pageEnc['ciphertext'], $pageEnc['iv'], $userEnc['ciphertext'], $userEnc['iv'], $operator['id'] ?? null,
            ]);
        }
    }

    header('Location: ' . $redirectBase . '?oauth_success=1&client_id=' . $clientId);
    exit;
} catch (Throwable $e) {
    header('Location: ' . $redirectBase . '?oauth_error=' . urlencode($e->getMessage()));
    exit;
}
