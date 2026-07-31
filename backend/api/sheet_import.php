<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/google_sheets.php';

// Lectura en vivo (sin copia persistida) de la parrilla de contenido de un
// cliente, para prellenar la tanda automática en aprobaciones.html. Ver PRD §8b.
require_role(['cm', 'admin', 'superadmin']);

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_error('Método no permitido', 405);
}

$pdo = db();

$clientId = (int)($_GET['client_id'] ?? 0);
$tab = trim($_GET['tab'] ?? '');
if ($clientId <= 0 || $tab === '') {
    json_error('client_id y tab son requeridos', 400);
}

$stmt = $pdo->prepare('SELECT sheet_id FROM clients WHERE id = ?');
$stmt->execute([$clientId]);
$sheetId = $stmt->fetchColumn();
if (!$sheetId) {
    json_error('Este cliente no tiene un Google Sheet vinculado todavía', 400);
}

// El nombre de pestaña real casi nunca coincide carácter por carácter con el
// mes esperado (espacios de más, mayúsculas distintas, "JULIO-AGOSTO" en vez
// de "JULIO"), así que primero se resuelve el título exacto entre las pestañas
// del Sheet en vez de asumir que $tab existe tal cual.
$realTab = google_sheets_find_tab((string)$sheetId, $tab);
if ($realTab === null) {
    $detail = google_sheets_last_error();
    json_error('No se pudo leer el Google Sheet' . ($detail ? " — {$detail}" : ' — revisa que esté compartido con la cuenta de servicio y que la pestaña exista'), 502);
}

$values = google_sheets_get_values((string)$sheetId, google_sheets_quote_tab($realTab) . '!A:G');
if ($values === null) {
    $detail = google_sheets_last_error();
    json_error('No se pudo leer el Google Sheet' . ($detail ? " — {$detail}" : ' — revisa que esté compartido con la cuenta de servicio y que la pestaña exista'), 502);
}

// Columnas del cronograma: A=POST#, B=formato, C=día, D/E=uso interno del
// diseñador (nunca se exponen aquí), F=copy, G=hashtags.
const SHEET_TYPE_MAP = ['HISTORIA' => 'story', 'REEL' => 'reel', 'CARRUSEL' => 'carousel'];

$rows = [];
foreach ($values as $row) {
    $colA = trim((string)($row[0] ?? ''));
    if (!preg_match('/POST\s*#?\s*(\d+)/i', $colA, $m)) {
        continue; // encabezados, separadores de semana ("PRIMERA SEMANA"), filas vacías
    }
    $formatRaw = strtoupper(trim((string)($row[1] ?? '')));
    $rows[] = [
        'post_number' => (int)$m[1],
        'label'       => $colA,
        'format_raw'  => $row[1] ?? '',
        // Match exacto primero (HISTORIA/CARRUSEL); "REEL" además cubre variantes
        // como "REEL FEED" que también deben tratarse como reel, no como feed.
        'type'        => SHEET_TYPE_MAP[$formatRaw] ?? (str_contains($formatRaw, 'REEL') ? 'reel' : 'feed'),
        'day'         => trim((string)($row[2] ?? '')),
        'caption'     => trim((string)($row[5] ?? '')),
        'hashtags'    => trim((string)($row[6] ?? '')),
    ];
}

json_response(['rows' => $rows]);
