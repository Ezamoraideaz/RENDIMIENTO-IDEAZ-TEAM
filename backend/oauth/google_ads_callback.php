<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/google_ads_auth.php';

// Vuelta de Google tras "Conectar Google Ads": cambia el código por un refresh token y lo
// guarda cifrado en app_settings. Siempre termina redirigiendo a pauta.html con el resultado.
$operator = require_role(['superadmin', 'admin']);
google_ads_load_api_config();

$back = APP_BASE_URL . '/pauta.html';
$fail = static function (string $msg) use ($back): void {
    header('Location: ' . $back . '?google_ads=error&msg=' . urlencode($msg));
    exit;
};

$code  = $_GET['code']  ?? '';
$state = $_GET['state'] ?? '';
$error = $_GET['error'] ?? '';

if ($error !== '') {
    $fail($error === 'access_denied' ? 'Cancelaste la autorización en Google' : "Google respondió: {$error}");
}
if (empty($_SESSION['google_ads_oauth_state']) || !hash_equals($_SESSION['google_ads_oauth_state'], $state)) {
    $fail('Estado inválido, vuelve a intentar "Conectar Google Ads"');
}
unset($_SESSION['google_ads_oauth_state']);

if ($code === '' || !google_ads_client_configured()) {
    $fail('Faltan datos para completar la conexión');
}

$data = google_ads_token_request([
    'code'          => $code,
    'client_id'     => GOOGLE_CLIENT_ID,
    'client_secret' => GOOGLE_CLIENT_SECRET,
    'redirect_uri'  => google_ads_redirect_uri(),
    'grant_type'    => 'authorization_code',
]);

if (isset($data['error'])) {
    // redirect_uri_mismatch: la URL del callback no está en "URIs de redireccionamiento autorizados" del cliente OAuth
    $fail('Google rechazó la conexión (' . $data['error'] . ')' . (!empty($data['error_description']) ? ': ' . $data['error_description'] : ''));
}
if (empty($data['refresh_token'])) {
    $fail('Google no entregó un refresh token. Quita el acceso de la app en myaccount.google.com/permissions y vuelve a conectar.');
}

try {
    google_ads_save_refresh_token($data['refresh_token'], (int)$operator['id']);
} catch (Throwable $e) {
    $fail('No se pudo guardar la conexión en la base de datos');
}

header('Location: ' . $back . '?google_ads=ok');
exit;
