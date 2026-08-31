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
            $required = ['nombre_proyecto', 'tipo_sitio', 'objetivo', 'publico_objetivo'];
            break;
        case 'marketing_digital':
            $required = ['marca_nombre', 'objetivo_principal', 'publico_objetivo', 'plataformas', 'productos_a_promocionar'];
            break;
        case 'branding':
            $required = ['nombre_marca', 'historia_mision', 'publico_objetivo', 'tiene_logo', 'estilo_visual', 'adjetivos'];
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
        $input = json_body();
        $rawToken = trim($input['t'] ?? '');
        if ($rawToken === '') {
            json_error('t requerido', 400);
        }
        $brief = brief_public_find($pdo, $rawToken);
        if (!$brief) {
            json_error('Link inválido', 404);
        }
        if ($brief['status'] === 'filled') {
            json_error('Este brief ya fue enviado', 410);
        }

        $answers = $input['answers'] ?? null;
        if (!is_array($answers)) {
            json_error('answers requerido', 400);
        }
        $filledByName = trim((string)($input['filled_by_name'] ?? ''));
        $filledByEmail = trim((string)($input['filled_by_email'] ?? ''));
        if ($filledByName === '') {
            json_error('Tu nombre es requerido', 400);
        }
        if ($filledByEmail !== '' && !filter_var($filledByEmail, FILTER_VALIDATE_EMAIL)) {
            json_error('Correo inválido', 400);
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
