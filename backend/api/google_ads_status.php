<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/google_ads_auth.php';

// Estado de la conexión con Google Ads para Pauta. ?check=1 además prueba renovar el
// access token (detecta si la conexión venció). No expone ningún token.
require_role(['superadmin', 'admin']);
google_ads_load_api_config();

$refresh = google_ads_refresh_token();
$result = [
    'client_configured' => google_ads_client_configured(),
    'connected'         => $refresh['token'] !== null,
    'source'            => $refresh['source'],       // db | config | none
    'updated_at'        => $refresh['updated_at'],
    'redirect_uri'      => google_ads_redirect_uri(), // para registrarla en Google Cloud
];

if (isset($_GET['check']) && $result['connected'] && $result['client_configured']) {
    google_ads_forget_access_token();
    $token = google_ads_access_token();
    $result['valid']  = !empty($token['access_token']);
    $result['error']  = $token['error'] ?? null;
    $result['reauth'] = !empty($token['reauth']);
}

json_response($result);
