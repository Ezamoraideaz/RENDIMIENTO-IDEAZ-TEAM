<?php
require_once __DIR__ . '/../bootstrap.php';

require_client_setup_access(); // roles con acceso a Atención al Cliente o al asistente de configuración

$clientId = (int)($_GET['client_id'] ?? 0);
if ($clientId <= 0) {
    json_error('client_id requerido', 400);
}

$stmt = db()->prepare('SELECT id FROM clients WHERE id = ?');
$stmt->execute([$clientId]);
if (!$stmt->fetch()) {
    json_error('Cliente no encontrado', 404);
}

// State anti-CSRF + client_id de destino, validados en el callback
$state = bin2hex(random_bytes(16));
$_SESSION['fb_oauth_state']     = $state;
$_SESSION['fb_oauth_client_id'] = $clientId;
// ?return=asistente → al terminar vuelve a configurar-cliente.html en vez de Atención al Cliente
$_SESSION['fb_oauth_return']    = ($_GET['return'] ?? '') === 'asistente' ? 'asistente' : '';

// Estos son los permisos correctos para el flujo "API setup with Facebook Login"
// (Página + cuenta de Instagram vinculada descubiertas juntas en un solo OAuth).
// Los nombres "instagram_business_*" son de un flujo distinto ("API setup with
// Instagram Login", con su propio App ID de Instagram) y no aplican aquí.
$scopes = [
    'pages_show_list',
    'pages_messaging',
    'pages_manage_metadata',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_manage_messages',
    'instagram_manage_comments',
    'business_management',
    'pages_manage_ads',  // prerequisito de leads_retrieval — Meta rechaza el scope sin este
    'ads_management',    // leer campaign_name/ad_name del lead (Lead Ads Testing Tool lo exige)
    'leads_retrieval',   // leer los datos de formularios instantáneos (Instant Forms) de Meta Ads
];

$params = http_build_query([
    'client_id'     => META_APP_ID,
    'redirect_uri'  => OAUTH_REDIRECT_URI,
    'state'         => $state,
    'scope'         => implode(',', $scopes),
    'response_type' => 'code',
]);

header('Location: https://www.facebook.com/v21.0/dialog/oauth?' . $params);
exit;
