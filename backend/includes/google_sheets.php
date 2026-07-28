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

require_once __DIR__ . '/google_service_account.php';

// Guarda el motivo del último fallo para que el caller (sheet_import.php) lo
// pueda devolver en la respuesta JSON — en hosting compartido no siempre se
// puede confiar en que error_log() caiga en un archivo visible, así que el
// diagnóstico viaja también en la respuesta HTTP, no solo en el log.
function google_sheets_last_error(?string $set = null): ?string
{
    static $last = null;
    if ($set !== null) {
        $last = $set;
        error_log('[google_sheets] ' . $set);
    }
    return $last;
}

function google_sheets_access_token(): ?string
{
    return google_service_account_token(
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        function (string $msg): void { google_sheets_last_error($msg); }
    );
}

// Busca, entre las pestañas reales del Sheet, una que coincida con $wanted sin
// exigir coincidencia exacta: ignora mayúsculas/minúsculas y espacios de más
// (ej. "JULIO " con espacio al final), y si no hay match exacto acepta la
// primera pestaña cuyo nombre CONTENGA lo buscado (ej. "JULIO-AGOSTO" para
// "JULIO"). Devuelve el título EXACTO tal como está en el Sheet (para armar el
// rango A1 correctamente) o null si ninguna pestaña coincide.
function google_sheets_find_tab(string $spreadsheetId, string $wanted): ?string
{
    $token = google_sheets_access_token();
    if (!$token) {
        return null;
    }

    $url = 'https://sheets.googleapis.com/v4/spreadsheets/' . rawurlencode($spreadsheetId) . '?fields=' . rawurlencode('sheets.properties.title');
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
        google_sheets_last_error("Fallo al listar las pestañas del Sheet {$spreadsheetId} (HTTP {$status}): " . trim($curlErr ?: (string)$raw));
        return null;
    }
    $data = json_decode((string)$raw, true);
    $titles = array_map(fn($s) => (string)($s['properties']['title'] ?? ''), $data['sheets'] ?? []);

    $wantedNorm = mb_strtoupper(trim($wanted));

    foreach ($titles as $t) {
        if (mb_strtoupper(trim($t)) === $wantedNorm) {
            return $t; // match exacto (salvo espacios/mayúsculas)
        }
    }
    foreach ($titles as $t) {
        if ($wantedNorm !== '' && mb_strpos(mb_strtoupper($t), $wantedNorm) !== false) {
            return $t; // ej. pestaña "JULIO-AGOSTO" al buscar "JULIO"
        }
    }

    google_sheets_last_error("Ninguna pestaña del Sheet coincide con \"{$wanted}\" — pestañas disponibles: " . implode(', ', $titles));
    return null;
}

// Envuelve el nombre de pestaña en comillas simples para el rango A1 (necesario
// si el nombre tiene espacios o caracteres especiales), escapando comillas
// simples internas al estilo de Google Sheets (duplicándolas).
function google_sheets_quote_tab(string $tab): string
{
    return "'" . str_replace("'", "''", $tab) . "'";
}

// $range en formato A1, ej. "JULIO!A:G". Devuelve las filas crudas (array de
// arrays de celdas) o null si algo falló (credenciales, permisos, pestaña
// inexistente, etc.) — llamar google_sheets_last_error() después para saber por qué.
function google_sheets_get_values(string $spreadsheetId, string $range): ?array
{
    $token = google_sheets_access_token();
    if (!$token) {
        return null; // google_sheets_last_error() ya quedó seteado arriba
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
        google_sheets_last_error("Fallo al leer \"{$range}\" del Sheet {$spreadsheetId} (HTTP {$status}): " . trim($curlErr ?: (string)$raw));
        return null;
    }
    $data = json_decode((string)$raw, true);
    return is_array($data) ? ($data['values'] ?? []) : null;
}
