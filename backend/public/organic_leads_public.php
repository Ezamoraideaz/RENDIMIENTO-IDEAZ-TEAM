<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/organic_leads_csv.php';

// Portal público de solo lectura para el equipo comercial (leads-cliente.html?t=<token>).
// Sin sesión, sin CSRF — se autentica solo con el token del link, igual que
// backend/public/review.php / content_batches.

$pdo = db();
$rawToken = trim($_GET['t'] ?? '');
if ($rawToken === '') {
    json_error('Falta el token', 400);
}
$tokenHash = hash('sha256', $rawToken);

$stmt = $pdo->prepare('
    SELECT c.id, c.name, c.logo_url
    FROM organic_lead_share_links l
    JOIN clients c ON c.id = l.client_id
    WHERE l.token_hash = ?
');
$stmt->execute([$tokenHash]);
$client = $stmt->fetch();
if (!$client) {
    json_error('Este link ya no está disponible', 404);
}

$leadsStmt = $pdo->prepare('SELECT * FROM organic_leads WHERE client_id = ? ORDER BY created_at DESC');
$leadsStmt->execute([$client['id']]);
$leads = $leadsStmt->fetchAll();

if (($_GET['format'] ?? '') === 'csv') {
    // Filtra por el mismo rango de fechas que esté activo en la página (los
    // botones Desde/Hasta actualizan el href de "Exportar CSV" con estos
    // parámetros), para que el archivo baje exactamente lo que se está viendo.
    $dateFrom = $_GET['date_from'] ?? '';
    $dateTo = $_GET['date_to'] ?? '';
    $validFrom = (bool)preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateFrom);
    $validTo = (bool)preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateTo);
    if ($validFrom || $validTo) {
        $leads = array_values(array_filter($leads, function ($lead) use ($dateFrom, $dateTo, $validFrom, $validTo) {
            if ($validFrom && (!$lead['lead_date'] || $lead['lead_date'] < $dateFrom)) return false;
            if ($validTo && (!$lead['lead_date'] || $lead['lead_date'] > $dateTo)) return false;
            return true;
        }));
    }
    organic_leads_stream_csv($leads, $client['name']);
}

json_response([
    'client' => ['name' => $client['name'], 'logo_url' => $client['logo_url']],
    'leads' => $leads,
]);
