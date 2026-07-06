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

    // No se guarda nada todavía: si la cuenta de Facebook administra varias Páginas
    // (de varios clientes distintos), hay que dejar que el operador elija cuál
    // corresponde a ESTE cliente, en vez de conectarlas todas automáticamente.
    $_SESSION['fb_oauth_pending'] = [
        'client_id'  => $clientId,
        'user_token' => $longToken,
        'pages'      => array_map(static function (array $page): array {
            return [
                'id'                         => $page['id'],
                'name'                       => $page['name'],
                'access_token'               => $page['access_token'],
                'instagram_business_account' => $page['instagram_business_account'] ?? null,
            ];
        }, $pages),
    ];

    header('Location: ' . $redirectBase . '?oauth_select_page=1&client_id=' . $clientId);
    exit;
} catch (Throwable $e) {
    header('Location: ' . $redirectBase . '?oauth_error=' . urlencode($e->getMessage()));
    exit;
}
