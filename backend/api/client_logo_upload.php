<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Sube el logo de un cliente desde el equipo del operador — hasta ahora
// clients.php (PUT logo_url) solo aceptaba pegar un link ya hosteado en
// otro lado (Drive/Imgur/etc). El archivo se guarda en
// backend/public/uploads/client_logos/ (a diferencia de backend/storage/,
// esta carpeta SÍ es pública: el logo se muestra sin login en portales como
// revisar.html/leads-cliente.html/brief-publico.html) con un nombre
// aleatorio, y clients.logo_url se actualiza en el mismo request.

const CLIENT_LOGO_ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
const CLIENT_LOGO_MAX_BYTES = 5 * 1024 * 1024;
const CLIENT_LOGO_URL_PREFIX = 'backend/public/uploads/client_logos/';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

require_atencion_access();
require_state_changing_request();

$pdo = db();

$clientId = (int)($_POST['client_id'] ?? 0);
if ($clientId <= 0) {
    json_error('client_id requerido', 400);
}
if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    json_error('Archivo requerido', 400);
}
$file = $_FILES['file'];
if ($file['size'] <= 0 || $file['size'] > CLIENT_LOGO_MAX_BYTES) {
    json_error('El archivo pesa demasiado (máx. 5 MB)', 400);
}
$ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
if (!in_array($ext, CLIENT_LOGO_ALLOWED_EXT, true)) {
    json_error('Formato no soportado — usa PNG, JPG, WEBP o SVG', 400);
}
if (!is_uploaded_file($file['tmp_name'])) {
    json_error('Archivo inválido', 400);
}

$stmt = $pdo->prepare('SELECT logo_url FROM clients WHERE id = ?');
$stmt->execute([$clientId]);
$client = $stmt->fetch();
if (!$client) {
    json_error('Cliente no encontrado', 404);
}

$dir = __DIR__ . '/../public/uploads/client_logos';
if (!is_dir($dir)) {
    @mkdir($dir, 0755, true);
}
$storedName = $clientId . '_' . bin2hex(random_bytes(8)) . '.' . $ext;
if (!move_uploaded_file($file['tmp_name'], $dir . '/' . $storedName)) {
    json_error('No se pudo guardar el archivo', 500);
}

// Limpia el logo anterior solo si también fue subido por este mismo
// mecanismo — nunca toca un logo_url que sea un link externo pegado a mano.
$previous = (string)($client['logo_url'] ?? '');
if ($previous !== '' && str_contains($previous, CLIENT_LOGO_URL_PREFIX)) {
    $previousFile = $dir . '/' . basename($previous);
    if (is_file($previousFile)) {
        @unlink($previousFile);
    }
}

$logoUrl = CLIENT_LOGO_URL_PREFIX . $storedName;
$pdo->prepare('UPDATE clients SET logo_url = ? WHERE id = ?')->execute([$logoUrl, $clientId]);

json_response(['logo_url' => $logoUrl]);
