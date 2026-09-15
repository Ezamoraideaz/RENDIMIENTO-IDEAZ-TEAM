<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Dashboard consolidado de Rendición Trimestral (solo dueño/directivos, ver
// require_rendicion_admin_access()). Junta rendicion_forms + rendicion_opportunities
// + client_surveys (por cliente+trimestre) y calcula el Score del CM (0-100)
// descrito en el MD del módulo: la satisfacción del cliente pesa fuerte (25
// de 100) pero no decide todo el resultado, y reportar un riesgo con claridad
// nunca resta puntos (evita el incentivo de ocultar problemas).

require_rendicion_admin_access();
$pdo = db();

// Pesos base (suman 100). Si no hay encuesta del cliente para ese
// cliente+trimestre, el peso de "satisfaction" se redistribuye
// proporcionalmente entre las demás categorías en vez de restarse.
const RENDICION_SCORE_WEIGHTS = [
    'management' => 15,
    'compliance' => 10,
    'production' => 10,
    'commercial' => 10,
    'fidelizacion' => 8,
    'quality' => 10,
    'knowledge' => 7,
    'risk_transparency' => 5,
    'satisfaction' => 25,
];

function rendicion_clamp01(float $v): float
{
    return max(0.0, min(1.0, $v));
}

function rendicion_scale_val(?string $v): float
{
    return $v === 'si' ? 1.0 : ($v === 'parcial' ? 0.5 : 0.0);
}

// Devuelve [score 0-100, breakdown por categoría 0-1] para una cuenta.
function rendicion_compute_score(array $form, array $opportunities, ?array $survey): array
{
    $answers = $form['answers'] ?? [];

    $totalRelevant = (int)($form['meetings_total'] ?? 0) + (int)($form['followups_count'] ?? 0);
    $proactivityIndex = $totalRelevant > 0
        ? rendicion_clamp01(((int)($form['meetings_cm_initiated'] ?? 0)) / $totalRelevant)
        : 0.5;
    $selfScore = rendicion_clamp01(((int)($form['proactivity_self_score'] ?? 0)) / 5);
    $management = rendicion_clamp01(0.5 * $selfScore + 0.5 * $proactivityIndex);

    $compliance = rendicion_clamp01((
        rendicion_scale_val($answers['calendar_status'] ?? null) +
        rendicion_scale_val($answers['calendar_approved'] ?? null) +
        (($answers['unproduced_content'] ?? 'no') === 'si' ? 0.0 : 1.0)
    ) / 3);

    $approved = (int)($form['pieces_approved'] ?? 0);
    $rework = (int)($form['pieces_rework'] ?? 0);
    $production = ($approved + $rework) > 0 ? rendicion_clamp01($approved / ($approved + $rework)) : 1.0;

    $oppCount = count($opportunities);
    $commercial = $oppCount > 0 ? rendicion_clamp01(0.4 + 0.2 * $oppCount) : 0.3;

    $fidelizacionActions = is_array($answers['fidelizacion_actions'] ?? null) ? $answers['fidelizacion_actions'] : [];
    $fidelizacion = rendicion_clamp01(count($fidelizacionActions) / 4);

    $generated = max(1, (int)($form['pieces_generated'] ?? 0));
    $incidents = (int)($form['incidents_count'] ?? 0);
    $quality = rendicion_clamp01(1 - ($incidents / $generated) * 3);

    $knowledge = is_array($answers['client_knowledge'] ?? null)
        ? rendicion_clamp01(count(array_filter($answers['client_knowledge'])) / 9)
        : 0.0;

    $hasRisk = !empty($form['has_risk']);
    $riskDetailLen = mb_strlen(trim((string)($answers['risk_detail'] ?? '')));
    $riskTransparency = !$hasRisk ? 1.0 : ($riskDetailLen >= 40 ? 0.9 : 0.6);

    $breakdown = [
        'management' => $management,
        'compliance' => $compliance,
        'production' => $production,
        'commercial' => $commercial,
        'fidelizacion' => $fidelizacion,
        'quality' => $quality,
        'knowledge' => $knowledge,
        'risk_transparency' => $riskTransparency,
    ];

    $satisfaction = null;
    if ($survey && $survey['status'] === 'filled') {
        $ratingFields = ['rating_ideaz', 'rating_cm', 'rating_response_time', 'rating_quality', 'rating_creativity',
            'rating_commitment', 'rating_communication', 'rating_understands_business', 'rating_overall'];
        $sum = 0;
        $n = 0;
        foreach ($ratingFields as $f) {
            if ($survey[$f] !== null) {
                $sum += (int)$survey[$f];
                $n++;
            }
        }
        $ratingsAvg = $n > 0 ? ($sum / $n) / 5 : 0.0;
        $npsNorm = $survey['nps'] !== null ? ((int)$survey['nps']) / 10 : $ratingsAvg;
        $satisfaction = rendicion_clamp01(0.7 * $ratingsAvg + 0.3 * $npsNorm);
        $breakdown['satisfaction'] = $satisfaction;
    }

    $weights = RENDICION_SCORE_WEIGHTS;
    if ($satisfaction === null) {
        $satWeight = $weights['satisfaction'];
        unset($weights['satisfaction']);
        $otherTotal = array_sum($weights);
        foreach ($weights as $k => $w) {
            $weights[$k] = $w + $w * ($satWeight / $otherTotal);
        }
    }

    $score = 0.0;
    foreach ($breakdown as $k => $v) {
        $score += $v * ($weights[$k] ?? 0);
    }

    return [round($score, 1), $breakdown];
}

function rendicion_health_from_score(float $score): string
{
    if ($score >= 80) return 'verde';
    if ($score >= 60) return 'amarillo';
    return 'rojo';
}

// Rango de fechas [inicio, fin] de un trimestre "YYYY-Qn" (fin a las 23:59:59
// para que incluya piezas creadas el último día). Usado para contrastar lo
// autorreportado en Producción contra content_items reales de Aprobaciones.
function rendicion_quarter_range(string $quarter): ?array
{
    if (!preg_match('/^(\d{4})-Q([1-4])$/', $quarter, $m)) {
        return null;
    }
    $year = (int)$m[1];
    $q = (int)$m[2];
    $startMonth = ($q - 1) * 3 + 1;
    $start = new DateTime("{$year}-{$startMonth}-01");
    $end = clone $start;
    $end->modify('+2 months')->modify('last day of this month')->setTime(23, 59, 59);
    return [$start->format('Y-m-d 00:00:00'), $end->format('Y-m-d H:i:s')];
}

$quarter = trim($_GET['quarter'] ?? '');
$clientId = (int)($_GET['client_id'] ?? 0);
$operatorId = (int)($_GET['operator_id'] ?? 0);

$where = [];
$params = [];
if ($quarter !== '') {
    $where[] = 'f.quarter = ?';
    $params[] = $quarter;
}
if ($clientId > 0) {
    $where[] = 'f.client_id = ?';
    $params[] = $clientId;
}
if ($operatorId > 0) {
    $where[] = 'f.operator_id = ?';
    $params[] = $operatorId;
}
$whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

$stmt = $pdo->prepare("
    SELECT f.*, c.name AS client_name, c.logo_url AS client_logo_url, o.name AS operator_name
    FROM rendicion_forms f
    JOIN clients c ON c.id = f.client_id
    JOIN operators o ON o.id = f.operator_id
    {$whereSql}
    ORDER BY c.name ASC
");
$stmt->execute($params);
$forms = $stmt->fetchAll();

$formIds = array_map(fn($f) => (int)$f['id'], $forms);
$opportunitiesByForm = [];
$oppStageCounts = array_fill_keys(['detectada', 'reportada', 'presentada', 'cotizada', 'en_negociacion', 'aprobada', 'vendida', 'perdida', 'pendiente'], 0);
$potentialValueSum = 0.0;
$soldValueSum = 0.0;
if ($formIds) {
    $inPlaceholders = implode(',', array_fill(0, count($formIds), '?'));
    $oppStmt = $pdo->prepare("SELECT * FROM rendicion_opportunities WHERE rendicion_form_id IN ({$inPlaceholders})");
    $oppStmt->execute($formIds);
    foreach ($oppStmt->fetchAll() as $opp) {
        $opportunitiesByForm[$opp['rendicion_form_id']][] = $opp;
        $oppStageCounts[$opp['stage']] = ($oppStageCounts[$opp['stage']] ?? 0) + 1;
        $val = $opp['estimated_value'] !== null ? (float)$opp['estimated_value'] : 0.0;
        $potentialValueSum += $val;
        if ($opp['stage'] === 'vendida') {
            $soldValueSum += $val;
        }
    }
}

// Encuestas: se matchean por (client_id, quarter) del propio formulario, no
// por el filtro global de quarter, para que cada cuenta cruce con SU trimestre.
$surveysByKey = [];
$pairs = [];
foreach ($forms as $f) {
    $pairs[$f['client_id'] . '|' . $f['quarter']] = [$f['client_id'], $f['quarter']];
}
if ($pairs) {
    $orParts = implode(' OR ', array_fill(0, count($pairs), '(client_id = ? AND quarter = ?)'));
    $params2 = [];
    foreach ($pairs as [$cid, $q]) {
        $params2[] = $cid;
        $params2[] = $q;
    }
    $surveyStmt = $pdo->prepare("SELECT * FROM client_surveys WHERE {$orParts}");
    $surveyStmt->execute($params2);
    foreach ($surveyStmt->fetchAll() as $s) {
        $surveysByKey[$s['client_id'] . '|' . $s['quarter']] = $s;
    }
}

// Contraste con Aprobaciones: piezas reales (content_items, con fecha) del
// mismo cliente+trimestre, agrupadas por quarter porque el rango de fechas
// cambia según el trimestre — casi siempre es uno solo (el que filtró el
// dashboard), pero se soporta más de uno por si se ve "todos los trimestres".
$productionRealByKey = [];
$clientsByQuarter = [];
foreach ($pairs as [$cid, $q]) {
    $clientsByQuarter[$q][] = $cid;
}
foreach ($clientsByQuarter as $q => $clientIds) {
    $range = rendicion_quarter_range($q);
    if (!$range) continue;
    $clientIds = array_values(array_unique($clientIds));
    $inPlaceholders = implode(',', array_fill(0, count($clientIds), '?'));
    $prodStmt = $pdo->prepare("
        SELECT cb.client_id,
               COUNT(*) AS generated,
               SUM(ci.status = 'approved') AS approved,
               SUM(ci.status = 'changes_requested') AS changes_requested,
               SUM(ci.status = 'pending') AS pending
        FROM content_items ci
        JOIN content_batches cb ON cb.id = ci.batch_id
        WHERE cb.client_id IN ({$inPlaceholders}) AND ci.created_at BETWEEN ? AND ?
        GROUP BY cb.client_id
    ");
    $prodStmt->execute([...$clientIds, $range[0], $range[1]]);
    foreach ($prodStmt->fetchAll() as $row) {
        $productionRealByKey[$row['client_id'] . '|' . $q] = [
            'generated' => (int)$row['generated'],
            'approved' => (int)$row['approved'],
            'changes_requested' => (int)$row['changes_requested'],
            'pending' => (int)$row['pending'],
        ];
    }
}

$accounts = [];
$cmAgg = []; // operator_id => ['name'=>, 'scores'=>[]]
$healthCounts = ['verde' => 0, 'amarillo' => 0, 'rojo' => 0];
$riskCount = 0;
$summary = [
    'meetings_total' => 0, 'followups_total' => 0, 'proactivity_self_sum' => 0, 'proactivity_self_n' => 0,
    'pieces_generated' => 0, 'pieces_approved' => 0, 'pieces_rework' => 0,
    'creation_sessions' => 0, 'client_visits' => 0, 'incidents_count' => 0,
];
$improvementsLogged = 0;

foreach ($forms as $f) {
    $f['answers'] = $f['answers'] ? json_decode($f['answers'], true) : [];
    $f['contracted_services'] = $f['contracted_services'] ? json_decode($f['contracted_services'], true) : [];
    $opps = $opportunitiesByForm[$f['id']] ?? [];
    $survey = $surveysByKey[$f['client_id'] . '|' . $f['quarter']] ?? null;

    // El score solo tiene sentido para una rendición ya enviada — un borrador
    // a medio llenar daría un número que confundiría más que ayudaría.
    if ($f['status'] !== 'submitted') {
        continue;
    }

    [$score, $breakdown] = rendicion_compute_score($f, $opps, $survey);
    $health = rendicion_health_from_score($score);
    $realProduction = $productionRealByKey[$f['client_id'] . '|' . $f['quarter']] ?? null;

    $accounts[] = [
        'form_id' => (int)$f['id'],
        'client_id' => (int)$f['client_id'],
        'client_name' => $f['client_name'],
        'operator_id' => (int)$f['operator_id'],
        'operator_name' => $f['operator_name'],
        'quarter' => $f['quarter'],
        'status' => $f['status'],
        'score' => $score,
        'breakdown' => $breakdown,
        'score_health' => $health,
        'account_health' => $f['account_health'],
        'has_risk' => (bool)$f['has_risk'],
        'survey_filled' => $survey && $survey['status'] === 'filled',
        'opportunities_count' => count($opps),
        'production_check' => [
            'reported' => [
                'generated' => (int)($f['pieces_generated'] ?? 0),
                'approved' => (int)($f['pieces_approved'] ?? 0),
                'rework' => (int)($f['pieces_rework'] ?? 0),
            ],
            'real' => $realProduction,
        ],
    ];

    $cmAgg[$f['operator_id']]['name'] = $f['operator_name'];
    $cmAgg[$f['operator_id']]['scores'][] = $score;
    $cmAgg[$f['operator_id']]['accounts'] = ($cmAgg[$f['operator_id']]['accounts'] ?? 0) + 1;

    if ($f['account_health']) $healthCounts[$f['account_health']] = ($healthCounts[$f['account_health']] ?? 0) + 1;
    if ($f['has_risk']) $riskCount++;

    $summary['meetings_total'] += (int)$f['meetings_total'];
    $summary['followups_total'] += (int)$f['followups_count'];
    if ($f['proactivity_self_score'] !== null) {
        $summary['proactivity_self_sum'] += (int)$f['proactivity_self_score'];
        $summary['proactivity_self_n']++;
    }
    $summary['pieces_generated'] += (int)$f['pieces_generated'];
    $summary['pieces_approved'] += (int)$f['pieces_approved'];
    $summary['pieces_rework'] += (int)$f['pieces_rework'];
    $summary['creation_sessions'] += (int)$f['creation_sessions'];
    $summary['client_visits'] += (int)$f['client_visits'];
    $summary['incidents_count'] += (int)$f['incidents_count'];
    $improvementsLogged += count(array_filter($f['answers']['improvements'] ?? [], fn($i) => !empty($i['problem'])));
}

$cmRanking = [];
foreach ($cmAgg as $opId => $data) {
    $avg = round(array_sum($data['scores']) / count($data['scores']), 1);
    $cmRanking[] = [
        'operator_id' => (int)$opId,
        'operator_name' => $data['name'],
        'accounts_count' => $data['accounts'],
        'avg_score' => $avg,
        'semaforo' => $avg >= 80 ? 'verde' : ($avg >= 60 ? 'amarillo' : 'rojo'),
    ];
}
usort($cmRanking, fn($a, $b) => $b['avg_score'] <=> $a['avg_score']);

$surveysFilled = 0;
$surveysPending = 0;
$satisfactionScores = [];
foreach ($surveysByKey as $s) {
    if ($s['status'] === 'filled') {
        $surveysFilled++;
        if ($s['rating_overall'] !== null) $satisfactionScores[] = (int)$s['rating_overall'];
    } elseif ($s['token_hash'] !== null) {
        $surveysPending++;
    }
}

json_response([
    'quarter' => $quarter,
    'summary' => array_merge($summary, [
        'total_accounts' => count($accounts),
        'total_cms' => count($cmAgg),
        'approval_rate' => ($summary['pieces_approved'] + $summary['pieces_rework']) > 0
            ? round($summary['pieces_approved'] / ($summary['pieces_approved'] + $summary['pieces_rework']) * 100, 1) : null,
        'avg_proactivity_self' => $summary['proactivity_self_n'] > 0
            ? round($summary['proactivity_self_sum'] / $summary['proactivity_self_n'], 1) : null,
    ]),
    'commercial' => [
        'opportunities_by_stage' => $oppStageCounts,
        'potential_value_sum' => round($potentialValueSum, 2),
        'sold_value_sum' => round($soldValueSum, 2),
    ],
    'risk' => array_merge($healthCounts, ['with_risk_count' => $riskCount]),
    'client_satisfaction' => [
        'avg_overall' => $satisfactionScores ? round(array_sum($satisfactionScores) / count($satisfactionScores), 2) : null,
        'surveys_filled' => $surveysFilled,
        'surveys_pending' => $surveysPending,
    ],
    'improvement' => ['total_improvements_logged' => $improvementsLogged],
    'cm_ranking' => $cmRanking,
    'accounts' => $accounts,
]);
