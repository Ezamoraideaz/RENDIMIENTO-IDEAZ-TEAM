<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Reporte de pauta para el cliente final (reporte-pauta.html?t=<token>). Sin sesión ni CSRF:
// se autentica solo con el token del link (en BD solo su hash), igual que organic_leads_public.php.
// Devuelve cifras ya agregadas — nunca IDs de cuenta, tokens ni datos de otros clientes.

$apiConfig = __DIR__ . '/../../api/config.php';
if (!file_exists($apiConfig)) {
    json_error('Reporte no disponible por ahora', 503);
}
require_once $apiConfig;
require_once __DIR__ . '/../../api/spend_lib.php';

$rawToken = trim((string)($_GET['t'] ?? ''));
if ($rawToken === '') {
    json_error('Falta el token', 400);
}
$tokenHash = hash('sha256', $rawToken);

$pdo = db();
$stmt = $pdo->prepare('SELECT l.*, c.name AS client_name, c.budgets, c.platforms
                       FROM pauta_report_links l JOIN pauta_clients c ON c.id = l.pauta_client_id
                       WHERE l.token_hash = ?');
$stmt->execute([$tokenHash]);
$link = $stmt->fetch();
if (!$link) {
    json_error('Este link ya no está disponible', 404);
}

// ── Período ──────────────────────────────────────────────────────────────────
$today  = bogota_today();
$preset = 'custom';
if ($link['mode'] === 'range') {
    $from = $link['date_from'];
    $to   = $link['date_to'];
} else {
    // En tiempo real el cliente puede alternar entre períodos predefinidos (no fechas libres).
    $preset = $_GET['range'] ?? 'month';
    if ($preset === 'prev_month') {
        $from = date('Y-m-01', strtotime(substr($today, 0, 8) . '01 -1 month'));
        $to   = date('Y-m-t', strtotime($from));
    } elseif ($preset === 'last30') {
        $from = date('Y-m-d', strtotime($today . ' -29 days'));
        $to   = $today;
    } else {
        $preset = 'month';
        $from = substr($today, 0, 8) . '01';
        $to   = $today;
    }
}
if ($link['mode'] === 'live' && $to > $today) {
    $to = $today;
}

// Presupuesto prorrateado del período (misma lógica que _budgetForRange de js/pauta.js).
function report_budget(array $budgets, string $from, string $to): float
{
    $total  = 0.0;
    $start  = new DateTime($from);
    $end    = new DateTime($to);
    $cursor = new DateTime($start->format('Y-m-01'));
    while ($cursor <= $end) {
        $mk     = $cursor->format('Y-m');
        $dim    = (int)$cursor->format('t');
        $mEnd   = new DateTime($cursor->format('Y-m-t'));
        $rStart = $start > $cursor ? $start : $cursor;
        $rEnd   = $end < $mEnd ? $end : $mEnd;
        $days   = (int)$rStart->diff($rEnd)->days + 1;
        $total += ((float)($budgets[$mk] ?? 0) / $dim) * $days;
        $cursor->modify('first day of next month');
    }
    return round($total, 2);
}

// ── Caché (protege el rate-limit de Meta/Google; el cliente puede recargar a voluntad) ──
$ttl       = $to < $today ? 3600 : 600;
$cacheFile = sys_get_temp_dir() . '/pauta_report_' . md5($tokenHash . $from . $to);
if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < $ttl) {
    header('Content-Type: application/json; charset=utf-8');
    readfile($cacheFile);
    exit;
}

// ── Datos de las plataformas ─────────────────────────────────────────────────
$platforms = json_decode((string)$link['platforms'], true) ?: [];
$budgets   = json_decode((string)$link['budgets'], true) ?: [];

$daily      = [];   // date => [spend, leads]
$campaigns  = [];
$content    = ['meta' => [], 'google' => []];   // anuncios destacados con su creativo
$platTotals = [];
$currencies = [];
$errors     = 0;

// Período anterior de la misma duración (ej. 1–26 oct → 5–30 sep) para contar la historia en
// contraste: "+18% más interesados que el período anterior". Solo se pide el gasto diario
// (trae leads por día), no el detalle por campaña: una llamada extra por cuenta.
$periodDays = (int)(new DateTime($from))->diff(new DateTime($to))->days + 1;
$prevTo     = date('Y-m-d', strtotime($from . ' -1 day'));
$prevFrom   = date('Y-m-d', strtotime($prevTo . ' -' . ($periodDays - 1) . ' days'));
$prev       = ['spend' => 0.0, 'leads' => 0.0, 'ok' => true];

$labels = ['meta' => 'Meta Ads', 'google' => 'Google Ads'];
foreach ($platforms as $plat) {
    $key = $plat['platform'] ?? '';
    if (empty($plat['enabled']) || !isset($labels[$key])) continue;
    // Igual que _accountIdOf() de js/pauta.js: el primer campo no vacío (un "" no debe tapar al siguiente).
    $rawIds = '';
    foreach (['account_id', 'customer_id', 'advertiser_id'] as $f) {
        if (trim((string)($plat[$f] ?? '')) !== '') { $rawIds = (string)$plat[$f]; break; }
    }
    $accountIds = array_filter(array_map('trim', explode(',', $rawIds)));

    foreach ($accountIds as $accId) {
        $spendRes  = $key === 'meta' ? getMetaSpend($accId, $from, $to) : getGoogleSpend($accId, $from, $to);
        $detailRes = $key === 'meta' ? getMetaCampaignDetail($accId, $from, $to) : getGoogleCampaignDetail($accId, $from, $to);
        $prevRes   = $key === 'meta' ? getMetaSpend($accId, $prevFrom, $prevTo) : getGoogleSpend($accId, $prevFrom, $prevTo);
        if (empty($prevRes['error'])) {
            $prev['spend'] += (float)($prevRes['total_spend'] ?? 0);
            foreach ($prevRes['daily_data'] ?? [] as $d) $prev['leads'] += (float)($d['leads'] ?? 0);
        } else {
            $prev['ok'] = false;
        }
        if (!empty($spendRes['error'])) { $errors++; continue; }

        if (!isset($platTotals[$key])) {
            $platTotals[$key] = ['key' => $key, 'label' => $labels[$key], 'spend' => 0.0, 'leads' => 0.0, 'impressions' => 0, 'clicks' => 0, 'currency' => $spendRes['currency'] ?? ''];
        }
        $platTotals[$key]['spend'] += (float)($spendRes['total_spend'] ?? 0);
        if (!empty($spendRes['currency'])) $currencies[$spendRes['currency']] = true;

        foreach ($spendRes['daily_data'] ?? [] as $d) {
            $daily[$d['date']] = $daily[$d['date']] ?? ['spend' => 0.0, 'leads' => 0.0];
            $daily[$d['date']]['spend'] += (float)$d['spend'];
            $daily[$d['date']]['leads'] += (float)($d['leads'] ?? 0);
        }

        // Contenidos destacados: opcionales, si fallan el reporte sale igual (sin contarlo como parcial)
        $topRes = $key === 'meta' ? getMetaTopAds($accId, $from, $to) : getGoogleTopAds($accId, $from, $to);
        foreach ($topRes['ads'] ?? [] as $ad) $content[$key][] = $ad;

        if (!empty($detailRes['error'])) { $errors++; continue; }
        foreach ($detailRes['campaigns'] ?? [] as $c) {
            $platTotals[$key]['impressions'] += (int)($c['impressions'] ?? 0);
            $platTotals[$key]['clicks']      += (int)($c['clicks'] ?? 0);
            $platTotals[$key]['leads']       += (float)($c['leads'] ?? 0);
            $campaigns[] = [
                'name'        => (string)($c['name'] ?? ''),
                'platform'    => $key,
                'stage'       => (string)($c['stage'] ?? 'other'),
                'spend'       => (float)($c['spend'] ?? 0),
                'impressions' => (int)($c['impressions'] ?? 0),
                'clicks'      => (int)($c['clicks'] ?? 0),
                'leads'       => (float)($c['leads'] ?? 0),
            ];
        }
    }
}

ksort($daily);
$dailyOut = [];
foreach ($daily as $date => $v) {
    $dailyOut[] = ['date' => $date, 'spend' => round($v['spend'], 2), 'leads' => round($v['leads'], 1)];
}

$stages = [];
foreach ($campaigns as $c) {
    if (!isset($stages[$c['stage']])) {
        $stages[$c['stage']] = ['spend' => 0.0, 'impressions' => 0, 'clicks' => 0, 'leads' => 0.0, 'campaigns' => 0];
    }
    $stages[$c['stage']]['spend']       += $c['spend'];
    $stages[$c['stage']]['impressions'] += $c['impressions'];
    $stages[$c['stage']]['clicks']      += $c['clicks'];
    $stages[$c['stage']]['leads']       += $c['leads'];
    $stages[$c['stage']]['campaigns']++;
}

$mixed  = count($currencies) > 1;
$totals = [
    'spend'       => $mixed ? null : round(array_sum(array_column($platTotals, 'spend')), 2),
    'budget'      => $mixed ? null : report_budget($budgets, $from, $to),
    'impressions' => array_sum(array_column($platTotals, 'impressions')),
    'clicks'      => array_sum(array_column($platTotals, 'clicks')),
    'leads'       => round(array_sum(array_column($platTotals, 'leads')), 1),
];

usort($campaigns, fn($a, $b) => [$b['leads'], $b['clicks']] <=> [$a['leads'], $a['clicks']]);

// Contenidos: los mejores de todas las cuentas. La vista previa oficial de Meta (iframe) solo se
// pide para los que quedan en el top. El id del anuncio no sale del servidor.
$byResults = fn($a, $b) => [$b['leads'], $b['clicks']] <=> [$a['leads'], $a['clicks']];
usort($content['meta'], $byResults);
usort($content['google'], $byResults);
$content['meta']   = array_slice($content['meta'], 0, 6);
$content['google'] = array_slice($content['google'], 0, 3);
foreach ($content['meta'] as &$ad) {
    $ad['preview'] = metaAdPreviewUrl($ad['id']);
    unset($ad['id']);
}
unset($ad);

$out = json_encode([
    'client'       => ['name' => $link['client_name']],
    'link'         => [
        'mode'      => $link['mode'],
        'title'     => $link['title'],
        'message'   => $link['message'],
        'lead_goal' => $link['lead_goal'] !== null ? (int)$link['lead_goal'] : null,
        'preset'    => $link['mode'] === 'live' ? $preset : null,
    ],
    'period'       => ['from' => $from, 'to' => $to, 'days' => $periodDays],
    // Solo si todas las cuentas respondieron y hubo actividad: una comparación a medias contaría mal la historia.
    'previous'     => ($prev['ok'] && !$mixed && ($prev['spend'] > 0 || $prev['leads'] > 0))
        ? ['from' => $prevFrom, 'to' => $prevTo, 'spend' => round($prev['spend'], 2), 'leads' => round($prev['leads'], 1)]
        : null,
    'currency'     => $mixed ? '' : (array_key_first($currencies) ?? ''),
    'totals'       => $totals,
    'platforms'    => array_values($platTotals),
    'daily'        => $dailyOut,
    'stages'       => $stages,
    'campaigns'    => array_slice($campaigns, 0, 40),
    'content'      => $content,
    'partial'      => $errors > 0,
    'generated_at' => (new DateTime('now', new DateTimeZone('America/Bogota')))->format('c'),
], JSON_UNESCAPED_UNICODE);

if ($errors === 0) {
    @file_put_contents($cacheFile, $out);
}
header('Content-Type: application/json; charset=utf-8');
echo $out;
