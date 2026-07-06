<?php
declare(strict_types=1);

// Callback de eliminación de datos que exige Meta (Facebook Login / Messenger / Instagram).
// Meta hace un POST a esta URL con un `signed_request` firmado con el App Secret cuando
// una persona quita la app o solicita el borrado de sus datos. Aquí validamos la firma,
// borramos los datos de esa persona (sus contactos → y por ON DELETE CASCADE sus
// conversaciones, mensajes y acciones programadas) y devolvemos el JSON que Meta espera:
//   { "url": <página de estado>, "confirmation_code": <código> }
//
// No requiere login: lo llama Meta directamente, se autentica con la firma del App Secret.
require_once __DIR__ . '/../bootstrap.php';

// No debe ser indexado por buscadores.
header('X-Robots-Tag: noindex, nofollow', true);

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Método no permitido']);
    exit;
}

$signedRequest = $_POST['signed_request'] ?? '';
$data = parse_signed_request($signedRequest, META_APP_SECRET);

if ($data === null || empty($data['user_id'])) {
    http_response_code(400);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'signed_request inválido o sin user_id']);
    exit;
}

$externalUserId = (string)$data['user_id'];
$confirmationCode = bin2hex(random_bytes(8));
$status = 'completed';
$deleted = 0;

try {
    // El user_id del signed_request es el PSID/IGSID que guardamos en contacts.psid.
    // Al borrar el contacto, las FK ON DELETE CASCADE eliminan conversaciones,
    // mensajes y acciones programadas asociadas.
    $stmt = db()->prepare('DELETE FROM contacts WHERE psid = ?');
    $stmt->execute([$externalUserId]);
    $deleted = $stmt->rowCount();
} catch (Throwable $e) {
    $status = 'error';
}

try {
    db()->prepare('
        INSERT INTO deletion_requests (confirmation_code, external_user_id, contacts_deleted, status)
        VALUES (?, ?, ?, ?)
    ')->execute([$confirmationCode, $externalUserId, $deleted, $status]);
} catch (Throwable $e) {
    // Si no se pudo registrar, aún respondemos a Meta con un código válido.
}

$statusUrl = rtrim(APP_BASE_URL, '/') . '/backend/privacy/deletion_status.php?code=' . urlencode($confirmationCode);

http_response_code(200);
header('Content-Type: application/json; charset=utf-8');
echo json_encode([
    'url'               => $statusUrl,
    'confirmation_code' => $confirmationCode,
]);
exit;

/**
 * Valida y decodifica el signed_request de Meta (formato "{firma}.{payload}", ambos base64url).
 * La firma es HMAC-SHA256 del payload usando el App Secret. Devuelve el payload como array,
 * o null si la firma no coincide o el formato es inválido.
 */
function parse_signed_request(string $signedRequest, string $appSecret): ?array
{
    if (strpos($signedRequest, '.') === false) {
        return null;
    }
    [$encodedSig, $payload] = explode('.', $signedRequest, 2);

    $sig  = base64url_decode($encodedSig);
    $json = base64url_decode($payload);
    if ($sig === '' || $json === '') {
        return null;
    }

    $data = json_decode($json, true);
    if (!is_array($data)) {
        return null;
    }

    $expected = hash_hmac('sha256', $payload, $appSecret, true);
    if (!hash_equals($expected, $sig)) {
        return null; // firma inválida → no confiamos en el contenido
    }

    return $data;
}

function base64url_decode(string $input): string
{
    $decoded = base64_decode(strtr($input, '-_', '+/'), true);
    return $decoded === false ? '' : $decoded;
}
