<?php
// Sesión global del sitio: este endpoint expone gasto publicitario real, así que
// exige login igual que el resto de la API (backend/includes/auth.php).
require_once __DIR__ . '/../backend/bootstrap.php';
require_login();

header('Content-Type: application/json; charset=utf-8');

$config = __DIR__ . '/config.php';
if (!file_exists($config)) {
    http_response_code(500);
    echo json_encode(['error' => 'config.php no encontrado. Crea el archivo en api/config.php']);
    exit;
}
require_once $config;
require_once __DIR__ . '/spend_lib.php';

$platform   = trim($_GET['platform']   ?? '');
$account_id = trim($_GET['account_id'] ?? '');
$date_from  = trim($_GET['from']       ?? date('Y-m-01'));
$date_to    = trim($_GET['to']         ?? date('Y-m-d'));
$debug      = isset($_GET['debug']) && $_GET['debug'] === '1';

// Validate dates
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date_from) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date_to)) {
    http_response_code(400);
    echo json_encode(['error' => 'Formato de fecha inválido. Usar YYYY-MM-DD']);
    exit;
}

if (empty($platform) || empty($account_id)) {
    http_response_code(400);
    echo json_encode(['error' => 'Parámetros requeridos: platform, account_id, from, to']);
    exit;
}

// Caché de 10 minutos por consulta: evita repetir N×M llamadas en vivo a las
// plataformas en cada refresco (y el rate-limit de Meta). El botón "Actualizar"
// manda fresh=1 para saltárselo.
const SPEND_CACHE_TTL = 600;
$fresh     = isset($_GET['fresh']) && $_GET['fresh'] === '1';
$cacheFile = sys_get_temp_dir() . '/pauta_spend_' . md5("{$platform}|{$account_id}|{$date_from}|{$date_to}");

if (!$fresh && !$debug && is_file($cacheFile) && (time() - filemtime($cacheFile)) < SPEND_CACHE_TTL) {
    readfile($cacheFile);
    exit;
}

switch ($platform) {
    case 'meta':
        $result = getMetaSpend($account_id, $date_from, $date_to, $debug);
        break;
    case 'google':
        $result = getGoogleSpend($account_id, $date_from, $date_to, $debug);
        break;
    case 'tiktok':
        $result = ['error' => 'TikTok Ads — próximamente', 'platform' => 'tiktok'];
        break;
    case 'meta_detail':
        $result = getMetaCampaignDetail($account_id, $date_from, $date_to, $debug);
        break;
    case 'google_detail':
        $result = getGoogleCampaignDetail($account_id, $date_from, $date_to, $debug);
        break;
    case 'meta_status':   // estado de la cuenta: pago pendiente, límite de gasto, deshabilitada…
        $result = getMetaAccountStatus($account_id, $debug);
        break;
    case 'google_status':
        $result = getGoogleAccountStatus($account_id, $debug);
        break;
    default:
        http_response_code(400);
        echo json_encode(['error' => "Plataforma no soportada: {$platform}"]);
        exit;
}

$json = json_encode($result);
if (!$debug && empty($result['error'])) {
    @file_put_contents($cacheFile, $json); // los errores no se cachean
}
echo $json;
