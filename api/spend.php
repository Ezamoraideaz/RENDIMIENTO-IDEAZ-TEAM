<?php
header('Content-Type: application/json; charset=utf-8');

// Only allow requests from same origin
$origin = $_SERVER['HTTP_ORIGIN'] ?? $_SERVER['HTTP_REFERER'] ?? '';
if ($origin && strpos($origin, 'marketingdigitalideaz.com') === false && strpos($origin, 'localhost') === false) {
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

$config = __DIR__ . '/config.php';
if (!file_exists($config)) {
    http_response_code(500);
    echo json_encode(['error' => 'config.php no encontrado. Crea el archivo en api/config.php']);
    exit;
}
require_once $config;

$platform   = trim($_GET['platform']   ?? '');
$account_id = trim($_GET['account_id'] ?? '');
$date_from  = trim($_GET['from']       ?? date('Y-m-01'));
$date_to    = trim($_GET['to']         ?? date('Y-m-d'));

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

switch ($platform) {
    case 'meta':
        echo json_encode(getMetaSpend($account_id, $date_from, $date_to));
        break;
    case 'google':
        echo json_encode(['error' => 'Google Ads — próximamente', 'platform' => 'google']);
        break;
    case 'tiktok':
        echo json_encode(['error' => 'TikTok Ads — próximamente', 'platform' => 'tiktok']);
        break;
    default:
        http_response_code(400);
        echo json_encode(['error' => "Plataforma no soportada: {$platform}"]);
}

// ─── META ADS ────────────────────────────────────────────────────────────────

function getMetaSpend(string $account_id, string $date_from, string $date_to): array {
    if (!defined('META_ACCESS_TOKEN') || META_ACCESS_TOKEN === 'YOUR_META_SYSTEM_USER_TOKEN_HERE') {
        return ['error' => 'Meta Access Token no configurado en config.php'];
    }

    $token      = META_ACCESS_TOKEN;
    $time_range = json_encode(['since' => $date_from, 'until' => $date_to]);
    $fields     = 'spend,date_start,date_stop,account_name,account_currency';

    $url = sprintf(
        'https://graph.facebook.com/v19.0/%s/insights?fields=%s&time_range=%s&time_increment=1&access_token=%s',
        urlencode($account_id),
        urlencode($fields),
        urlencode($time_range),
        urlencode($token)
    );

    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT        => 15,
    ]);
    $response  = curl_exec($ch);
    $curl_err  = curl_error($ch);
    $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($curl_err) {
        return ['error' => "cURL error: {$curl_err}", 'platform' => 'meta'];
    }

    $data = json_decode($response, true);

    if (isset($data['error'])) {
        return [
            'error'    => $data['error']['message'] ?? 'Error desconocido de Meta API',
            'code'     => $data['error']['code']    ?? 0,
            'platform' => 'meta',
        ];
    }

    $daily   = [];
    $total   = 0.0;
    $currency = 'USD';

    foreach ($data['data'] ?? [] as $row) {
        $spend    = (float)($row['spend'] ?? 0);
        $total   += $spend;
        $currency = $row['account_currency'] ?? $currency;
        $daily[]  = ['date' => $row['date_start'], 'spend' => $spend];
    }

    return [
        'platform'    => 'meta',
        'account_id'  => $account_id,
        'total_spend' => round($total, 2),
        'currency'    => $currency,
        'daily_data'  => $daily,
        'date_from'   => $date_from,
        'date_to'     => $date_to,
    ];
}
