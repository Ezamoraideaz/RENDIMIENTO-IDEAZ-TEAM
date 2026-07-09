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

// Versión de la Graph API de Meta, sobreescribible desde api/config.php
if (!defined('META_GRAPH_VERSION')) {
    define('META_GRAPH_VERSION', 'v19.0');
}

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
    // v17/v18/v19: eliminadas del servidor Google (devuelven HTML 404)
    // v20: bloqueada con UNSUPPORTED_VERSION
    // v21/v22: versiones activas en Jun 2026
    $versions  = ['v22', 'v21'];
    $response  = null;
    $http_code = 0;
    $curl_err  = '';
    $used_ver  = '';

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

        if ($curl_err) break;
        if ($http_code === 200) { $used_ver = $ver; break; }

        // Continuar al siguiente si: versión no existe (404) o está deprecada (UNSUPPORTED_VERSION)
        // Parar si es cualquier otro error real (autenticación, query inválido, etc.)
        $tmp    = json_decode($response, true);
        $reqErr = $tmp['error']['details'][0]['errors'][0]['errorCode']['requestError'] ?? '';
        if ($http_code !== 404 && $reqErr !== 'UNSUPPORTED_VERSION') { $used_ver = $ver; break; }
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

// GET a la Graph API con el token en el header Authorization (no en la URL, para
// que no quede en logs) y siguiendo la paginación completa: sin esto Meta corta
// en 25 filas por defecto y los totales diarios de meses largos salen incompletos.
function metaGraphGetAll(string $url, string $token, bool $debug = false): array {
    $rows      = [];
    $firstPage = null;
    $http_code = 0;
    $guard     = 0;

    while ($url && $guard < 10) {
        $guard++;
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $token],
        ]);
        $response  = curl_exec($ch);
        $curl_err  = curl_error($ch);
        $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($curl_err) {
            return ['curl_error' => $curl_err];
        }

        $data = json_decode($response, true);
        if ($firstPage === null) $firstPage = $data;

        if ($debug || isset($data['error'])) {
            return ['http_code' => $http_code, 'raw' => $data, 'rows' => $rows];
        }

        $rows = array_merge($rows, $data['data'] ?? []);
        $url  = $data['paging']['next'] ?? null;
    }

    return ['http_code' => $http_code, 'raw' => $firstPage, 'rows' => $rows];
}

function getMetaSpend(string $account_id, string $date_from, string $date_to, bool $debug = false): array {
    if (!defined('META_ACCESS_TOKEN') || META_ACCESS_TOKEN === 'YOUR_META_SYSTEM_USER_TOKEN_HERE') {
        return ['error' => 'Meta Access Token no configurado en config.php'];
    }

    $token      = META_ACCESS_TOKEN;
    $time_range = json_encode(['since' => $date_from, 'until' => $date_to]);
    $fields     = 'spend,date_start,date_stop,account_name,account_currency';

    $url = sprintf(
        'https://graph.facebook.com/%s/%s/insights?fields=%s&time_range=%s&time_increment=1&limit=500',
        META_GRAPH_VERSION,
        urlencode($account_id),
        urlencode($fields),
        urlencode($time_range)
    );

    $res = metaGraphGetAll($url, $token, $debug);

    if (isset($res['curl_error'])) {
        return ['error' => "cURL error: {$res['curl_error']}", 'platform' => 'meta'];
    }

    if ($debug) {
        return [
            'debug'      => true,
            'http_code'  => $res['http_code'],
            'account_id' => $account_id,
            'raw'        => $res['raw'],
        ];
    }

    if (isset($res['raw']['error'])) {
        return [
            'error'    => $res['raw']['error']['message'] ?? 'Error desconocido de Meta API',
            'code'     => $res['raw']['error']['code']    ?? 0,
            'platform' => 'meta',
        ];
    }

    $daily    = [];
    $total    = 0.0;
    $currency = 'USD';

    foreach ($res['rows'] as $row) {
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

// ─── HELPERS DETALLE ─────────────────────────────────────────────────────────

function detectFunnelStage(string $name): string {
    $n = strtolower($name);
    if (preg_match('/\bf1\b|\[f1\]|\-f1\-|_f1_|\btof\b/', $n)) return 'tof';
    if (preg_match('/\bf2\b|\[f2\]|\-f2\-|_f2_|\bmof\b/', $n)) return 'mof';
    if (preg_match('/\bf3\b|\[f3\]|\-f3\-|_f3_|\bbof\b/', $n)) return 'bof';
    return 'other';
}

// ─── META ADS DETALLE (nivel campaña) ────────────────────────────────────────

function getMetaCampaignDetail(string $account_id, string $date_from, string $date_to, bool $debug = false): array {
    if (!defined('META_ACCESS_TOKEN') || META_ACCESS_TOKEN === 'YOUR_META_SYSTEM_USER_TOKEN_HERE') {
        return ['error' => 'Meta Access Token no configurado en config.php', 'platform' => 'meta'];
    }

    $token      = META_ACCESS_TOKEN;
    $time_range = json_encode(['since' => $date_from, 'until' => $date_to]);
    $fields     = 'campaign_id,campaign_name,spend,impressions,clicks,reach,frequency,actions,account_currency';

    $url = sprintf(
        'https://graph.facebook.com/%s/%s/insights?level=campaign&fields=%s&time_range=%s&limit=100',
        META_GRAPH_VERSION,
        urlencode($account_id),
        urlencode($fields),
        urlencode($time_range)
    );

    $res = metaGraphGetAll($url, $token, $debug);

    if (isset($res['curl_error'])) return ['error' => "cURL error: {$res['curl_error']}", 'platform' => 'meta'];

    if ($debug) return ['debug' => true, 'http_code' => $res['http_code'], 'raw' => $res['raw']];

    if (isset($res['raw']['error'])) {
        return ['error' => $res['raw']['error']['message'] ?? 'Error Meta API', 'platform' => 'meta'];
    }

    $leadActionTypes = ['lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped', 'onsite_conversion.messaging_conversation_started_7d'];
    $campaigns = [];
    $currency  = 'USD';

    foreach ($res['rows'] as $row) {
        $leads    = 0;
        $messages = 0;
        foreach ($row['actions'] ?? [] as $act) {
            if (in_array($act['action_type'], $leadActionTypes)) {
                $leads += (int)($act['value'] ?? 0);
            }
            if (strpos($act['action_type'], 'messaging') !== false || strpos($act['action_type'], 'message') !== false) {
                $messages += (int)($act['value'] ?? 0);
            }
        }
        if ($row['account_currency'] ?? '') $currency = $row['account_currency'];

        $name = $row['campaign_name'] ?? '';
        $campaigns[] = [
            'id'          => $row['campaign_id'] ?? '',
            'name'        => $name,
            'stage'       => detectFunnelStage($name),
            'spend'       => round((float)($row['spend']       ?? 0), 2),
            'impressions' => (int)($row['impressions'] ?? 0),
            'clicks'      => (int)($row['clicks']      ?? 0),
            'reach'       => (int)($row['reach']       ?? 0),
            'frequency'   => round((float)($row['frequency'] ?? 0), 2),
            'leads'       => $leads,
            'messages'    => $messages,
        ];
    }

    usort($campaigns, fn($a, $b) => strcmp($a['stage'], $b['stage']));

    return [
        'platform'   => 'meta',
        'account_id' => $account_id,
        'currency'   => $currency,
        'campaigns'  => $campaigns,
        'date_from'  => $date_from,
        'date_to'    => $date_to,
    ];
}

// ─── GOOGLE ADS DETALLE (nivel campaña) ──────────────────────────────────────

function getGoogleCampaignDetail(string $customer_id, string $date_from, string $date_to, bool $debug = false): array {
    if (!defined('GOOGLE_DEVELOPER_TOKEN') || !defined('GOOGLE_MCC_ID')) {
        return ['error' => 'GOOGLE_DEVELOPER_TOKEN o GOOGLE_MCC_ID no configurados', 'platform' => 'google'];
    }

    $token = getGoogleAccessToken();
    if (isset($token['error'])) return ['error' => $token['error'], 'platform' => 'google'];

    $cid = preg_replace('/[^0-9]/', '', $customer_id);
    $mcc = preg_replace('/[^0-9]/', '', GOOGLE_MCC_ID);

    // Sin segments.date en SELECT → devuelve totales del período por campaña
    $query = "SELECT campaign.id, campaign.name, campaign.status, customer.currency_code,
                     metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
              FROM campaign
              WHERE segments.date BETWEEN '{$date_from}' AND '{$date_to}'
                AND campaign.status != 'REMOVED'";

    $versions = ['v22', 'v21'];
    $response = null; $http_code = 0; $curl_err = ''; $used_ver = '';

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
        if ($curl_err) break;
        if ($http_code === 200) { $used_ver = $ver; break; }
        $tmp    = json_decode($response, true);
        $reqErr = $tmp['error']['details'][0]['errors'][0]['errorCode']['requestError'] ?? '';
        if ($http_code !== 404 && $reqErr !== 'UNSUPPORTED_VERSION') { $used_ver = $ver; break; }
    }

    if ($curl_err) return ['error' => "cURL error: {$curl_err}", 'platform' => 'google'];

    $data = json_decode($response, true);
    if ($debug) return ['debug' => true, 'http_code' => $http_code, 'api_version' => $used_ver, 'raw' => $data];
    if (isset($data['error'])) {
        $msg = $data['error']['message'] ?? 'Error Google Ads API';
        return ['error' => $msg, 'platform' => 'google'];
    }

    // Agregar por campaña (la query puede devolver filas por día)
    $bycamp   = [];
    $currency = 'USD';
    foreach ($data['results'] ?? [] as $row) {
        $id   = $row['campaign']['id']   ?? '';
        $name = $row['campaign']['name'] ?? '';
        if ($row['customer']['currencyCode'] ?? '') $currency = $row['customer']['currencyCode'];
        if (!isset($bycamp[$id])) {
            $bycamp[$id] = [
                'id'           => $id,
                'name'         => $name,
                'stage'        => detectFunnelStage($name),
                'cost_micros'  => 0,
                'impressions'  => 0,
                'clicks'       => 0,
                'leads'        => 0.0,
                'reach'        => 0,
            ];
        }
        // Acumular en micros y convertir al final: redondear fila por fila acumula error
        $bycamp[$id]['cost_micros'] += (int)($row['metrics']['costMicros'] ?? 0);
        $bycamp[$id]['impressions'] += (int)($row['metrics']['impressions'] ?? 0);
        $bycamp[$id]['clicks']      += (int)($row['metrics']['clicks']      ?? 0);
        $bycamp[$id]['leads']       += (float)($row['metrics']['conversions'] ?? 0);
    }

    foreach ($bycamp as &$camp) {
        $camp['spend'] = round($camp['cost_micros'] / 1000000, 2);
        $camp['leads'] = round($camp['leads'], 1);
        unset($camp['cost_micros']);
    }
    unset($camp);

    $campaigns = array_values($bycamp);
    usort($campaigns, fn($a, $b) => strcmp($a['stage'], $b['stage']));

    return [
        'platform'    => 'google',
        'account_id'  => $customer_id,
        'currency'    => $currency,
        'campaigns'   => $campaigns,
        'date_from'   => $date_from,
        'date_to'     => $date_to,
        '_api_version' => $used_ver,
    ];
}
