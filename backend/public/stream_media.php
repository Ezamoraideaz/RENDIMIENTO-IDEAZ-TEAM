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
$mimeType = (string)($media[$mediaIndex]['mimeType'] ?? '');
$forceDownload = ($_GET['dl'] ?? '') === '1';
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

while (ob_get_level() > 0) {
    ob_end_clean();
}

// Las imágenes se sirven achicadas (peor calidad casi imperceptible en la
// previsualización) para no pesar lo mismo que el archivo de diseño
// original — sin guardar la versión optimizada ni en Drive ni en disco acá,
// todo se procesa en memoria en cada request. Los videos NO pasan por esto
// (no hay ffmpeg en este hosting): siguen transmitiéndose tal cual, ver
// stream_video_passthrough() más abajo.
if (str_starts_with($mimeType, 'image/') && extension_loaded('gd')) {
    stream_optimized_image($fileId, $token, $mimeType);
    exit;
}

stream_video_passthrough($fileId, $token, $mimeType, $forceDownload, $itemId);
exit;

// ── Imágenes: descarga completa (no soporta Range, no hace falta para <img>),
// reescala si excede el lado máximo y recomprime en memoria con GD. Si GD no
// puede decodificarla (formato raro, CMYK, etc.) o el resultado no queda más
// liviano que el original, se sirve el archivo tal cual llegó de Drive —
// nunca a costa de verse peor o pesar más.
function stream_optimized_image(string $fileId, string $token, string $mimeType): void
{
    $ch = curl_init("https://www.googleapis.com/drive/v3/files/{$fileId}?alt=media");
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $token],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT        => 60,
        CURLOPT_CONNECTTIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($body === false || $status < 200 || $status >= 300) {
        http_response_code($status ?: 502);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'No se pudo transmitir el archivo desde Drive' . ($curlErr ? ": {$curlErr}" : '');
        return;
    }

    $optimized = optimize_image_bytes($body, $mimeType);
    if ($optimized === null || strlen($optimized['data']) >= strlen($body)) {
        header('Content-Type: ' . $mimeType);
        header('Content-Length: ' . strlen($body));
        header('Cache-Control: private, max-age=3600');
        echo $body;
        return;
    }

    header('Content-Type: ' . $optimized['mimeType']);
    header('Content-Length: ' . strlen($optimized['data']));
    header('Cache-Control: private, max-age=3600');
    echo $optimized['data'];
}

// Devuelve ['data' => bytes, 'mimeType' => ...] o null si no se pudo/convino
// optimizar (el llamador decide servir el original en ese caso).
function optimize_image_bytes(string $body, string $mimeType): ?array
{
    $MAX_SIDE = 1600;
    $JPEG_QUALITY = 82;

    // Los JPEG en CMYK (comunes en artes exportadas de InDesign/Photoshop)
    // GD los decodifica con los colores rotos — mejor no tocarlos.
    $info = @getimagesizefromstring($body);
    if ($info && isset($info['channels']) && $info['channels'] === 4) {
        return null;
    }

    $im = @imagecreatefromstring($body);
    if ($im === false) {
        return null;
    }

    // GD no lee el tag EXIF de orientación al decodificar — hay que rotar a
    // mano o las fotos de celular en portrait salen giradas.
    if (function_exists('exif_read_data') && str_contains($mimeType, 'jpeg')) {
        $stream = fopen('php://memory', 'r+');
        fwrite($stream, $body);
        rewind($stream);
        $exif = @exif_read_data($stream, null, false);
        fclose($stream);
        $orientation = $exif['Orientation'] ?? 1;
        if ($orientation === 3) {
            $im = imagerotate($im, 180, 0);
        } elseif ($orientation === 6) {
            $im = imagerotate($im, -90, 0);
        } elseif ($orientation === 8) {
            $im = imagerotate($im, 90, 0);
        }
    }

    $width = imagesx($im);
    $height = imagesy($im);
    $longest = max($width, $height);
    if ($longest > $MAX_SIDE) {
        $scale = $MAX_SIDE / $longest;
        $newW = (int)round($width * $scale);
        $newH = (int)round($height * $scale);
        $resized = imagescale($im, $newW, $newH, IMG_BICUBIC);
        if ($resized !== false) {
            imagedestroy($im);
            $im = $resized;
        }
    }

    $isPng = str_contains($mimeType, 'png');
    ob_start();
    if ($isPng) {
        imagesavealpha($im, true);
        imagepng($im, null, 6);
        $outMime = 'image/png';
    } else {
        imagejpeg($im, null, $JPEG_QUALITY);
        $outMime = 'image/jpeg';
    }
    $data = ob_get_clean();
    imagedestroy($im);

    if ($data === false || $data === '') {
        return null;
    }
    return ['data' => $data, 'mimeType' => $outMime];
}

// ── Videos: sin ffmpeg en este hosting no hay forma de comprimirlos al vuelo
// sin descargarlos enteros a disco (que es justo lo que no queremos), así que
// siguen transmitiéndose tal cual llegan de Drive — este es el proxy
// original, reenviando Range para permitir seek/streaming parcial.
function stream_video_passthrough(string $fileId, string $token, string $mimeType, bool $forceDownload, int $itemId): void
{
    $requestHeaders = ['Authorization: Bearer ' . $token];
    if (!empty($_SERVER['HTTP_RANGE'])) {
        $requestHeaders[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
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

    $downloadExtensions = ['mp4' => 'mp4', 'quicktime' => 'mov', 'webm' => 'webm', 'x-m4v' => 'm4v'];

    $headersSent = false;
    $writeCallback = function ($ch, string $chunk) use (&$headersSent, &$responseStatus, &$responseHeaders, $forceDownload, $mimeType, $itemId, $downloadExtensions): int {
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
            // Descarga real (no solo streaming inline) cuando el cliente toca el
            // ícono de descargar en revisar.html — el navegador guarda el archivo
            // en vez de intentar reproducirlo en la pestaña.
            if ($forceDownload && $responseStatus >= 200 && $responseStatus < 300) {
                $ext = null;
                if (preg_match('#^video/([\w.-]+)#', $mimeType, $mm)) {
                    $ext = $downloadExtensions[$mm[1]] ?? $mm[1];
                }
                $filename = 'video-' . $itemId . ($ext ? '.' . $ext : '');
                header('Content-Disposition: attachment; filename="' . $filename . '"');
            }
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
}
