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

switch ($platform) {
    case 'meta':
        echo json_encode(getMetaSpend($account_id, $date_from, $date_to, $debug));
        break;
    case 'google':
        echo json_encode(getGoogleSpend($account_id, $date_from, $date_to, $debug));
        break;
    case 'tiktok':
        echo json_encode(['error' => 'TikTok Ads — próximamente', 'platform' => 'tiktok']);
        break;
    default:
        http_response_code(400);
        echo json_encode(['error' => "Plataforma no soportada: {$platform}"]);
}

// ─── GOOGLE ADS ──────────────────────────────────────────────────────────────

function getGoogleAccessToken(): array {
    if (!defined('GOOGLE_CLIENT_ID') || !defined('GOOGLE_CLIENT_SECRET') || !defined('GOOGLE_REFRESH_TOKEN')) {
        return ['error' => 'Credenciales de Google Ads no configuradas en config.php'];
    }
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => 'https://oauth2.googleapis.com/token',
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => http_build_query([
            'client_id'     => GOOGLE_CLIENT_ID,
            'client_secret' => GOOGLE_CLIENT_SECRET,
            'refresh_token' => GOOGLE_REFRESH_TOKEN,
            'grant_type'    => 'refresh_token',
        ]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
    ]);
    $response = curl_exec($ch);
    $curl_err = curl_error($ch);
    curl_close($ch);
    if ($curl_err) return ['error' => "cURL error obteniendo token: {$curl_err}"];
    $data = json_decode($response, true);
    if (isset($data['error'])) return ['error' => "OAuth error: {$data['error_description']}"];
    return $data;
}

function getGoogleSpend(string $customer_id, string $date_from, string $date_to, bool $debug = false): array {
    if (!defined('GOOGLE_DEVELOPER_TOKEN') || !defined('GOOGLE_MCC_ID')) {
        return ['error' => 'GOOGLE_DEVELOPER_TOKEN o GOOGLE_MCC_ID no configurados en config.php', 'platform' => 'google'];
    }

    $token = getGoogleAccessToken();
    if (isset($token['error'])) {
        return ['error' => $token['error'], 'platform' => 'google'];
    }

    // Customer ID sin guiones para la URL
    $cid = preg_replace('/[^0-9]/', '', $customer_id);
    $mcc = preg_replace('/[^0-9]/', '', GOOGLE_MCC_ID);

    // campaign.id es requerido; customer.currency_code trae la moneda real de la cuenta
    $query = "SELECT campaign.id, campaign.name, campaign.status, customer.currency_code, segments.date, metrics.cost_micros
              FROM campaign
              WHERE segments.date BETWEEN '{$date_from}' AND '{$date_to}'
                AND campaign.status != 'REMOVED'
              ORDER BY segments.date ASC";

    // Probar versiones de más nueva a más antigua hasta encontrar una activa
    // v20 removida: deprecada y bloqueada por Google (devuelve UNSUPPORTED_VERSION)
    $versions     = ['v19', 'v18', 'v17'];
    $response     = null;
    $http_code    = 0;
    $curl_err     = '';
    $used_ver     = '';
    $debug_probes = []; // solo se llena cuando debug=1

    foreach ($versions as $ver) {
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => "https://googleads.googleapis.com/{$ver}/customers/{$cid}/googleAds:search",
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode(['query' => $query]),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $token['access_token'],
                'developer-token: '      . GOOGLE_DEVELOPER_TOKEN,
                'login-customer-id: '    . $mcc,
                'Content-Type: application/json',
            ],
        ]);
        $response  = curl_exec($ch);
        $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curl_err  = curl_error($ch);
        curl_close($ch);

        if ($debug) {
            $debug_probes[$ver] = ['http_code' => $http_code, 'body' => json_decode($response, true) ?? $response];
        }

        if ($curl_err) break;
        if ($http_code === 200) { $used_ver = $ver; break; }

        // Continuar al siguiente si: versión no existe (404) o está deprecada (UNSUPPORTED_VERSION)
        // Parar si es cualquier otro error real (autenticación, query inválido, etc.)
        $tmp    = json_decode($response, true);
        $reqErr = $tmp['error']['details'][0]['errors'][0]['errorCode']['requestError'] ?? '';
        if ($http_code !== 404 && $reqErr !== 'UNSUPPORTED_VERSION') { $used_ver = $ver; break; }
    }

    if ($debug && !$used_ver) {
        return [
            'debug'       => true,
            'api_version' => 'ninguna',
            'customer_id' => $cid,
            'mcc_id'      => $mcc,
            'query'       => $query,
            'probes'      => $debug_probes,
        ];
    }

    if (!$used_ver && !$curl_err) {
        return ['error' => 'Ninguna versión de Google Ads API respondió correctamente para esta cuenta', 'platform' => 'google'];
    }

    if ($curl_err) {
        return ['error' => "cURL error: {$curl_err}", 'platform' => 'google'];
    }

    $data = json_decode($response, true);

    if ($debug) {
        return [
            'debug'       => true,
            'api_version' => $used_ver ?: '404-en-todas',
            'http_code'   => $http_code,
            'customer_id' => $cid,
            'mcc_id'      => $mcc,
            'query'       => $query,
            'raw'         => $data,
        ];
    }

    if (isset($data['error'])) {
        $msg = $data['error']['message'] ?? ($data['error']['details'][0]['errors'][0]['message'] ?? 'Error desconocido de Google Ads API');
        return ['error' => $msg, 'platform' => 'google'];
    }

    // Agrupar cost_micros por día y detectar moneda real de la cuenta
    $byDate   = [];
    $currency = 'USD';
    foreach ($data['results'] ?? [] as $row) {
        $date   = $row['segments']['date']             ?? '';
        $micros = (int)($row['metrics']['costMicros']  ?? 0);
        if ($row['customer']['currencyCode'] ?? '') $currency = $row['customer']['currencyCode'];
        if ($date) $byDate[$date] = ($byDate[$date] ?? 0) + $micros;
    }

    $daily = [];
    $total = 0.0;
    foreach ($byDate as $date => $micros) {
        $spend   = round($micros / 1000000, 2);
        $total  += $spend;
        $daily[] = ['date' => $date, 'spend' => $spend];
    }
    usort($daily, fn($a, $b) => strcmp($a['date'], $b['date']));

    return [
        'platform'     => 'google',
        'account_id'   => $customer_id,
        'total_spend'  => round($total, 2),
        'currency'     => $currency,
        'daily_data'   => $daily,
        'date_from'    => $date_from,
        'date_to'      => $date_to,
        '_rows'        => count($data['results'] ?? []),
        '_api_version' => $used_ver,
    ];
}

// ─── META ADS ────────────────────────────────────────────────────────────────

function getMetaSpend(string $account_id, string $date_from, string $date_to, bool $debug = false): array {
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

    if ($debug) {
        return [
            'debug'      => true,
            'http_code'  => $http_code,
            'account_id' => $account_id,
            'raw'        => $data,
        ];
    }

    if (isset($data['error'])) {
        return [
            'error'    => $data['error']['message'] ?? 'Error desconocido de Meta API',
            'code'     => $data['error']['code']    ?? 0,
            'platform' => 'meta',
        ];
    }

    $daily    = [];
    $total    = 0.0;
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
        '_rows'       => count($data['data'] ?? []),
    ];
}
