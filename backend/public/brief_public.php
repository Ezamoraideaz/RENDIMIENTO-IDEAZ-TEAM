<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Portal público del formulario de brief (brief-publico.html?t=<token>). Sin
// sesión, sin CSRF — se autentica solo con el token del link, mismo patrón
// que organic_leads_public.php / review.php. La lista completa de campos por
// tipo de brief vive en js/briefSchemas.js (frontend); acá solo se valida un
// subconjunto de campos requeridos como respaldo server-side — si se agregan
// campos requeridos nuevos al schema, hay que reflejarlos también aquí.

const BRIEF_TYPES = ['sitio_web', 'marketing_digital', 'branding'];

// Adjuntos (logo, manual de marca, catálogo...) — límites en línea con
// MAX_FILE_SIZE_MB/MAX_FILES_PER_FIELD de brief-publico.html; el frontend ya
// filtra antes de mandar, esto es el respaldo server-side.
const BRIEF_UPLOAD_ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'pdf', 'ai', 'eps', 'zip', 'xlsx'];
const BRIEF_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
const BRIEF_UPLOAD_MAX_FILES_PER_FIELD = 6;

// Reorganiza la estructura anidada que PHP arma para "files[field_key][]" —
// $_FILES['files']['name'] llega como { field_key: [nombre0, nombre1, ...] },
// no como una lista plana de archivos.
function brief_public_reindex_files(): array
{
    if (empty($_FILES['files']['name']) || !is_array($_FILES['files']['name'])) {
        return [];
    }
    $out = [];
    foreach ($_FILES['files']['name'] as $fieldKey => $names) {
        if (!is_array($names)) continue;
        $out[$fieldKey] = [];
        foreach ($names as $i => $name) {
            if (($_FILES['files']['error'][$fieldKey][$i] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) continue;
            $out[$fieldKey][] = [
                'name' => (string)$name,
                'tmp_name' => (string)$_FILES['files']['tmp_name'][$fieldKey][$i],
                'size' => (int)$_FILES['files']['size'][$fieldKey][$i],
            ];
        }
    }
    return $out;
}

// Mueve los archivos subidos a backend/storage/brief_uploads/<brief_id>/ (esa
// carpeta está bloqueada al acceso web directo, ver backend/.htaccess) con un
// nombre aleatorio — el nombre original y el nombre en disco se guardan junto
// a las demás respuestas en la columna answers. Devuelve solo lo que pasó
// validación; lo que no, se descarta en silencio (el frontend ya filtra
// tamaño/cantidad antes de mandar, así que no debería pasar en uso normal).
function brief_public_store_files(int $briefId, array $filesByField): array
{
    $dir = __DIR__ . '/../storage/brief_uploads/' . $briefId;
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    $stored = [];
    foreach ($filesByField as $fieldKey => $files) {
        $stored[$fieldKey] = [];
        $count = 0;
        foreach ($files as $file) {
            if ($count >= BRIEF_UPLOAD_MAX_FILES_PER_FIELD) break;
            if ($file['size'] <= 0 || $file['size'] > BRIEF_UPLOAD_MAX_BYTES) continue;
            $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
            if (!in_array($ext, BRIEF_UPLOAD_ALLOWED_EXT, true)) continue;
            if (!is_uploaded_file($file['tmp_name'])) continue;
            $storedName = bin2hex(random_bytes(16)) . '.' . $ext;
            if (!move_uploaded_file($file['tmp_name'], $dir . '/' . $storedName)) continue;
            $stored[$fieldKey][] = [
                'original_name' => mb_substr($file['name'], 0, 190),
                'stored_name' => $storedName,
                'size' => $file['size'],
            ];
            $count++;
        }
    }
    return $stored;
}

function brief_public_find(PDO $pdo, string $rawToken): ?array
{
    $tokenHash = hash('sha256', $rawToken);
    $stmt = $pdo->prepare('
        SELECT b.id, b.client_id, b.brief_type, b.status, b.answers, b.filled_by_name, b.filled_at,
               c.name AS client_name, c.logo_url AS client_logo_url
        FROM client_briefs b
        JOIN clients c ON c.id = b.client_id
        WHERE b.token_hash = ?
    ');
    $stmt->execute([$tokenHash]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function brief_public_validate(string $briefType, array $answers): ?string
{
    $required = [];
    switch ($briefType) {
        case 'sitio_web':
            $required = ['tipo_sitio', 'objetivo', 'publico_objetivo'];
            break;
        case 'marketing_digital':
            $required = ['objetivo_principal', 'publico_objetivo', 'plataformas', 'productos_a_promocionar'];
            break;
        case 'branding':
            $required = ['historia_mision', 'publico_objetivo', 'tiene_logo', 'estilo_visual', 'adjetivos'];
            break;
    }
    foreach ($required as $key) {
        $value = $answers[$key] ?? null;
        if ($value === null || $value === '' || (is_array($value) && !$value)) {
            return 'Falta completar un campo requerido del brief';
        }
    }
    if ($briefType === 'sitio_web') {
        $tipoSitio = $answers['tipo_sitio'] ?? '';
        if (!in_array($tipoSitio, ['landing', 'informativo', 'ecommerce'], true)) {
            return 'tipo_sitio inválido';
        }
        if ($tipoSitio === 'landing' && (empty($answers['landing_producto']) || empty($answers['landing_conversion']))) {
            return 'Falta completar los detalles de la landing page';
        }
        if ($tipoSitio === 'informativo' && empty($answers['info_secciones'])) {
            return 'Falta completar las secciones del sitio informativo';
        }
        if ($tipoSitio === 'ecommerce' && empty($answers['ecom_num_productos'])) {
            return 'Falta completar el número aproximado de productos';
        }
    }
    return null;
}

$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $rawToken = trim($_GET['t'] ?? '');
        if ($rawToken === '') {
            json_error('t requerido', 400);
        }
        $brief = brief_public_find($pdo, $rawToken);
        if (!$brief) {
            json_response(['status' => 'invalid']);
            break;
        }
        json_response([
            'status' => $brief['status'],
            'brief_type' => $brief['brief_type'],
            'client' => ['name' => $brief['client_name'], 'logo_url' => $brief['client_logo_url']],
            'filled_by_name' => $brief['filled_by_name'],
            'filled_at' => $brief['filled_at'],
        ]);
        break;

    case 'POST':
        // El wizard siempre manda multipart/form-data (ver brief-publico.html
        // /submitForm), incluso sin adjuntos — así hay un solo formato que
        // soportar: 't', 'filled_by_name', 'filled_by_email' como campos
        // sueltos, 'answers' como JSON en un campo de texto, y los archivos
        // como files[key][]. No se usa json_body(): con multipart, php://input
        // ya viene consumido hacia $_POST/$_FILES en la mayoría de los SAPI.
        $rawToken = trim($_POST['t'] ?? '');
        $filledByName = trim((string)($_POST['filled_by_name'] ?? ''));
        $filledByEmail = trim((string)($_POST['filled_by_email'] ?? ''));
        $answers = json_decode($_POST['answers'] ?? '', true);
        if ($rawToken === '') {
            json_error('t requerido', 400);
        }
        if (!is_array($answers)) {
            json_error('answers requerido', 400);
        }

        $brief = brief_public_find($pdo, $rawToken);
        if (!$brief) {
            json_error('Link inválido', 404);
        }
        if ($brief['status'] === 'filled') {
            json_error('Este brief ya fue enviado', 410);
        }

        if ($filledByName === '') {
            json_error('Tu nombre es requerido', 400);
        }
        if ($filledByEmail !== '' && !filter_var($filledByEmail, FILTER_VALIDATE_EMAIL)) {
            json_error('Correo inválido', 400);
        }

        $filesByField = brief_public_reindex_files();
        if ($filesByField) {
            $stored = brief_public_store_files((int)$brief['id'], $filesByField);
            foreach ($stored as $fieldKey => $items) {
                if ($items) {
                    $answers[$fieldKey] = $items;
                }
            }
        }

        $error = brief_public_validate($brief['brief_type'], $answers);
        if ($error) {
            json_error($error, 400);
        }

        $pdo->prepare("
            UPDATE client_briefs
            SET answers = ?, filled_by_name = ?, filled_by_email = ?, status = 'filled', filled_at = NOW()
            WHERE id = ?
        ")->execute([json_encode($answers), $filledByName, $filledByEmail ?: null, $brief['id']]);

        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
