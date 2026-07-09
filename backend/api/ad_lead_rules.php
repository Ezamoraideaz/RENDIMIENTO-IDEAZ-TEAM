<?php
require_once __DIR__ . '/../bootstrap.php';

// Reglas de "disparador por campaña/formulario" para leads de Meta Ads: a qué correo
// notificar y qué etiqueta aplicar. Vive aparte de flows.php porque no hay ningún
// grafo de flujo que ejecutar aquí — solo notificación + etiqueta (no hay canal de
// mensajería para un lead de formulario instantáneo).

require_atencion_access();
$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $socialAccountId = (int)($_GET['social_account_id'] ?? 0);
        if ($socialAccountId <= 0) {
            json_error('social_account_id requerido', 400);
        }
        $stmt = $pdo->prepare('SELECT * FROM ad_lead_rules WHERE social_account_id = ? ORDER BY priority DESC, id DESC');
        $stmt->execute([$socialAccountId]);
        json_response(['rules' => $stmt->fetchAll()]);
        break;

    case 'POST':
        require_state_changing_request();
        $input = json_body();
        $socialAccountId = (int)($input['social_account_id'] ?? 0);
        if ($socialAccountId <= 0) {
            json_error('social_account_id requerido', 400);
        }
        $formId = trim($input['form_id'] ?? '') ?: null;
        $campaignName = trim($input['campaign_name'] ?? '') ?: null;
        $tag = trim($input['tag'] ?? '') ?: null;
        $notifyEmail = trim($input['notify_email'] ?? '') ?: null;
        if ($tag === null && $notifyEmail === null) {
            json_error('Define al menos una etiqueta o un correo de notificación', 400);
        }
        if ($notifyEmail !== null && !filter_var($notifyEmail, FILTER_VALIDATE_EMAIL)) {
            json_error('Email inválido', 400);
        }
        $priority = (int)($input['priority'] ?? 0);

        $stmt = $pdo->prepare('
            INSERT INTO ad_lead_rules (social_account_id, campaign_name, form_id, tag, notify_email, priority)
            VALUES (?, ?, ?, ?, ?, ?)
        ');
        $stmt->execute([$socialAccountId, $campaignName, $formId, $tag, $notifyEmail, $priority]);
        json_response(['id' => (int)$pdo->lastInsertId()], 201);
        break;

    case 'PUT':
        require_state_changing_request();
        $input = json_body();
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $fields = [];
        $values = [];
        foreach (['campaign_name', 'form_id', 'tag', 'notify_email'] as $col) {
            if (array_key_exists($col, $input)) {
                $val = trim((string)$input[$col]) ?: null;
                if ($col === 'notify_email' && $val !== null && !filter_var($val, FILTER_VALIDATE_EMAIL)) {
                    json_error('Email inválido', 400);
                }
                $fields[] = "{$col} = ?";
                $values[] = $val;
            }
        }
        if (array_key_exists('priority', $input)) {
            $fields[] = 'priority = ?';
            $values[] = (int)$input['priority'];
        }
        if (array_key_exists('active', $input)) {
            $fields[] = 'active = ?';
            $values[] = (int)(!empty($input['active']));
        }
        if (!$fields) {
            json_error('Nada para actualizar', 400);
        }
        $values[] = $id;
        $pdo->prepare('UPDATE ad_lead_rules SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($values);
        json_response(['ok' => true]);
        break;

    case 'DELETE':
        require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $pdo->prepare('DELETE FROM ad_lead_rules WHERE id = ?')->execute([$id]);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
