<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Panel admin de la Encuesta Trimestral de Satisfacción (Formulario 2 del MD
// de Rendición) — una fila por (cliente, trimestre). El link público lo
// consume backend/public/survey_public.php (sin sesión, autenticado solo por
// token, mismo patrón que backend/api/client_briefs.php + brief_public.php).

require_rendicion_admin_access();
$pdo = db();

function client_surveys_quarter_valid(string $q): bool
{
    return (bool)preg_match('/^\d{4}-Q[1-4]$/', $q);
}

function client_surveys_row_out(array $row): array
{
    $ratingFields = ['rating_ideaz', 'rating_cm', 'rating_response_time', 'rating_quality', 'rating_creativity',
        'rating_commitment', 'rating_communication', 'rating_understands_business', 'rating_overall', 'nps'];
    foreach ($ratingFields as $f) {
        if (array_key_exists($f, $row)) {
            $row[$f] = $row[$f] === null ? null : (int)$row[$f];
        }
    }
    return $row;
}

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $clientId = (int)($_GET['client_id'] ?? 0);
        $quarter = trim($_GET['quarter'] ?? '');
        if ($clientId <= 0 || !client_surveys_quarter_valid($quarter)) {
            json_error('client_id y quarter (ej: 2026-Q3) son requeridos', 400);
        }
        $stmt = $pdo->prepare('
            SELECT id, status, filled_by_name, filled_at, (token_hash IS NOT NULL) AS link_generated,
                   rating_ideaz, rating_cm, rating_response_time, rating_quality, rating_creativity,
                   rating_commitment, rating_communication, rating_understands_business, rating_overall, nps,
                   value_most, improve_what, wish_feature
            FROM client_surveys WHERE client_id = ? AND quarter = ?
        ');
        $stmt->execute([$clientId, $quarter]);
        $row = $stmt->fetch();
        if (!$row) {
            json_response(['survey' => null]);
            break;
        }
        $row['link_generated'] = (bool)$row['link_generated'];
        json_response(['survey' => client_surveys_row_out($row)]);
        break;

    case 'POST':
        $operator = require_state_changing_request();
        $input = json_body();
        $clientId = (int)($input['client_id'] ?? 0);
        $quarter = trim($input['quarter'] ?? '');
        $action = $input['action'] ?? '';
        if ($clientId <= 0 || !client_surveys_quarter_valid($quarter)) {
            json_error('client_id y quarter válidos son requeridos', 400);
        }

        $pdo->prepare('INSERT IGNORE INTO client_surveys (client_id, quarter, created_by) VALUES (?, ?, ?)')
            ->execute([$clientId, $quarter, $operator['id']]);

        if ($action === 'generate_link') {
            $rawToken = bin2hex(random_bytes(32));
            $tokenHash = hash('sha256', $rawToken);
            // Regenerar pisa el hash anterior; las respuestas ya guardadas
            // (si el cliente ya lo había llenado) no se borran, solo status
            // vuelve a 'pending' hasta que llegue un envío nuevo.
            $pdo->prepare("
                UPDATE client_surveys SET token_hash = ?, status = 'pending' WHERE client_id = ? AND quarter = ?
            ")->execute([$tokenHash, $clientId, $quarter]);
            json_response(['token' => $rawToken]);
            break;
        }

        if ($action === 'revoke_link') {
            $pdo->prepare('UPDATE client_surveys SET token_hash = NULL WHERE client_id = ? AND quarter = ?')
                ->execute([$clientId, $quarter]);
            json_response(['ok' => true]);
            break;
        }

        json_error('action inválida', 400);
        break;

    default:
        json_error('Método no permitido', 405);
}
