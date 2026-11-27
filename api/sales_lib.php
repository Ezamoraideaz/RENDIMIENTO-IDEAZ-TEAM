<?php
// Compras y leads por campaña para marcas con objetivo "Ventas" o "Ambos" (ecommerce).
// Archivo aparte de spend_lib.php a propósito: solo se carga con platform=meta_sales o
// google_sales, así no afecta las consultas de las demás marcas.
// Requiere spend_lib.php ya incluido.

// Una campaña es "ventas" si generó compras, "leads" si generó leads o mensajes. Sin
// resultados todavía, se usa su objetivo (Meta); si no se puede saber, "otras".
function salesCampaignType(float $purchases, float $leads, string $objective = ''): string {
    if ($purchases > 0) return 'sales';
    if ($leads > 0) return 'leads';
    if (in_array($objective, ['OUTCOME_SALES', 'CONVERSIONS', 'PRODUCT_CATALOG_SALES'], true)) return 'sales';
    if (in_array($objective, ['OUTCOME_LEADS', 'LEAD_GENERATION', 'MESSAGES'], true)) return 'leads';
    return 'other';
}

// "omni_purchase" ya agrupa web + app + tienda: sumarlo con sus partes duplicaría las compras
function salesMetaPurchase(array $actions): float {
    $v = [];
    foreach ($actions as $a) {
        $v[$a['action_type'] ?? ''] = (float)($a['value'] ?? 0);
    }
    foreach (['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'] as $type) {
        if (isset($v[$type])) return $v[$type];
    }
    return 0.0;
}

function getMetaSales(string $account_id, string $date_from, string $date_to): array {
    if (!defined('META_ACCESS_TOKEN') || META_ACCESS_TOKEN === 'YOUR_META_SYSTEM_USER_TOKEN_HERE') {
        return ['error' => 'Meta Access Token no configurado en config.php', 'platform' => 'meta'];
    }
    $url = sprintf(
        'https://graph.facebook.com/%s/%s/insights?level=campaign&fields=%s&time_range=%s&limit=200',
        META_GRAPH_VERSION,
        urlencode($account_id),
        urlencode('campaign_id,campaign_name,objective,spend,actions,action_values,account_currency'),
        urlencode(json_encode(['since' => $date_from, 'until' => $date_to]))
    );
    $res = metaGraphGetAll($url, META_ACCESS_TOKEN, false);
    if (isset($res['curl_error'])) return ['error' => "cURL error: {$res['curl_error']}", 'platform' => 'meta'];
    if (isset($res['raw']['error'])) return ['error' => $res['raw']['error']['message'] ?? 'Error Meta API', 'platform' => 'meta'];

    $campaigns = [];
    $currency  = '';
    foreach ($res['rows'] as $row) {
        $currency  = $row['account_currency'] ?? $currency;
        $purchases = salesMetaPurchase($row['actions'] ?? []);
        $leads     = metaLeadsFromActions($row['actions'] ?? []);
        $campaigns[] = [
            'name'      => $row['campaign_name'] ?? '',
            'type'      => salesCampaignType($purchases, $leads, (string)($row['objective'] ?? '')),
            'spend'     => round((float)($row['spend'] ?? 0), 2),
            'purchases' => $purchases,
            'value'     => round(salesMetaPurchase($row['action_values'] ?? []), 2),
            'leads'     => $leads,
        ];
    }
    return ['platform' => 'meta', 'currency' => $currency, 'campaigns' => $campaigns];
}

function getGoogleSales(string $customer_id, string $date_from, string $date_to): array {
    $token = getGoogleAccessToken();
    if (isset($token['error'])) return ['error' => $token['error'], 'platform' => 'google'];
    $cid = preg_replace('/[^0-9]/', '', $customer_id);
    if (strlen($cid) < 8) return ['error' => 'ID de cuenta de Google Ads no válido', 'platform' => 'google'];

    $where = "WHERE segments.date BETWEEN '{$date_from}' AND '{$date_to}' AND campaign.status != 'REMOVED'";
    $run = function (string $query) use ($cid, $token): array {
        $call = googleAdsSearchCall($cid, $query, $token['access_token']);
        if (isset($call['curl_err']))    return ['error' => "cURL error: {$call['curl_err']}"];
        if (!empty($call['no_version'])) return ['error' => googleAdsNoVersionMessage($call)];
        if (isset($call['data']['error'])) return ['error' => googleAdsFriendlyError($call['data'])];
        return ['rows' => $call['data']['results'] ?? []];
    };

    // Dos consultas: Google no permite pedir el costo separado por tipo de conversión
    $totals = $run("SELECT campaign.id, campaign.name, customer.currency_code, metrics.cost_micros, metrics.conversions FROM campaign $where");
    if (isset($totals['error'])) return ['error' => $totals['error'], 'platform' => 'google'];
    $byType = $run("SELECT campaign.id, segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM campaign $where");
    if (isset($byType['error'])) return ['error' => $byType['error'], 'platform' => 'google'];

    $purchases = [];
    $values    = [];
    foreach ($byType['rows'] as $row) {
        if (($row['segments']['conversionActionCategory'] ?? '') !== 'PURCHASE') continue;
        $id = $row['campaign']['id'] ?? '';
        $purchases[$id] = ($purchases[$id] ?? 0) + (float)($row['metrics']['conversions'] ?? 0);
        $values[$id]    = ($values[$id] ?? 0) + (float)($row['metrics']['conversionsValue'] ?? 0);
    }

    $campaigns = [];
    $currency  = '';
    foreach ($totals['rows'] as $row) {
        $id       = $row['campaign']['id'] ?? '';
        $currency = $row['customer']['currencyCode'] ?? $currency;
        $spend    = (int)($row['metrics']['costMicros'] ?? 0) / 1000000;
        $bought   = $purchases[$id] ?? 0;
        // Leads = conversiones que no son compras
        $leads    = max(0, (float)($row['metrics']['conversions'] ?? 0) - $bought);
        if ($spend <= 0 && $bought <= 0 && $leads <= 0) continue;
        $campaigns[] = [
            'name'      => $row['campaign']['name'] ?? '',
            'type'      => salesCampaignType($bought, $leads),
            'spend'     => round($spend, 2),
            'purchases' => round($bought, 1),
            'value'     => round($values[$id] ?? 0, 2),
            'leads'     => round($leads, 1),
        ];
    }
    return ['platform' => 'google', 'currency' => $currency, 'campaigns' => $campaigns];
}
