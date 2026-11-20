<?php
declare(strict_types=1);

// Reescala/recomprime una imagen recién subida con GD, adaptado del
// optimize_image_bytes() ya probado en backend/public/stream_media.php —
// misma lógica (rotación EXIF, evita tocar JPEG en CMYK, reescala al lado
// más largo), pero pensado para subida (no para servir al vuelo): acá el
// objetivo es ahorrar disco, así que el llamador debe descartar el original
// y quedarse solo con el resultado. Si GD no puede procesarla, devuelve null
// y el llamador decide guardar el original tal cual en vez de rechazar la subida.

function image_optimize_bytes(string $body, string $mimeType): ?array
{
    $MAX_SIDE = 1600;
    $JPEG_QUALITY = 80;

    $info = @getimagesizefromstring($body);
    if ($info && isset($info['channels']) && $info['channels'] === 4) {
        return null; // JPEG en CMYK — GD lo decodifica con los colores rotos
    }

    $im = @imagecreatefromstring($body);
    if ($im === false) {
        return null;
    }

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
    $outWidth = imagesx($im);
    $outHeight = imagesy($im);
    imagedestroy($im);

    if ($data === false || $data === '') {
        return null;
    }
    return ['data' => $data, 'mimeType' => $outMime, 'width' => $outWidth, 'height' => $outHeight];
}
