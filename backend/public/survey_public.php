<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Portal público de la Encuesta Trimestral de Satisfacción
// (encuesta-publica.html?t=<token>). Sin sesión, sin CSRF — se autentica solo
// con el token del link, mismo patrón que brief_public.php.

function survey_public_find(PDO $pdo, string $rawToken): ?array
{
    $tokenHash = hash('sha256', $rawToken);
    $stmt = $pdo->prepare('
        SELECT s.id, s.client_id, s.status, s.filled_by_name, s.filled_at,
               c.name AS client_name, c.logo_url AS client_logo_url
        FROM client_surveys s
        JOIN clients c ON c.id = s.client_id
        WHERE s.token_hash = ?
    ');
    $stmt->execute([$tokenHash]);
    $row = $stmt->fetch();
    return $row ?: null;
}

$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $rawToken = trim($_GET['t'] ?? '');
        if ($rawToken === '') {
            json_error('t requerido', 400);
        }
        $survey = survey_public_find($pdo, $rawToken);
        if (!$survey) {
            json_response(['status' => 'invalid']);
            break;
        }
        json_response([
            'status' => $survey['status'],
            'client' => ['name' => $survey['client_name'], 'logo_url' => $survey['client_logo_url']],
        ]);
        break;

    case 'POST':
        $input = json_body();
        $rawToken = trim($input['t'] ?? '');
        $filledByName = trim((string)($input['filled_by_name'] ?? ''));
        $filledByEmail = trim((string)($input['filled_by_email'] ?? ''));
        if ($rawToken === '') {
            json_error('t requerido', 400);
        }

        $survey = survey_public_find($pdo, $rawToken);
        if (!$survey) {
            json_error('Link inválido', 404);
        }
        if ($survey['status'] === 'filled') {
            json_error('Esta encuesta ya fue enviada', 410);
        }
        if ($filledByName === '') {
            json_error('Tu nombre es requerido', 400);
        }
        if ($filledByEmail !== '' && !filter_var($filledByEmail, FILTER_VALIDATE_EMAIL)) {
            json_error('Correo inválido', 400);
        }

        $ratingFields = ['rating_ideaz', 'rating_cm', 'rating_response_time', 'rating_quality', 'rating_creativity',
            'rating_commitment', 'rating_communication', 'rating_understands_business', 'rating_overall'];
        $values = [];
        foreach ($ratingFields as $f) {
            $v = (int)($input[$f] ?? 0);
            if ($v < 1 || $v > 5) {
                json_error('Falta completar todas las calificaciones', 400);
            }
            $values[$f] = $v;
        }
        $nps = (int)($input['nps'] ?? -1);
        if ($nps < 0 || $nps > 10) {
            json_error('Falta la calificación de recomendación (0-10)', 400);
        }

        $textFields = ['value_most' => true, 'improve_what' => false, 'wish_feature' => false];
        $texts = [];
        foreach ($textFields as $f => $required) {
            $v = mb_substr(trim((string)($input[$f] ?? '')), 0, 300);
            if ($required && $v === '') {
                json_error('Falta responder qué es lo que más valoras de trabajar con IDeaz', 400);
            }
            $texts[$f] = $v ?: null;
        }

        $pdo->prepare("
            UPDATE client_surveys
            SET rating_ideaz = ?, rating_cm = ?, rating_response_time = ?, rating_quality = ?, rating_creativity = ?,
                rating_commitment = ?, rating_communication = ?, rating_understands_business = ?, rating_overall = ?,
                nps = ?, value_most = ?, improve_what = ?, wish_feature = ?,
                filled_by_name = ?, filled_by_email = ?, status = 'filled', filled_at = NOW()
            WHERE id = ?
        ")->execute([
            $values['rating_ideaz'], $values['rating_cm'], $values['rating_response_time'], $values['rating_quality'],
            $values['rating_creativity'], $values['rating_commitment'], $values['rating_communication'],
            $values['rating_understands_business'], $values['rating_overall'],
            $nps, $texts['value_most'], $texts['improve_what'], $texts['wish_feature'],
            $filledByName, $filledByEmail ?: null,
            $survey['id'],
        ]);

        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
