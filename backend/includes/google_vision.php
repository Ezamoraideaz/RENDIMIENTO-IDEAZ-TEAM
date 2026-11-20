<?php
declare(strict_types=1);

// OCR de comprobantes de transferencia (módulo Egresos) — usa la misma
// cuenta de servicio de Google que google_sheets.php/google_drive.php, pero
// pidiendo el scope de Cloud Vision. A diferencia de Sheets/Drive, Cloud
// Vision necesita su propia API habilitada en el proyecto de Google Cloud Y
// una cuenta de facturación asociada (tiene cuota gratis mensual, pero no
// funciona en un proyecto sin facturación habilitada, aunque no se pase de
// la cuota) — ver CLAUDE.md paso 9.

require_once __DIR__ . '/google_service_account.php';

function google_vision_last_error(?string $set = null): ?string
{
    static $last = null;
    if ($set !== null) {
        $last = $set;
        error_log('[google_vision] ' . $set);
    }
    return $last;
}

function google_vision_access_token(): ?string
{
    return google_service_account_token(
        'https://www.googleapis.com/auth/cloud-vision',
        function (string $msg): void { google_vision_last_error($msg); }
    );
}

// Manda la imagen a Cloud Vision (TEXT_DETECTION) y devuelve el texto
// reconocido completo, o null si falló (ver google_vision_last_error()).
function google_vision_extract_text(string $imageBytes): ?string
{
    $token = google_vision_access_token();
    if (!$token) {
        return null; // google_vision_last_error() ya quedó seteado arriba
    }

    $body = [
        'requests' => [[
            'image' => ['content' => base64_encode($imageBytes)],
            'features' => [['type' => 'TEXT_DETECTION']],
            'imageContext' => ['languageHints' => ['es']],
        ]],
    ];

    $ch = curl_init('https://vision.googleapis.com/v1/images:annotate');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_POST           => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $token, 'Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode($body),
    ]);
    $raw = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($raw === false || $status < 200 || $status >= 300) {
        google_vision_last_error("Vision API (HTTP {$status}): " . trim($curlErr ?: (string)$raw));
        return null;
    }

    $data = json_decode((string)$raw, true);
    $response = $data['responses'][0] ?? null;
    if (!is_array($response)) {
        google_vision_last_error('Respuesta inesperada de Vision API');
        return null;
    }
    if (!empty($response['error']['message'])) {
        google_vision_last_error((string)$response['error']['message']);
        return null;
    }

    return $response['fullTextAnnotation']['text'] ?? '';
}
