<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/meta_client.php';

require_atencion_access();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_error('Método no permitido', 405);
}

$pdo = db();
$clientId = (int)($_GET['client_id'] ?? 0);
if ($clientId <= 0) {
    json_error('client_id requerido', 400);
}

$formId = trim($_GET['form_id'] ?? '');

if ($formId !== '') {
    // Nivel 2: leads respaldados de un formulario puntual, con su field_data completo.
    $stmt = $pdo->prepare('SELECT * FROM ad_leads WHERE client_id = ? AND form_id = ? ORDER BY created_at DESC');
    $stmt->execute([$clientId, $formId]);
    json_response(['leads' => $stmt->fetchAll()]);
}

// Nivel 1: formularios de las páginas de Facebook conectadas de este cliente, con
// conteo de leads ya respaldados. Los nombres/estado se piden en vivo a Meta (sin
// caché que se desactualice); el conteo sale de nuestro propio respaldo.
$stmt = $pdo->prepare('
    SELECT id, page_id, page_name, page_access_token_encrypted, page_token_iv
    FROM social_accounts
    WHERE client_id = ? AND platform = "facebook_page" AND status = "active"
');
$stmt->execute([$clientId]);
$accounts = $stmt->fetchAll();

$countStmt = $pdo->prepare('
    SELECT form_id, COUNT(*) AS leads_count, MAX(created_at) AS last_lead_at
    FROM ad_leads WHERE social_account_id = ? GROUP BY form_id
');

$forms = [];
foreach ($accounts as $account) {
    try {
        $pageToken = decrypt_token($account['page_access_token_encrypted'], $account['page_token_iv']);
        $metaForms = MetaClient::listLeadForms($pageToken, $account['page_id']);
    } catch (Throwable $e) {
        continue; // página con token inválido/sin permiso: se omite, no rompe el resto
    }

    $countStmt->execute([$account['id']]);
    $counts = [];
    foreach ($countStmt->fetchAll() as $row) {
        $counts[$row['form_id']] = $row;
    }

    foreach ($metaForms as $f) {
        $count = $counts[$f['id']] ?? ['leads_count' => 0, 'last_lead_at' => null];
        $forms[] = [
            'form_id'         => $f['id'],
            'form_name'       => $f['name'] ?? $f['id'],
            'status'          => $f['status'] ?? null,
            'social_account_id' => (int)$account['id'],
            'page_name'       => $account['page_name'],
            'leads_count'     => (int)$count['leads_count'],
            'last_lead_at'    => $count['last_lead_at'],
        ];
    }
}

json_response(['forms' => $forms]);
