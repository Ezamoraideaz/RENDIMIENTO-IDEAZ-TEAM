<?php
// Acceso a Google Ads por OAuth.
//
// El refresh token vive cifrado en app_settings ('google_ads_refresh_token') y lo guarda el
// botón "Conectar Google Ads" de Pauta (backend/oauth/google_ads_connect.php →
// google_ads_callback.php). Si todavía no hay uno en la BD se usa GOOGLE_REFRESH_TOKEN de
// api/config.php (instalaciones anteriores). Client ID, Client Secret, Developer token y
// MCC siguen en api/config.php.
//
// Por qué se vencía: si la app de OAuth en Google Cloud está en modo "Testing", Google
// invalida los refresh tokens a los 7 días ("invalid_grant"). Hay que pasarla a
// "In production" una vez (ver CLAUDE.md → Pauta / Google Ads).

const GOOGLE_ADS_SETTING_KEY = 'google_ads_refresh_token';
const GOOGLE_ADS_SCOPE       = 'https://www.googleapis.com/auth/adwords';

function google_ads_load_api_config(): void
{
    $file = __DIR__ . '/../../api/config.php';
    if (is_file($file)) {
        require_once $file;
    }
}

function google_ads_redirect_uri(): string
{
    return APP_BASE_URL . '/backend/oauth/google_ads_callback.php';
}

function google_ads_client_configured(): bool
{
    return defined('GOOGLE_CLIENT_ID') && GOOGLE_CLIENT_ID !== ''
        && defined('GOOGLE_CLIENT_SECRET') && GOOGLE_CLIENT_SECRET !== '';
}

/** @return array{token: ?string, source: string, updated_at: ?string} */
function google_ads_refresh_token(): array
{
    try {
        $stmt = db()->prepare('SELECT value_encrypted, iv, updated_at FROM app_settings WHERE setting_key = ?');
        $stmt->execute([GOOGLE_ADS_SETTING_KEY]);
        $row = $stmt->fetch();
        if ($row) {
            return [
                'token'      => decrypt_token($row['value_encrypted'], $row['iv']),
                'source'     => 'db',
                'updated_at' => $row['updated_at'],
            ];
        }
    } catch (Throwable $e) {
        // BD no disponible o valor ilegible (¿cambió ENCRYPTION_KEY?): se intenta con config.php
    }
    if (defined('GOOGLE_REFRESH_TOKEN') && GOOGLE_REFRESH_TOKEN !== '') {
        return ['token' => GOOGLE_REFRESH_TOKEN, 'source' => 'config', 'updated_at' => null];
    }
    return ['token' => null, 'source' => 'none', 'updated_at' => null];
}

function google_ads_save_refresh_token(string $token, ?int $operatorId): void
{
    $enc = encrypt_token($token);
    db()->prepare(
        'INSERT INTO app_settings (setting_key, value_encrypted, iv, updated_by) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE value_encrypted = VALUES(value_encrypted), iv = VALUES(iv), updated_by = VALUES(updated_by)'
    )->execute([GOOGLE_ADS_SETTING_KEY, $enc['ciphertext'], $enc['iv'], $operatorId]);
    google_ads_forget_access_token();
}

/** POST al endpoint de tokens de Google. Devuelve el JSON decodificado o ['error' => ..., 'error_description' => ...]. */
function google_ads_token_request(array $fields): array
{
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL            => 'https://oauth2.googleapis.com/token',
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => http_build_query($fields),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
    ]);
    $response = curl_exec($ch);
    $curlErr  = curl_error($ch);
    curl_close($ch);
    if ($curlErr) {
        return ['error' => 'network', 'error_description' => "cURL: {$curlErr}"];
    }
    $data = json_decode((string)$response, true);
    return is_array($data) ? $data : ['error' => 'invalid_response', 'error_description' => 'Respuesta no válida de Google'];
}

// El access token dura ~1 hora: se guarda en un archivo temporal para no pedir uno nuevo
// en cada consulta de gasto (Pauta hace una por cliente y plataforma).
function google_ads_access_token_cache_file(): string
{
    return sys_get_temp_dir() . '/pauta_google_access_token_' . md5(APP_BASE_URL);
}

function google_ads_forget_access_token(): void
{
    @unlink(google_ads_access_token_cache_file());
}

/**
 * Access token vigente para la API de Google Ads.
 * @return array{access_token?: string, error?: string, reauth?: bool}
 */
function google_ads_access_token(): array
{
    if (!google_ads_client_configured()) {
        return ['error' => 'Credenciales de Google Ads no configuradas en api/config.php (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'];
    }

    $cacheFile = google_ads_access_token_cache_file();
    if (is_file($cacheFile)) {
        $cached = json_decode((string)@file_get_contents($cacheFile), true);
        if (!empty($cached['access_token']) && ($cached['expires_at'] ?? 0) > time() + 60) {
            return ['access_token' => $cached['access_token']];
        }
    }

    $refresh = google_ads_refresh_token();
    if (!$refresh['token']) {
        return ['error' => 'Google Ads no está conectado. Conéctalo desde Pauta → "Conectar Google Ads".', 'reauth' => true];
    }

    $data = google_ads_token_request([
        'client_id'     => GOOGLE_CLIENT_ID,
        'client_secret' => GOOGLE_CLIENT_SECRET,
        'refresh_token' => $refresh['token'],
        'grant_type'    => 'refresh_token',
    ]);

    if (isset($data['error'])) {
        // invalid_grant = el refresh token venció o fue revocado (típico con la app en modo "Testing": 7 días)
        if ($data['error'] === 'invalid_grant') {
            return [
                'error'  => 'La conexión con Google Ads venció o fue revocada. Reconéctala desde Pauta → "Reconectar Google Ads".',
                'reauth' => true,
            ];
        }
        $desc = $data['error_description'] ?? '';
        return ['error' => "OAuth error ({$data['error']})" . ($desc !== '' ? ": {$desc}" : '')];
    }

    if (!empty($data['access_token'])) {
        @file_put_contents($cacheFile, json_encode([
            'access_token' => $data['access_token'],
            'expires_at'   => time() + (int)($data['expires_in'] ?? 3600),
        ]));
        @chmod($cacheFile, 0600);
    }
    return $data;
}
