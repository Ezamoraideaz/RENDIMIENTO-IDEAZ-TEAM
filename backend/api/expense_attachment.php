<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/expense_attachments.php';

// Sirve el archivo de un adjunto de egreso — SIEMPRE autenticado (a
// diferencia de los logos de cliente o los adjuntos de brief, un recibo de
// gasto nunca debe quedar accesible sin sesión). Un <img src="..."> normal
// puede usarlo sin token: el navegador manda la cookie de sesión sola en
// same-origin.

require_expenses_access();
$pdo = db();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_error('Método no permitido', 405);
}

$id = (int)($_GET['id'] ?? 0);
if ($id <= 0) {
    json_error('id requerido', 400);
}

$stmt = $pdo->prepare('SELECT expense_id, stored_name, original_name FROM expense_attachments WHERE id = ?');
$stmt->execute([$id]);
$row = $stmt->fetch();
if (!$row) {
    json_error('No encontrado', 404);
}

$path = expense_attachments_dir((int)$row['expense_id']) . '/' . $row['stored_name'];
if (!is_file($path)) {
    json_error('Archivo no encontrado en disco', 404);
}

$ext = strtolower(pathinfo($row['stored_name'], PATHINFO_EXTENSION));
$mimeType = $ext === 'png' ? 'image/png' : ($ext === 'webp' ? 'image/webp' : 'image/jpeg');

header('Content-Type: ' . $mimeType);
header('Content-Length: ' . (string)filesize($path));
header('Cache-Control: private, max-age=86400');
readfile($path);
exit;
