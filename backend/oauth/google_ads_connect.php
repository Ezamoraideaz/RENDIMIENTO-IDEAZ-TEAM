<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/google_ads_auth.php';

// Inicia "Conectar Google Ads" desde Pauta (solo superadmin/admin, igual que el módulo).
// Redirige a Google para autorizar; Google vuelve a google_ads_callback.php.
require_role(['superadmin', 'admin']);
google_ads_load_api_config();

$back = APP_BASE_URL . '/pauta.html';
if (!google_ads_client_configured()) {
    header('Location: ' . $back . '?google_ads=error&msg=' . urlencode('Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en api/config.php'));
    exit;
}

$state = bin2hex(random_bytes(16));
$_SESSION['google_ads_oauth_state'] = $state;

$params = [
    'client_id'              => GOOGLE_CLIENT_ID,
    'redirect_uri'           => google_ads_redirect_uri(),
    'response_type'          => 'code',
    'scope'                  => GOOGLE_ADS_SCOPE,
    'access_type'            => 'offline',  // para recibir refresh token
    'prompt'                 => 'consent',  // obliga a Google a entregar un refresh token nuevo
    'include_granted_scopes' => 'true',
    'state'                  => $state,
];
header('Location: https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query($params));
exit;
