<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Calificados preliminares de pauta (Pauta → detalle de una marca).
// Mientras nadie registre el número a mano, los leads que entraron en el período a la base de
// Leads Orgánicos (organic_leads, por lead_date o fecha de importación) y por formularios de Meta
// (ad_leads, por fecha del lead) cuentan como CALIFICADOS de la pauta — siempre que la marca haya
// tenido inversión en el período (eso lo decide el frontend con el gasto real).
// Una misma persona en ambas fuentes (mismo teléfono o correo) se cuenta una sola vez.
//
// GET  ?pauta_client_id=&from=&to=  → clientes de Atención al Cliente, el vinculado y, si hay
//                                     vínculo, los leads del período con sus conteos
// POST {action:'link', pauta_client_id, organic_client_id}  → guarda el vínculo (migration_025)

$operator = require_role(['superadmin', 'admin']);
$pdo = db();

function prelim_phone_key(?string $phone): string
{
    $d = preg_replace('/\D/', '', (string)$phone) ?? '';
    if (strlen($d) < 7) return '';
    // Últimos 10 dígitos: "+57 300…", "57300…" y "300…" son el mismo número
    return strlen($d) > 10 ? substr($d, -10) : $d;
}

function prelim_email_key(?string $email): string
{
    $e = strtolower(trim((string)$email));
    return filter_var($e, FILTER_VALIDATE_EMAIL) ? $e : '';
}

function prelim_linked_id(PDO $pdo, string $pautaClientId): ?int
{
    try {
        $stmt = $pdo->prepare('SELECT organic_client_id FROM pauta_clients WHERE id = ?');
        $stmt->execute([$pautaClientId]);
        $v = $stmt->fetchColumn();
        return $v ? (int)$v : null;
    } catch (PDOException $e) {
        return null; // migration_025 pendiente
    }
}

try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $operator = require_state_changing_request();
        $input = json_body();
        if (($input['action'] ?? '') !== 'link') json_error('action inválida', 400);
        $pautaClientId = trim((string)($input['pauta_client_id'] ?? ''));
        $orgClientId   = (int)($input['organic_client_id'] ?? 0);
        if ($pautaClientId === '') json_error('pauta_client_id requerido', 400);
        try {
            $pdo->prepare('UPDATE pauta_clients SET organic_client_id = ? WHERE id = ?')
                ->execute([$orgClientId > 0 ? $orgClientId : null, $pautaClientId]);
        } catch (PDOException $e) {
            json_error('Falta correr backend/sql/migration_025_pauta_organic_link.sql en la base de datos', 409);
        }
        json_response(['ok' => true]);
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        json_error('Método no permitido', 405);
    }

    $pautaClientId = trim((string)($_GET['pauta_client_id'] ?? ''));
    $from = (string)($_GET['from'] ?? '');
    $to   = (string)($_GET['to'] ?? '');
    $validDate = fn($d) => (bool)preg_match('/^\d{4}-\d{2}-\d{2}$/', $d);

    $clients = $pdo->query('SELECT id, name FROM clients WHERE status <> "archived" ORDER BY name ASC')->fetchAll();
    foreach ($clients as &$c) $c['id'] = (int)$c['id'];
    unset($c);

    $linked = $pautaClientId !== '' ? prelim_linked_id($pdo, $pautaClientId) : null;
    $out = ['clients' => $clients, 'organic_client_id' => $linked, 'leads' => [], 'counts' => null];

    if (!$linked || !$validDate($from) || !$validDate($to) || $from > $to) {
        json_response($out);
    }

    $leads = [];
    $stmt = $pdo->prepare('
        SELECT name, email, phone, source, reason, COALESCE(lead_date, DATE(created_at)) AS d
        FROM organic_leads
        WHERE client_id = ? AND COALESCE(lead_date, DATE(created_at)) BETWEEN ? AND ?');
    $stmt->execute([$linked, $from, $to]);
    foreach ($stmt->fetchAll() as $r) {
        $leads[] = ['origin' => 'organico', 'name' => (string)($r['name'] ?? ''), 'email' => (string)($r['email'] ?? ''),
                    'phone' => (string)($r['phone'] ?? ''), 'date' => (string)$r['d'],
                    'detail' => (string)($r['source'] ?: ($r['reason'] ?? ''))];
    }

    $stmt = $pdo->prepare('
        SELECT name, email, phone, form_name, campaign_name, DATE(COALESCE(lead_created_at, created_at)) AS d
        FROM ad_leads
        WHERE client_id = ? AND DATE(COALESCE(lead_created_at, created_at)) BETWEEN ? AND ?');
    $stmt->execute([$linked, $from, $to]);
    foreach ($stmt->fetchAll() as $r) {
        $leads[] = ['origin' => 'formulario', 'name' => (string)($r['name'] ?? ''), 'email' => (string)($r['email'] ?? ''),
                    'phone' => (string)($r['phone'] ?? ''), 'date' => (string)$r['d'],
                    'detail' => (string)($r['form_name'] ?: ($r['campaign_name'] ?? ''))];
    }

    // Una persona que aparece en ambas fuentes (o dos veces) se cuenta una sola vez: la primera por fecha
    usort($leads, fn($a, $b) => strcmp($a['date'], $b['date']));
    $seen = [];
    $counts = ['organico' => 0, 'formulario' => 0, 'repetidos' => 0, 'unicos' => 0];
    foreach ($leads as &$l) {
        $counts[$l['origin']]++;
        $keys = array_filter(['p' . prelim_phone_key($l['phone']), 'e' . prelim_email_key($l['email'])], fn($k) => strlen($k) > 1);
        $dup = false;
        foreach ($keys as $k) { if (isset($seen[$k])) $dup = true; }
        foreach ($keys as $k) $seen[$k] = true;
        $l['repeated'] = $dup;
        $dup ? $counts['repetidos']++ : $counts['unicos']++;
    }
    unset($l);

    $out['leads']  = $leads;
    $out['counts'] = $counts;
    json_response($out);
} catch (PDOException $e) {
    json_response(['error' => 'Error de base de datos en pauta_lead_precheck: ' . $e->getMessage()], 500);
}
