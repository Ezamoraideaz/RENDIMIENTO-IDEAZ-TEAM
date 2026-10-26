<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/spreadsheet_reader.php';

// Precalificación de leads de pauta (Pauta → detalle → pestaña Leads).
// Cruza los leads de pauta contra la base de Leads Orgánicos del cliente (organic_leads):
//   nuevo        → no estaba en la base orgánica: cuenta como CALIFICADO
//   existente    → ya estaba en la base orgánica ANTES del lead de pauta: no es nuevo
//   duplicado    → repetido dentro de la misma tanda (mismo teléfono o correo)
//   sin_contacto → sin teléfono ni correo válidos
// Los leads de pauta salen de: formularios de Meta ya respaldados en ad_leads (automático, por
// fecha del período) + un Excel/CSV opcional. No guarda nada salvo el vínculo pauta ↔ cliente
// (migration_025); el resultado se aplica a pauta_leads desde el frontend.
//
// GET  ?pauta_client_id=  → clientes de Atención al Cliente (con conteos) + el vinculado
// POST multipart: pauta_client_id, organic_client_id, from, to, include_forms (0/1), file (opcional)

const PRECHECK_MAX_BYTES = 5 * 1024 * 1024;

$operator = require_role(['superadmin', 'admin']);
$pdo = db();

function precheck_phone_key(?string $phone): string
{
    $d = preg_replace('/\D/', '', (string)$phone) ?? '';
    if (strlen($d) < 7) return '';
    // Se comparan los últimos 10 dígitos: "+57 300…", "57300…" y "300…" son el mismo número
    return strlen($d) > 10 ? substr($d, -10) : $d;
}

function precheck_email_key(?string $email): string
{
    $e = strtolower(trim((string)$email));
    return filter_var($e, FILTER_VALIDATE_EMAIL) ? $e : '';
}

function precheck_linked_id(PDO $pdo, string $pautaClientId): ?int
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
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $pautaClientId = trim((string)($_GET['pauta_client_id'] ?? ''));
        $clients = $pdo->query('
            SELECT c.id, c.name,
                   (SELECT COUNT(*) FROM organic_leads o WHERE o.client_id = c.id) AS organic_count,
                   (SELECT COUNT(*) FROM ad_leads a WHERE a.client_id = c.id) AS form_count
            FROM clients c WHERE c.status <> "archived" ORDER BY c.name ASC
        ')->fetchAll();
        foreach ($clients as &$c) {
            $c['id'] = (int)$c['id'];
            $c['organic_count'] = (int)$c['organic_count'];
            $c['form_count'] = (int)$c['form_count'];
        }
        unset($c);
        json_response([
            'clients'           => $clients,
            'organic_client_id' => $pautaClientId !== '' ? precheck_linked_id($pdo, $pautaClientId) : null,
        ]);
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        json_error('Método no permitido', 405);
    }
    verify_csrf();

    $pautaClientId = trim((string)($_POST['pauta_client_id'] ?? ''));
    $orgClientId   = (int)($_POST['organic_client_id'] ?? 0);
    $from          = (string)($_POST['from'] ?? '');
    $to            = (string)($_POST['to'] ?? '');
    $includeForms  = ($_POST['include_forms'] ?? '1') === '1';
    $validDate     = fn($d) => (bool)preg_match('/^\d{4}-\d{2}-\d{2}$/', $d);

    if ($orgClientId <= 0) json_error('Elige la base orgánica (cliente de Atención al Cliente)', 400);
    if (!$validDate($from) || !$validDate($to) || $from > $to) json_error('Período no válido', 400);
    $stmt = $pdo->prepare('SELECT id, name FROM clients WHERE id = ?');
    $stmt->execute([$orgClientId]);
    $orgClient = $stmt->fetch();
    if (!$orgClient) json_error('Cliente no encontrado', 404);

    // Recordar el vínculo para la próxima vez (sin migration_025 simplemente no se guarda)
    $linkSaved = false;
    if ($pautaClientId !== '') {
        try {
            $pdo->prepare('UPDATE pauta_clients SET organic_client_id = ? WHERE id = ?')->execute([$orgClientId, $pautaClientId]);
            $linkSaved = true;
        } catch (PDOException $e) {
            $linkSaved = false;
        }
    }

    // ── Leads de pauta a evaluar ──
    $incoming = [];
    if ($includeForms) {
        $stmt = $pdo->prepare('
            SELECT name, email, phone, form_name, campaign_name, COALESCE(lead_created_at, created_at) AS at
            FROM ad_leads
            WHERE client_id = ? AND DATE(COALESCE(lead_created_at, created_at)) BETWEEN ? AND ?
            ORDER BY at ASC');
        $stmt->execute([$orgClientId, $from, $to]);
        foreach ($stmt->fetchAll() as $r) {
            $incoming[] = [
                'origin' => 'Formulario Meta',
                'detail' => (string)($r['form_name'] ?: $r['campaign_name'] ?: ''),
                'name'   => (string)($r['name'] ?? ''),
                'email'  => (string)($r['email'] ?? ''),
                'phone'  => (string)($r['phone'] ?? ''),
                'date'   => substr((string)$r['at'], 0, 10),
            ];
        }
    }

    $fileName = null;
    if (!empty($_FILES['file']) && $_FILES['file']['error'] !== UPLOAD_ERR_NO_FILE) {
        $file = $_FILES['file'];
        if ($file['error'] !== UPLOAD_ERR_OK) json_error('No se pudo subir el archivo', 400);
        if ($file['size'] > PRECHECK_MAX_BYTES) json_error('El archivo supera el máximo de 5 MB', 400);
        $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if (!in_array($ext, ['xlsx', 'csv'], true)) json_error('Formato no soportado. Sube un archivo .xlsx o .csv', 400);
        try {
            $rows = read_spreadsheet_rows($file['tmp_name'], $file['name']);
        } catch (Throwable $e) {
            json_error($e->getMessage(), 400);
        }
        if (count($rows) < 2) json_error('El archivo no tiene filas de datos', 400);
        $headers = array_shift($rows);
        $col = map_lead_columns($headers);
        // Export de Meta Ads: full_name, email, phone_number ("p:+57300…"), created_time
        $norm = array_map(fn($h) => str_replace('_', ' ', organic_lead_normalize_header((string)$h)), $headers);
        foreach (['name' => ['full name', 'nombre completo'], 'phone' => ['phone number', 'numero de telefono'], 'date' => ['created time', 'fecha de creacion']] as $f => $alts) {
            if ($col[$f] === null) {
                foreach ($norm as $i => $h) { if (in_array($h, $alts, true)) { $col[$f] = $i; break; } }
            }
        }
        if ($col['email'] === null && $col['phone'] === null) {
            json_error('No encontré columnas de teléfono ni de correo en el archivo (ej. "Teléfono", "Celular", "Correo", "email", "phone_number")', 400);
        }
        $fileName = $file['name'];
        foreach ($rows as $row) {
            if (!array_filter($row, static fn($v) => trim((string)$v) !== '')) continue;
            $get = fn($k) => $col[$k] !== null ? trim((string)($row[$col[$k]] ?? '')) : '';
            $date = $get('date') !== '' ? parse_lead_date(substr($get('date'), 0, 10)) ?? parse_lead_date($get('date')) : null;
            $incoming[] = [
                'origin' => 'Archivo',
                'detail' => '',
                'name'   => $get('name'),
                'email'  => $get('email'),
                'phone'  => preg_replace('/^p:/i', '', $get('phone')),
                'date'   => $date ?? '',
            ];
        }
    }

    if (!$incoming) {
        json_response([
            'rows' => [], 'summary' => ['total' => 0, 'nuevo' => 0, 'existente' => 0, 'duplicado' => 0, 'sin_contacto' => 0],
            'organic_client' => $orgClient, 'organic_count' => 0, 'link_saved' => $linkSaved, 'file' => $fileName,
        ]);
    }

    // ── Base orgánica indexada por teléfono y correo (se queda con el registro más antiguo) ──
    $stmt = $pdo->prepare('SELECT name, email, phone, source, COALESCE(lead_date, DATE(created_at)) AS d FROM organic_leads WHERE client_id = ?');
    $stmt->execute([$orgClientId]);
    $byPhone = $byEmail = [];
    $organicCount = 0;
    foreach ($stmt->fetchAll() as $o) {
        $organicCount++;
        $rec = ['name' => (string)($o['name'] ?? ''), 'date' => (string)($o['d'] ?? ''), 'source' => (string)($o['source'] ?? '')];
        $pk = precheck_phone_key($o['phone']);
        if ($pk !== '' && (!isset($byPhone[$pk]) || $rec['date'] < $byPhone[$pk]['date'])) $byPhone[$pk] = $rec;
        $ek = precheck_email_key($o['email']);
        if ($ek !== '' && (!isset($byEmail[$ek]) || $rec['date'] < $byEmail[$ek]['date'])) $byEmail[$ek] = $rec;
    }

    // ── Clasificación ──
    $seen = [];
    $out  = [];
    $sum  = ['total' => 0, 'nuevo' => 0, 'existente' => 0, 'duplicado' => 0, 'sin_contacto' => 0];
    foreach ($incoming as $lead) {
        $pk = precheck_phone_key($lead['phone']);
        $ek = precheck_email_key($lead['email']);
        $match = null;
        $note = '';
        if ($pk === '' && $ek === '') {
            $status = 'sin_contacto';
        } elseif (($pk !== '' && isset($seen['p' . $pk])) || ($ek !== '' && isset($seen['e' . $ek]))) {
            $status = 'duplicado';
        } else {
            $match = ($pk !== '' ? ($byPhone[$pk] ?? null) : null) ?? ($ek !== '' ? ($byEmail[$ek] ?? null) : null);
            // Solo cuenta como "ya existente" si estaba en la base orgánica antes (o el mismo día)
            // que el lead de pauta. Si se registró después, el lead sí llegó nuevo por la pauta.
            if ($match && ($lead['date'] === '' || $match['date'] === '' || $match['date'] <= $lead['date'])) {
                $status = 'existente';
            } else {
                if ($match) $note = 'También aparece en la base orgánica, registrado después (' . $match['date'] . ')';
                $match = null;
                $status = 'nuevo';
            }
        }
        if ($pk !== '') $seen['p' . $pk] = true;
        if ($ek !== '') $seen['e' . $ek] = true;
        $sum['total']++;
        $sum[$status]++;
        $out[] = $lead + ['status' => $status, 'match' => $match, 'note' => $note];
    }

    json_response([
        'rows'           => $out,
        'summary'        => $sum,
        'organic_client' => ['id' => (int)$orgClient['id'], 'name' => $orgClient['name']],
        'organic_count'  => $organicCount,
        'link_saved'     => $linkSaved,
        'file'           => $fileName,
    ]);
} catch (PDOException $e) {
    json_response(['error' => 'Error de base de datos en pauta_lead_precheck: ' . $e->getMessage()], 500);
}
