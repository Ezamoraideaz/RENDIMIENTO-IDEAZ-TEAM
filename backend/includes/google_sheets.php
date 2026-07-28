<?php
declare(strict_types=1);

// Lectura de la parrilla de contenido en vivo (Google Sheets) para la tanda
// automática de aprobaciones. Usa una cuenta de servicio de Google (JWT
// firmado con la llave privada, sin OAuth por usuario) — el mismo criterio
// que ya se explicó en el PRD: no hace falta que cada operador conecte su
// propia cuenta, y funciona aunque quien compartió el Sheet no sea quien
// consulta. Solo lectura (scope spreadsheets.readonly).
//
// La llave de la cuenta de servicio vive en backend/storage/ (gitignored,
// bloqueado por .htaccess) — nunca en el repo ni en config.php.

function google_sheets_access_token(): ?string
{
    if (!defined('GOOGLE_SERVICE_ACCOUNT_KEY_FILE') || !GOOGLE_SERVICE_ACCOUNT_KEY_FILE || !is_file(GOOGLE_SERVICE_ACCOUNT_KEY_FILE)) {
        error_log('[google_sheets] GOOGLE_SERVICE_ACCOUNT_KEY_FILE no está definido o el archivo no existe: ' . (defined('GOOGLE_SERVICE_ACCOUNT_KEY_FILE') ? GOOGLE_SERVICE_ACCOUNT_KEY_FILE : '(no definido)'));
        return null;
    }
    $key = json_decode((string)file_get_contents(GOOGLE_SERVICE_ACCOUNT_KEY_FILE), true);
    if (!is_array($key) || empty($key['client_email']) || empty($key['private_key'])) {
        error_log('[google_sheets] El archivo de la cuenta de servicio no es un JSON válido o le falta client_email/private_key');
        return null;
    }

    $b64 = static function ($data): string {
        $json = is_string($data) ? $data : json_encode($data);
        return rtrim(strtr(base64_encode($json), '+/', '-_'), '=');
    };

    $now = time();
    $header = ['alg' => 'RS256', 'typ' => 'JWT'];
    $claims = [
        'iss'   => $key['client_email'],
        'scope' => 'https://www.googleapis.com/auth/spreadsheets.readonly',
        'aud'   => 'https://oauth2.googleapis.com/token',
        'iat'   => $now,
        'exp'   => $now + 3600,
    ];
    $signingInput = $b64($header) . '.' . $b64($claims);

    $signature = '';
    $signed = openssl_sign($signingInput, $signature, $key['private_key'], 'sha256WithRSAEncryption');
    if (!$signed) {
        error_log('[google_sheets] openssl_sign falló — la private_key del JSON parece inválida (' . openssl_error_string() . ')');
        return null;
    }
    $jwt = $signingInput . '.' . $b64($signature);

    $ch = curl_init('https://oauth2.googleapis.com/token');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_POST           => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_POSTFIELDS     => http_build_query([
            'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion'  => $jwt,
        ]),
    ]);
    $raw = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($raw === false || $status !== 200) {
        error_log("[google_sheets] Fallo al pedir el access_token (HTTP {$status}): " . ($curlErr ?: $raw));
        return null;
    }
    $data = json_decode((string)$raw, true);
    if (empty($data['access_token'])) {
        error_log('[google_sheets] Google respondió 200 pero sin access_token: ' . $raw);
    }
    return $data['access_token'] ?? null;
}

// $range en formato A1, ej. "JULIO!A:G". Devuelve las filas crudas (array de
// arrays de celdas) o null si algo falló (credenciales, permisos, pestaña
// inexistente, etc.) — el caller decide cómo comunicar el error.
function google_sheets_get_values(string $spreadsheetId, string $range): ?array
{
    $token = google_sheets_access_token();
    if (!$token) {
        // El motivo específico ya quedó en el log dentro de google_sheets_access_token().
        return null;
    }

    $url = 'https://sheets.googleapis.com/v4/spreadsheets/' . rawurlencode($spreadsheetId) . '/values/' . rawurlencode($range);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $token],
    ]);
    $raw = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($raw === false || $status !== 200) {
        error_log("[google_sheets] Fallo al leer {$spreadsheetId}!{$range} (HTTP {$status}): " . ($curlErr ?: $raw));
        return null;
    }
    $data = json_decode((string)$raw, true);
    return is_array($data) ? ($data['values'] ?? []) : null;
}
