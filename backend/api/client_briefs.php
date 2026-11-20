<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Panel admin del módulo "Briefs" (pestaña dentro de Atención al Cliente) —
// una fila por (cliente, tipo de brief). El link público lo consume
// backend/public/brief_public.php (sin sesión, autenticado solo por token,
// mismo patrón que organic_lead_share.php / organic_leads_public.php).

const BRIEF_TYPES = ['sitio_web', 'marketing_digital', 'branding'];

require_atencion_access();
$pdo = db();

// Crea las 3 filas (una por tipo de brief) la primera vez que se abre la
// pestaña de un cliente — así el resto del endpoint siempre puede asumir que
// existen, igual que project_settings/member_settings se crean al vuelo.
function client_briefs_ensure_rows(PDO $pdo, int $clientId, int $operatorId): void
{
    $stmt = $pdo->prepare('INSERT IGNORE INTO client_briefs (client_id, brief_type, created_by) VALUES (?, ?, ?)');
    foreach (BRIEF_TYPES as $type) {
        $stmt->execute([$clientId, $type, $operatorId]);
    }
}

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $clientId = (int)($_GET['client_id'] ?? 0);
        if ($clientId <= 0) {
            json_error('client_id requerido', 400);
        }

        // Detalle de un brief puntual (para "Ver respuestas" en el admin).
        if (($_GET['detail'] ?? '') === '1') {
            $briefType = $_GET['brief_type'] ?? '';
            if (!in_array($briefType, BRIEF_TYPES, true)) {
                json_error('brief_type inválido', 400);
            }
            $stmt = $pdo->prepare('
                SELECT brief_type, status, answers, filled_by_name, filled_by_email, filled_at
                FROM client_briefs WHERE client_id = ? AND brief_type = ?
            ');
            $stmt->execute([$clientId, $briefType]);
            $row = $stmt->fetch();
            if (!$row) {
                json_error('No encontrado', 404);
            }
            $row['answers'] = $row['answers'] ? json_decode($row['answers'], true) : null;
            json_response(['brief' => $row]);
            break;
        }

        $operator = current_operator();
        client_briefs_ensure_rows($pdo, $clientId, $operator['id']);

        // has_answers es independiente de status: al regenerar un link ya
        // lleno, status vuelve a 'pending' pero las respuestas anteriores se
        // conservan y siguen siendo consultables hasta que llegue una nueva.
        $stmt = $pdo->prepare('
            SELECT brief_type, status, filled_by_name, filled_at,
                   (token_hash IS NOT NULL) AS link_generated,
                   (answers IS NOT NULL) AS has_answers
            FROM client_briefs WHERE client_id = ?
        ');
        $stmt->execute([$clientId]);
        $rows = $stmt->fetchAll();
        foreach ($rows as &$r) {
            $r['link_generated'] = (bool)$r['link_generated'];
            $r['has_answers'] = (bool)$r['has_answers'];
        }
        unset($r);
        json_response(['briefs' => $rows]);
        break;

    case 'POST':
        $operator = require_state_changing_request();
        $input = json_body();
        $clientId = (int)($input['client_id'] ?? 0);
        $briefType = $input['brief_type'] ?? '';
        $action = $input['action'] ?? '';
        if ($clientId <= 0 || !in_array($briefType, BRIEF_TYPES, true)) {
            json_error('client_id y brief_type válidos son requeridos', 400);
        }
        client_briefs_ensure_rows($pdo, $clientId, $operator['id']);

        if ($action === 'generate_link') {
            $rawToken = bin2hex(random_bytes(32));
            $tokenHash = hash('sha256', $rawToken);
            // Regenerar pisa el hash anterior e invalida cualquier link previo
            // de este tipo de brief para este cliente. Las respuestas ya
            // guardadas NO se borran — solo se sobrescriben si llega un envío nuevo.
            $pdo->prepare("
                UPDATE client_briefs SET token_hash = ?, status = 'pending' WHERE client_id = ? AND brief_type = ?
            ")->execute([$tokenHash, $clientId, $briefType]);
            json_response(['token' => $rawToken]);
            break;
        }

        if ($action === 'revoke_link') {
            $pdo->prepare('UPDATE client_briefs SET token_hash = NULL WHERE client_id = ? AND brief_type = ?')
                ->execute([$clientId, $briefType]);
            json_response(['ok' => true]);
            break;
        }

        json_error('action inválida', 400);
        break;

    default:
        json_error('Método no permitido', 405);
}
