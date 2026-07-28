<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/content_batch_lookup.php';
require_once __DIR__ . '/../includes/google_drive.php';

// Proxy de streaming para los videos del portal de revisión (revisar.html).
// El iframe de Google Drive (/preview) es una caja negra que no deja
// controlar play/volumen desde JS — este endpoint transmite el archivo real
// (vía la cuenta de servicio, con acceso de Editor a "Para aprobación") para
// poder usar un <video> nativo con autoplay y audio real.
//
// Reenvía el header Range del navegador tal cual a la API de Drive (alt=media
// soporta range requests), así el <video> puede cargar/buscar por partes sin
// bajar el archivo completo cada vez. Sin sesión — se autentica solo con el
// token del link, igual que review.php (mismo modelo que password_resets).

$rawToken = trim($_GET['t'] ?? '');
$itemId = (int)($_GET['item_id'] ?? 0);
$mediaIndex = (int)($_GET['i'] ?? -1);

if ($rawToken === '' || $itemId <= 0 || $mediaIndex < 0) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=utf-8');
    exit('t, item_id e i son requeridos');
}

$pdo = db();
$batch = content_review_find_batch($pdo, $rawToken);
if (!$batch) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    exit('Link inválido');
}
$now = (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');
if ($batch['expires_at'] < $now) {
    http_response_code(410);
    header('Content-Type: text/plain; charset=utf-8');
    exit('Este link ya no es válido');
}

$stmt = $pdo->prepare('SELECT media FROM content_items WHERE id = ? AND batch_id = ?');
$stmt->execute([$itemId, $batch['id']]);
$item = $stmt->fetch();
if (!$item) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    exit('Pieza no encontrada en esta tanda');
}

$media = json_decode((string)$item['media'], true) ?: [];
$url = (string)($media[$mediaIndex]['url'] ?? '');
$fileId = $url !== '' ? google_drive_extract_file_id($url) : null;
if (!$fileId) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    exit('Archivo no encontrado en esa posición');
}

$token = google_drive_access_token();
if (!$token) {
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    exit('No se pudo conectar con Drive: ' . (google_drive_last_error() ?: 'error desconocido'));
}

$requestHeaders = ['Authorization: Bearer ' . $token];
if (!empty($_SERVER['HTTP_RANGE'])) {
    $requestHeaders[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
}

while (ob_get_level() > 0) {
    ob_end_clean();
}

$responseStatus = 200;
$responseHeaders = [];

$headerCallback = function ($ch, string $headerLine) use (&$responseStatus, &$responseHeaders): int {
    $len = strlen($headerLine);
    $trim = trim($headerLine);
    if ($trim === '') {
        return $len;
    }
    if (preg_match('#^HTTP/\S+\s+(\d+)#', $trim, $m)) {
        $responseStatus = (int)$m[1];
        $responseHeaders = [];
        return $len;
    }
    $parts = explode(':', $trim, 2);
    if (count($parts) === 2) {
        $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
    }
    return $len;
};

$headersSent = false;
$writeCallback = function ($ch, string $chunk) use (&$headersSent, &$responseStatus, &$responseHeaders): int {
    if (!$headersSent) {
        $headersSent = true;
        http_response_code($responseStatus);
        foreach (['content-type', 'content-length', 'content-range'] as $h) {
            if (isset($responseHeaders[$h])) {
                header(ucwords($h, '-') . ': ' . $responseHeaders[$h]);
            }
        }
        header('Accept-Ranges: bytes');
        header('Cache-Control: private, max-age=3600');
    }
    echo $chunk;
    if (ob_get_level() > 0) {
        @ob_flush();
    }
    @flush();
    return strlen($chunk);
};

$ch = curl_init("https://www.googleapis.com/drive/v3/files/{$fileId}?alt=media");
curl_setopt_array($ch, [
    CURLOPT_HTTPHEADER     => $requestHeaders,
    CURLOPT_HEADERFUNCTION => $headerCallback,
    CURLOPT_WRITEFUNCTION  => $writeCallback,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_TIMEOUT        => 0,
    CURLOPT_CONNECTTIMEOUT => 15,
]);
curl_exec($ch);
$curlErr = curl_error($ch);
curl_close($ch);

if (!$headersSent) {
    http_response_code(502);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'No se pudo transmitir el archivo desde Drive' . ($curlErr ? ": {$curlErr}" : '');
}
