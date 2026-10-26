<?php
// Consultas a Meta Ads y Google Ads (gasto diario, detalle por campaña, estado de cuenta).
// Compartido por api/spend.php (con sesión, Monitor de Pauta) y por
// backend/public/pauta_report_public.php (reporte del cliente por token).
// Quien lo incluye debe haber cargado antes api/config.php.
require_once __DIR__ . '/../backend/includes/google_ads_auth.php';

// Versión de la Graph API de Meta, sobreescribible desde api/config.php
if (!defined('META_GRAPH_VERSION')) {
    define('META_GRAPH_VERSION', 'v19.0');
}

// ─── GOOGLE ADS ──────────────────────────────────────────────────────────────

// El refresh token sale de la BD (botón "Conectar Google Ads" de Pauta) o, si no hay, de
// GOOGLE_REFRESH_TOKEN en este config.php. Ver backend/includes/google_ads_auth.php.
function getGoogleAccessToken(): array {
    return google_ads_access_token();
}

// ─── LLAMADA A GOOGLE ADS (compartida) ───────────────────────────────────────

// Versiones de la API de Google Ads, de más nueva a más antigua. Google retira una versión cada
// pocos meses: una versión retirada responde 404 (HTML) o UNSUPPORTED_VERSION. Se prueban en
// orden y se recuerda la que funcionó (12 h) para no repetir intentos en cada consulta.
// Si algún día todas fallan, el mensaje de error lista lo que respondió cada una: basta
// con agregar aquí la versión nueva.
// (función y no const: este archivo ejecuta su código antes de llegar a las definiciones de abajo)
function googleAdsApiVersions(): array {
    return ['v26', 'v25', 'v24', 'v23', 'v22', 'v21'];
}

function googleAdsSearchCall(string $cid, string $query, string $accessToken): array {
    $mcc       = preg_replace('/[^0-9]/', '', GOOGLE_MCC_ID);
    $cacheFile = sys_get_temp_dir() . '/pauta_google_ads_version';
    $versions  = googleAdsApiVersions();
    if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < 43200) {
        $cached = trim((string)@file_get_contents($cacheFile));
        if ($cached !== '' && in_array($cached, $versions, true)) {
            array_unshift($versions, $cached);
            $versions = array_values(array_unique($versions));
        }
    }

    $tried = [];
    foreach ($versions as $ver) {
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => "https://googleads.googleapis.com/{$ver}/customers/{$cid}/googleAds:search",
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode(['query' => $query]),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $accessToken,
                'developer-token: '      . GOOGLE_DEVELOPER_TOKEN,
                'login-customer-id: '    . $mcc,
                'Content-Type: application/json',
            ],
        ]);
        $response  = curl_exec($ch);
        $http_code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curl_err  = curl_error($ch);
        curl_close($ch);

        if ($curl_err) return ['curl_err' => $curl_err, 'tried' => $tried];

        $data   = json_decode((string)$response, true);
        $reqErr = $data['error']['details'][0]['errors'][0]['errorCode']['requestError'] ?? '';
        // Problema de VERSIÓN: 404 sin JSON (la ruta no existe) o UNSUPPORTED_VERSION.
        // Un 404/403 con JSON es un problema de la CUENTA y no se arregla cambiando de versión.
        $versionProblem = ($http_code === 404 && !is_array($data)) || $reqErr === 'UNSUPPORTED_VERSION';
        $tried[] = $ver . ':' . $http_code . ($reqErr ? '/' . $reqErr : '');
        if ($versionProblem) continue;

        @file_put_contents($cacheFile, $ver);
        return ['http_code' => $http_code, 'data' => is_array($data) ? $data : [], 'version' => $ver, 'tried' => $tried];
    }

    @unlink($cacheFile);
    return ['no_version' => true, 'tried' => $tried];
}

function googleAdsNoVersionMessage(array $call): string {
    return 'Google Ads API: ninguna versión respondió (' . implode(', ', $call['tried'] ?? []) . '). '
         . 'Si todas dicen 404, Google retiró esas versiones: hay que agregar la versión vigente en googleAdsApiVersions() (api/spend.php).';
}

// Mensaje en español para los errores de cuenta más comunes (conserva el texto original de Google)
function googleAdsFriendlyError(array $data): string {
    $orig = $data['error']['message'] ?? ($data['error']['details'][0]['errors'][0]['message'] ?? 'Error desconocido de Google Ads API');
    $code = $data['error']['details'][0]['errors'][0]['errorCode'] ?? [];
    $name = is_array($code) && $code ? (string)reset($code) : '';
    $map = [
        'USER_PERMISSION_DENIED'  => 'Sin acceso a esta cuenta: no está vinculada a tu MCC o el ID es incorrecto',
        'CUSTOMER_NOT_ENABLED'    => 'La cuenta de Google Ads está cancelada o sin facturación activa',
        'CUSTOMER_NOT_FOUND'      => 'No existe una cuenta de Google Ads con ese ID',
        'DEVELOPER_TOKEN_NOT_APPROVED' => 'El developer token de Google Ads no está aprobado para cuentas reales',
        'DEVELOPER_TOKEN_PROHIBITED'   => 'El developer token no puede usarse con esta cuenta',
        'INVALID_CUSTOMER_ID'     => 'ID de cuenta de Google Ads no válido',
    ];
    return isset($map[$name]) ? "{$map[$name]} ({$name})" : $orig;
}

function getGoogleSpend(string $customer_id, string $date_from, string $date_to, bool $debug = false): array {
    if (!defined('GOOGLE_DEVELOPER_TOKEN') || !defined('GOOGLE_MCC_ID')) {
        return ['error' => 'GOOGLE_DEVELOPER_TOKEN o GOOGLE_MCC_ID no configurados en config.php', 'platform' => 'google'];
    }

    $token = getGoogleAccessToken();
    if (isset($token['error'])) {
        return ['error' => $token['error'], 'platform' => 'google', 'reauth' => !empty($token['reauth'])];
    }

    // Customer ID sin guiones para la URL
    $cid = preg_replace('/[^0-9]/', '', $customer_id);
    $mcc = preg_replace('/[^0-9]/', '', GOOGLE_MCC_ID);

    // campaign.id es requerido; customer.currency_code trae la moneda real de la cuenta
    $query = "SELECT campaign.id, campaign.name, campaign.status, customer.currency_code, segments.date, metrics.cost_micros, metrics.conversions
              FROM campaign
              WHERE segments.date BETWEEN '{$date_from}' AND '{$date_to}'
                AND campaign.status != 'REMOVED'
              ORDER BY segments.date ASC";

    if (strlen($cid) < 8) {
        return ['error' => "ID de cuenta de Google Ads no válido (\"{$customer_id}\"): debe tener 10 dígitos", 'platform' => 'google'];
    }
    $call = googleAdsSearchCall($cid, $query, $token['access_token']);
    if (isset($call['curl_err']))      return ['error' => "cURL error: {$call['curl_err']}", 'platform' => 'google'];
    if (!empty($call['no_version']))   return ['error' => googleAdsNoVersionMessage($call), 'platform' => 'google'];
    $used_ver  = $call['version'];
    $http_code = $call['http_code'];
    $data      = $call['data'];

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
        return ['error' => googleAdsFriendlyError($data), 'platform' => 'google'];
    }

    // Agrupar cost_micros por día y detectar moneda real de la cuenta
    $byDate   = [];
    $leadsByDate = [];
    $currency = 'USD';
    foreach ($data['results'] ?? [] as $row) {
        $date   = $row['segments']['date']             ?? '';
        $micros = (int)($row['metrics']['costMicros']  ?? 0);
        if ($row['customer']['currencyCode'] ?? '') $currency = $row['customer']['currencyCode'];
        if ($date) {
            $byDate[$date] = ($byDate[$date] ?? 0) + $micros;
            $leadsByDate[$date] = ($leadsByDate[$date] ?? 0) + (float)($row['metrics']['conversions'] ?? 0);
        }
    }

    $daily = [];
    $total = 0.0;
    foreach ($byDate as $date => $micros) {
        $spend   = round($micros / 1000000, 2);
        $total  += $spend;
        $daily[] = ['date' => $date, 'spend' => $spend, 'leads' => round($leadsByDate[$date] ?? 0, 1)];
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

// Misma definición de "lead" que el detalle por campaña (getMetaCampaignDetail).
function metaLeadsFromActions(array $actions): int {
    $types = ['lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped', 'onsite_conversion.messaging_conversation_started_7d'];
    $n = 0;
    foreach ($actions as $act) {
        if (in_array($act['action_type'] ?? '', $types, true)) $n += (int)($act['value'] ?? 0);
    }
    return $n;
}

function getMetaSpend(string $account_id, string $date_from, string $date_to, bool $debug = false): array {
    if (!defined('META_ACCESS_TOKEN') || META_ACCESS_TOKEN === 'YOUR_META_SYSTEM_USER_TOKEN_HERE') {
        return ['error' => 'Meta Access Token no configurado en config.php'];
    }

    $token      = META_ACCESS_TOKEN;
    $time_range = json_encode(['since' => $date_from, 'until' => $date_to]);
    $fields     = 'spend,date_start,date_stop,account_name,account_currency,actions';

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
        $daily[]  = ['date' => $row['date_start'], 'spend' => $spend, 'leads' => metaLeadsFromActions($row['actions'] ?? [])];
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
    if (isset($token['error'])) return ['error' => $token['error'], 'platform' => 'google', 'reauth' => !empty($token['reauth'])];

    $cid = preg_replace('/[^0-9]/', '', $customer_id);
    $mcc = preg_replace('/[^0-9]/', '', GOOGLE_MCC_ID);

    // Sin segments.date en SELECT → devuelve totales del período por campaña
    $query = "SELECT campaign.id, campaign.name, campaign.status, customer.currency_code,
                     metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
              FROM campaign
              WHERE segments.date BETWEEN '{$date_from}' AND '{$date_to}'
                AND campaign.status != 'REMOVED'";

    $call = googleAdsSearchCall($cid, $query, $token['access_token']);
    if (isset($call['curl_err']))    return ['error' => "cURL error: {$call['curl_err']}", 'platform' => 'google'];
    if (!empty($call['no_version'])) return ['error' => googleAdsNoVersionMessage($call), 'platform' => 'google'];
    $used_ver  = $call['version'];
    $http_code = $call['http_code'];
    $data      = $call['data'];
    if ($debug) return ['debug' => true, 'http_code' => $http_code, 'api_version' => $used_ver, 'raw' => $data];
    if (isset($data['error'])) {
        return ['error' => googleAdsFriendlyError($data), 'platform' => 'google'];
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

// ─── ESTADO DE CUENTA (pausas por pago / presupuesto) ────────────────────────
// Respuesta normalizada para Pauta:
//   state: ok | warn | review | budget | payment | disabled
//   reason: explicación en español · billing_url: dónde resolverlo

function metaGraphGet(string $url, string $token): array {
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $token],
    ]);
    $response = curl_exec($ch);
    $curl_err = curl_error($ch);
    curl_close($ch);
    if ($curl_err) return ['error' => ['message' => "cURL error: {$curl_err}"]];
    $data = json_decode((string)$response, true);
    return is_array($data) ? $data : ['error' => ['message' => 'Respuesta no válida de Meta']];
}

function getMetaAccountStatus(string $account_id, bool $debug = false): array {
    if (!defined('META_ACCESS_TOKEN') || META_ACCESS_TOKEN === 'YOUR_META_SYSTEM_USER_TOKEN_HERE') {
        return ['error' => 'Meta Access Token no configurado en config.php', 'platform' => 'meta'];
    }
    // funding_source_details puede no estar permitido para el token: si falla, se reintenta sin él
    $fieldSets = [
        'name,account_status,disable_reason,spend_cap,amount_spent,currency,is_prepay_account,funding_source_details',
        'name,account_status,disable_reason,spend_cap,amount_spent,currency,is_prepay_account',
    ];
    $d = null;
    foreach ($fieldSets as $fields) {
        $url = sprintf('https://graph.facebook.com/%s/%s?fields=%s', META_GRAPH_VERSION, urlencode($account_id), urlencode($fields));
        $d = metaGraphGet($url, META_ACCESS_TOKEN);
        if (!isset($d['error'])) break;
    }
    if ($debug) return ['debug' => true, 'raw' => $d];
    if (isset($d['error'])) {
        return ['error' => $d['error']['message'] ?? 'Error desconocido de Meta API', 'platform' => 'meta'];
    }

    $status  = (int)($d['account_status'] ?? 0);
    $disable = (int)($d['disable_reason'] ?? 0);
    $cap     = (float)($d['spend_cap'] ?? 0);     // 0 = sin límite de gasto de cuenta
    $spent   = (float)($d['amount_spent'] ?? 0);  // misma unidad que spend_cap
    $funding = $d['funding_source_details']['display_string'] ?? null;
    $prepaid = !empty($d['is_prepay_account']);

    $DISABLE_REASONS = [
        1 => 'incumplimiento de políticas de anuncios', 2 => 'revisión de propiedad intelectual', 3 => 'problema con el método de pago',
        4 => 'cuenta cerrada por Meta', 5 => 'revisión de la cuenta', 6 => 'integridad del negocio',
        7 => 'cierre permanente', 8 => 'cuenta de revendedor sin uso', 9 => 'cuenta sin uso',
    ];

    $state = 'ok';
    $reason = '';
    switch ($status) {
        case 3: // UNSETTLED
        case 8: // PENDING_SETTLEMENT
            $state  = 'payment';
            $reason = 'Pago pendiente: la cuenta tiene un saldo sin pagar y los anuncios pueden estar detenidos.';
            break;
        case 9: // IN_GRACE_PERIOD
            $state  = 'payment';
            $reason = 'El cobro falló: la cuenta está en período de gracia y los anuncios se detendrán si no se paga.';
            break;
        case 2: // DISABLED
            $state  = $disable === 3 ? 'payment' : 'disabled';
            $reason = 'Cuenta publicitaria deshabilitada por Meta' . (isset($DISABLE_REASONS[$disable]) ? ': ' . $DISABLE_REASONS[$disable] : '') . '.';
            break;
        case 7: // PENDING_RISK_REVIEW
            $state  = 'review';
            $reason = 'Meta tiene la cuenta en revisión de riesgo; los anuncios pueden no publicarse.';
            break;
        case 100: // PENDING_CLOSURE
        case 101: // CLOSED
            $state  = 'disabled';
            $reason = 'La cuenta publicitaria está cerrada o en proceso de cierre.';
            break;
    }

    // Prepago con saldo en cero (solo si Meta muestra el saldo y es exactamente 0)
    if ($state === 'ok' && $prepaid && $funding && preg_match('/[\d][\d.,]*/', $funding, $m) && (int)preg_replace('/\D/', '', $m[0]) === 0) {
        $state  = 'payment';
        $reason = 'El saldo prepago de la cuenta se agotó: hay que recargar para que los anuncios sigan.';
    }

    $capPct = $cap > 0 ? round($spent / $cap * 100, 1) : null;
    if ($state === 'ok' && $cap > 0) {
        if ($spent >= $cap) {
            $state  = 'budget';
            $reason = 'Se alcanzó el límite de gasto de la cuenta: los anuncios están detenidos hasta subirlo o reiniciarlo.';
        } elseif ($capPct >= 90) {
            $state  = 'warn';
            $reason = "La cuenta va en {$capPct}% de su límite de gasto: pronto se detendrán los anuncios.";
        }
    }

    $numericId = preg_replace('/\D/', '', $account_id);
    return [
        'platform'      => 'meta',
        'account_id'    => $account_id,
        'account_name'  => $d['name'] ?? null,
        'state'         => $state,
        'reason'        => $reason,
        'prepaid'       => $prepaid,
        'funding'       => $funding,
        'spend_cap_pct' => $capPct,
        'billing_url'   => "https://business.facebook.com/billing_hub/accounts/details?asset_id={$numericId}",
    ];
}

// Una consulta GAQL contra Google Ads (usa googleAdsSearchCall: prueba versiones y recuerda la vigente)
function googleAdsSearch(string $cid, string $query, string $accessToken): array {
    $call = googleAdsSearchCall($cid, $query, $accessToken);
    if (isset($call['curl_err']))    return ['error' => "cURL error: {$call['curl_err']}"];
    if (!empty($call['no_version'])) return ['error' => googleAdsNoVersionMessage($call)];
    if (isset($call['data']['error'])) return ['error' => googleAdsFriendlyError($call['data'])];
    return ['results' => $call['data']['results'] ?? []];
}

function getGoogleAccountStatus(string $customer_id, bool $debug = false): array {
    if (!defined('GOOGLE_DEVELOPER_TOKEN') || !defined('GOOGLE_MCC_ID')) {
        return ['error' => 'GOOGLE_DEVELOPER_TOKEN o GOOGLE_MCC_ID no configurados en config.php', 'platform' => 'google'];
    }
    $token = getGoogleAccessToken();
    if (isset($token['error'])) return ['error' => $token['error'], 'platform' => 'google', 'reauth' => !empty($token['reauth'])];

    $cid = preg_replace('/[^0-9]/', '', $customer_id);
    $cust = googleAdsSearch($cid, 'SELECT customer.status, customer.descriptive_name FROM customer LIMIT 1', $token['access_token']);
    if (isset($cust['error'])) return ['error' => $cust['error'], 'platform' => 'google'];

    // Presupuesto de cuenta (solo existe con facturación mensual / orden de compra)
    $budget = googleAdsSearch($cid,
        "SELECT account_budget.status, account_budget.approved_spending_limit_micros, account_budget.approved_spending_limit_type,
                account_budget.amount_served_micros, account_budget.approved_end_date_time
         FROM account_budget WHERE account_budget.status = 'APPROVED'", $token['access_token']);

    if ($debug) return ['debug' => true, 'customer' => $cust, 'account_budget' => $budget];

    $c      = $cust['results'][0]['customer'] ?? [];
    $status = $c['status'] ?? 'UNKNOWN';
    $state  = 'ok';
    $reason = '';
    if ($status === 'SUSPENDED') {
        $state  = 'disabled';
        $reason = 'Google suspendió la cuenta: revisa la facturación o las políticas en Google Ads.';
    } elseif (in_array($status, ['CANCELED', 'CLOSED'], true)) {
        $state  = 'disabled';
        $reason = 'La cuenta de Google Ads está cancelada o cerrada.';
    }

    $budgetPct = null;
    if ($state === 'ok' && empty($budget['error'])) {
        $now = time();
        foreach ($budget['results'] as $row) {
            $b   = $row['accountBudget'] ?? [];
            $end = $b['approvedEndDateTime'] ?? null;
            if ($end && strtotime($end) !== false && strtotime($end) < $now) continue;      // ya terminó
            if (($b['approvedSpendingLimitType'] ?? '') === 'INFINITE') continue;           // sin tope
            $limit  = (float)($b['approvedSpendingLimitMicros'] ?? 0);
            $served = (float)($b['amountServedMicros'] ?? 0);
            if ($limit <= 0) continue;
            $budgetPct = round($served / $limit * 100, 1);
            if ($served >= $limit) {
                $state  = 'budget';
                $reason = 'Se agotó el presupuesto de la cuenta (facturación mensual): los anuncios están detenidos.';
            } elseif ($budgetPct >= 90) {
                $state  = 'warn';
                $reason = "La cuenta va en {$budgetPct}% de su presupuesto de cuenta.";
            }
            break;
        }
    }

    return [
        'platform'     => 'google',
        'account_id'   => $customer_id,
        'account_name' => $c['descriptiveName'] ?? null,
        'state'        => $state,
        'reason'       => $reason,
        'budget_pct'   => $budgetPct,
        'billing_url'  => 'https://ads.google.com/aw/billing/summary',
    ];
}
