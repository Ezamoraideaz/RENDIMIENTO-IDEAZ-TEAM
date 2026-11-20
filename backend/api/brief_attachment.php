<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Descarga de adjuntos de un brief (logo, manual de marca, catálogo...) para
// el panel admin. Los archivos viven en backend/storage/brief_uploads/<brief_id>/
// (bloqueado al acceso web directo por backend/.htaccess) — este endpoint es
// la única puerta para bajarlos, y solo entrega un archivo si su stored_name
// realmente aparece en las respuestas guardadas de ese cliente/tipo de brief
// (evita que alguien adivine el nombre aleatorio de un archivo de otro cliente).

require_atencion_access();
$pdo = db();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_error('Método no permitido', 405);
}

$clientId = (int)($_GET['client_id'] ?? 0);
$briefType = $_GET['brief_type'] ?? '';
$storedName = $_GET['file'] ?? '';

if ($clientId <= 0 || !preg_match('/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/', $storedName)) {
    json_error('Parámetros inválidos', 400);
}

$stmt = $pdo->prepare('SELECT id, answers FROM client_briefs WHERE client_id = ? AND brief_type = ?');
$stmt->execute([$clientId, $briefType]);
$row = $stmt->fetch();
if (!$row || !$row['answers']) {
    json_error('No encontrado', 404);
}

$answers = json_decode($row['answers'], true) ?: [];
$found = null;
foreach ($answers as $value) {
    if (!is_array($value)) continue;
    foreach ($value as $item) {
        if (is_array($item) && ($item['stored_name'] ?? '') === $storedName) {
            $found = $item;
            break 2;
        }
    }
}
if (!$found) {
    json_error('Archivo no encontrado', 404);
}

$path = __DIR__ . '/../storage/brief_uploads/' . $row['id'] . '/' . $storedName;
if (!is_file($path)) {
    json_error('Archivo no encontrado en disco', 404);
}

header('Content-Type: application/octet-stream');
header('Content-Disposition: attachment; filename="' . basename(str_replace('"', '', $found['original_name'] ?? $storedName)) . '"');
header('Content-Length: ' . (string)filesize($path));
readfile($path);
exit;
