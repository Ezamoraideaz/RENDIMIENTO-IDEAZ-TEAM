<?php
declare(strict_types=1);

// Mueve contenido aprobado de la carpeta "Para aprobación" de cada marca
// (externa, donde el cliente revisa) hacia su carpeta ARTES (año/mes/POST #),
// automatizando lo que antes hacía el diseñador a mano en Drive. Usa la misma
// cuenta de servicio que google_sheets.php, pero pidiendo el scope de Drive —
// que a diferencia de Sheets necesita permiso de EDITOR (no solo Lector) sobre
// ambas carpetas en Drive, porque acá sí escribe (mueve archivos, crea
// carpetas si faltan).

require_once __DIR__ . '/google_service_account.php';

function google_drive_last_error(?string $set = null): ?string
{
    static $last = null;
    if ($set !== null) {
        $last = $set;
        error_log('[google_drive] ' . $set);
    }
    return $last;
}

function google_drive_access_token(): ?string
{
    return google_service_account_token(
        'https://www.googleapis.com/auth/drive',
        function (string $msg): void { google_drive_last_error($msg); }
    );
}

// Petición genérica a la API de Drive v3. $body va como JSON en el cuerpo
// (para crear archivos); para operaciones que solo usan query params (mover
// un archivo) se omite.
function google_drive_request(string $method, string $url, ?array $body = null): ?array
{
    $token = google_drive_access_token();
    if (!$token) {
        return null; // google_drive_last_error() ya quedó seteado arriba
    }

    $headers = ['Authorization: Bearer ' . $token];
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_CUSTOMREQUEST  => $method,
    ];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        $opts[CURLOPT_POSTFIELDS] = json_encode($body);
    }
    $opts[CURLOPT_HTTPHEADER] = $headers;

    $ch = curl_init($url);
    curl_setopt_array($ch, $opts);
    $raw = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($raw === false || $status < 200 || $status >= 300) {
        google_drive_last_error("Drive API {$method} (HTTP {$status}): " . trim($curlErr ?: (string)$raw));
        return null;
    }
    $data = json_decode((string)$raw, true);
    return is_array($data) ? $data : [];
}

// El webViewLink de Drive nunca trae el nombre/extensión del archivo original,
// así que no hay forma de adivinar por la URL si algo es un video — hay que
// preguntarle a Drive. Se usa como respaldo para contenido creado antes de que
// el frontend empezara a guardar mimeType junto al archivo.
function google_drive_get_mime_type(string $fileId): ?string
{
    $data = google_drive_request('GET', "https://www.googleapis.com/drive/v3/files/{$fileId}?fields=mimeType");
    return $data['mimeType'] ?? null;
}

function google_drive_list_subfolders(string $parentId): ?array
{
    $q = rawurlencode("'{$parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
    $fields = rawurlencode('files(id,name)');
    $data = google_drive_request('GET', "https://www.googleapis.com/drive/v3/files?q={$q}&fields={$fields}&pageSize=100");
    return $data === null ? null : ($data['files'] ?? []);
}

// Archivos (no carpetas) sueltos dentro de una carpeta — usado para listar el
// contenido de un POST #N tanto en "Para aprobación" (aprobaciones.html) como
// en ARTES (agenda.html). thumbnailLink queda vacío para archivos que Drive
// todavía no terminó de procesar (recién subidos); el frontend ya sabe
// resolver eso mostrando el ícono genérico del tipo de archivo.
function google_drive_list_files(string $folderId): ?array
{
    $q = rawurlencode("'{$folderId}' in parents and trashed=false");
    $fields = rawurlencode('files(id,name,mimeType,webViewLink,thumbnailLink)');
    $data = google_drive_request('GET', "https://www.googleapis.com/drive/v3/files?q={$q}&fields={$fields}&pageSize=100");
    return $data === null ? null : ($data['files'] ?? []);
}

function google_drive_create_folder(string $name, string $parentId): ?string
{
    $data = google_drive_request('POST', 'https://www.googleapis.com/drive/v3/files', [
        'name'     => $name,
        'mimeType' => 'application/vnd.google-apps.folder',
        'parents'  => [$parentId],
    ]);
    return $data['id'] ?? null;
}

const GOOGLE_DRIVE_MONTHS_UPPER = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
    'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

// Encuentra (o crea si falta) la carpeta año → mes → "POST #N" dentro de la
// carpeta raíz de ARTES, con el mismo criterio de coincidencia flexible que ya
// usa js/drive.js (_matchYear/_matchMonth/_matchPost) para no depender de que
// el nombre sea idéntico carácter por carácter.
function google_drive_find_or_create_post_folder(string $rootFolderId, int $year, int $monthIdx, int $postNumber): ?string
{
    $yearStr = (string)$year;
    $monthName = GOOGLE_DRIVE_MONTHS_UPPER[$monthIdx] ?? null;
    if ($monthName === null) {
        google_drive_last_error("Mes inválido: {$monthIdx}");
        return null;
    }

    $rootFolders = google_drive_list_subfolders($rootFolderId);
    if ($rootFolders === null) {
        return null;
    }
    $yFolder = null;
    foreach ($rootFolders as $f) {
        if (trim((string)$f['name']) === $yearStr) {
            $yFolder = $f;
            break;
        }
    }
    $yFolderId = $yFolder['id'] ?? google_drive_create_folder($yearStr, $rootFolderId);
    if (!$yFolderId) {
        return null;
    }

    $yearFolders = google_drive_list_subfolders($yFolderId);
    if ($yearFolders === null) {
        return null;
    }
    $mFolder = null;
    foreach ($yearFolders as $f) {
        if (mb_strpos(mb_strtoupper((string)$f['name']), $monthName) !== false) {
            $mFolder = $f;
            break;
        }
    }
    $mFolderId = $mFolder['id'] ?? google_drive_create_folder("{$monthName} {$yearStr}", $yFolderId);
    if (!$mFolderId) {
        return null;
    }

    $monthFolders = google_drive_list_subfolders($mFolderId);
    if ($monthFolders === null) {
        return null;
    }
    foreach ($monthFolders as $f) {
        $nums = [];
        preg_match_all('/\d+/', (string)$f['name'], $matches);
        foreach ($matches[0] as $n) {
            if (strlen($n) <= 3) {
                $nums[] = (int)$n;
            }
        }
        if (in_array($postNumber, $nums, true)) {
            return $f['id'];
        }
    }
    return google_drive_create_folder("POST #{$postNumber}", $mFolderId);
}

// Extrae el fileId de Drive de una URL típica (webViewLink tipo
// ".../file/d/FILEID/view" o "...?id=FILEID").
function google_drive_extract_file_id(string $url): ?string
{
    if (preg_match('#/d/([a-zA-Z0-9_-]{10,})#', $url, $m)) {
        return $m[1];
    }
    if (preg_match('#[?&]id=([a-zA-Z0-9_-]{10,})#', $url, $m)) {
        return $m[1];
    }
    return null;
}

// Mueve un archivo/carpeta de Drive reemplazando todos sus padres actuales por
// $newParentId. Requiere permiso de Editor sobre el archivo y ambas carpetas
// (origen y destino) — no alcanza con "Lector".
function google_drive_move_file(string $fileId, string $newParentId): bool
{
    $meta = google_drive_request('GET', "https://www.googleapis.com/drive/v3/files/{$fileId}?fields=parents");
    if ($meta === null) {
        return false;
    }
    $oldParents = implode(',', $meta['parents'] ?? []);

    $url = "https://www.googleapis.com/drive/v3/files/{$fileId}?addParents=" . rawurlencode($newParentId)
        . ($oldParents !== '' ? '&removeParents=' . rawurlencode($oldParents) : '')
        . '&fields=id,parents';
    return google_drive_request('PATCH', $url) !== null;
}
