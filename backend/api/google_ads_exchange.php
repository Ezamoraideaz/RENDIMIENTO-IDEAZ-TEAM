<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/google_ads_auth.php';

// Canjea el código de autorización de Google (modo "pegar" de Conectar Google Ads) por un
// refresh token y lo guarda cifrado. Antes hay que haber pasado por
// backend/oauth/google_ads_connect.php?mode=paste en esta misma sesión.
$operator = require_role(['superadmin', 'admin']);
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}
require_state_changing_request();
google_ads_load_api_config();

if (!google_ads_client_configured()) {
    json_error('Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en api/config.php', 500);
}
if (empty($_SESSION['google_ads_oauth_state']) || ($_SESSION['google_ads_oauth_mode'] ?? '') !== 'paste') {
    json_error('Primero pulsa "Abrir Google" para autorizar y luego pega la dirección. Si ya lo hiciste, vuelve a empezar.', 400);
}

$input = json_body();
$code  = trim((string)($input['code'] ?? ''));
// Los códigos de Google son del estilo 4/0AVMBsJ... (letras, números, _ - / .)
if (!preg_match('~^[A-Za-z0-9_\-/.]{10,600}$~', $code)) {
    json_error('No se reconoció el código. Pega la dirección completa de la página a la que te llevó Google.', 400);
}

$data = google_ads_token_request([
    'code'          => $code,
    'client_id'     => GOOGLE_CLIENT_ID,
    'client_secret' => GOOGLE_CLIENT_SECRET,
    'redirect_uri'  => GOOGLE_ADS_PASTE_REDIRECT,
    'grant_type'    => 'authorization_code',
]);

if (isset($data['error'])) {
    $hint = $data['error'] === 'invalid_grant'
        ? ' El código ya se usó o venció (duran pocos minutos): pulsa "Abrir Google" otra vez y pega la dirección nueva.'
        : '';
    json_error('Google rechazó el código (' . $data['error'] . ').' . $hint, 400);
}
if (empty($data['refresh_token'])) {
    json_error('Google no entregó un refresh token. Quita el acceso de la app en myaccount.google.com/permissions y vuelve a conectar.', 400);
}

try {
    google_ads_save_refresh_token($data['refresh_token'], (int)$operator['id']);
} catch (Throwable $e) {
    json_error('No se pudo guardar la conexión en la base de datos', 500);
}
unset($_SESSION['google_ads_oauth_state'], $_SESSION['google_ads_oauth_mode']);

json_response(['connected' => true]);
