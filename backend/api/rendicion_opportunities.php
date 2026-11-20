<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Pipeline de oportunidades comerciales — a diferencia de rendicion_forms.php,
// este endpoint permite actualizar SOLO el estado/valor de una oportunidad ya
// reportada (ej. de "Detectada" a "Cotizada" o "Vendida") sin tener que
// reabrir y volver a enviar todo el formulario trimestral al que pertenece.
// Así se puede llevar el embudo al día (MD: "detectadas → reportadas →
// cotizadas → aprobadas → ventas") trimestre tras trimestre.
//
// El CM solo ve/edita las oportunidades de sus propios formularios;
// superadmin/admin ven y editan todas.

const RENDICION_OPPORTUNITY_STAGES_LIST = ['detectada', 'reportada', 'presentada', 'cotizada', 'en_negociacion', 'aprobada', 'vendida', 'perdida', 'pendiente'];

$operator = require_rendicion_access();
$pdo = db();
$isAdmin = in_array($operator['role'], ['superadmin', 'admin'], true);

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $where = [];
        $params = [];
        if (!$isAdmin) {
            $where[] = 'f.operator_id = ?';
            $params[] = $operator['id'];
        } elseif (($_GET['operator_id'] ?? '') !== '') {
            $where[] = 'f.operator_id = ?';
            $params[] = (int)$_GET['operator_id'];
        }
        if (($_GET['client_id'] ?? '') !== '') {
            $where[] = 'o.client_id = ?';
            $params[] = (int)$_GET['client_id'];
        }
        if (($_GET['quarter'] ?? '') !== '') {
            $where[] = 'f.quarter = ?';
            $params[] = $_GET['quarter'];
        }
        if (($_GET['stage'] ?? '') !== '') {
            $where[] = 'o.stage = ?';
            $params[] = $_GET['stage'];
        }
        $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

        $stmt = $pdo->prepare("
            SELECT o.id, o.rendicion_form_id, o.client_id, o.needs, o.services, o.stage, o.estimated_value, o.created_at,
                   f.quarter, f.operator_id, c.name AS client_name, op.name AS operator_name
            FROM rendicion_opportunities o
            JOIN rendicion_forms f ON f.id = o.rendicion_form_id
            JOIN clients c ON c.id = o.client_id
            JOIN operators op ON op.id = f.operator_id
            {$whereSql}
            ORDER BY f.quarter DESC, c.name ASC
        ");
        $stmt->execute($params);
        $rows = $stmt->fetchAll();
        foreach ($rows as &$r) {
            $r['needs'] = $r['needs'] ? json_decode($r['needs'], true) : [];
            $r['services'] = $r['services'] ? json_decode($r['services'], true) : [];
            $r['estimated_value'] = $r['estimated_value'] === null ? null : (float)$r['estimated_value'];
        }
        unset($r);
        json_response(['opportunities' => $rows]);
        break;

    case 'PUT':
        $operator = require_state_changing_request();
        $isAdmin = in_array($operator['role'], ['superadmin', 'admin'], true);
        $input = json_body();
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }

        $stmt = $pdo->prepare('
            SELECT o.id, f.operator_id
            FROM rendicion_opportunities o
            JOIN rendicion_forms f ON f.id = o.rendicion_form_id
            WHERE o.id = ?
        ');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) {
            json_error('No encontrado', 404);
        }
        if (!$isAdmin && (int)$row['operator_id'] !== (int)$operator['id']) {
            json_error('No autorizado', 403);
        }

        $fields = [];
        $values = [];
        if (array_key_exists('stage', $input)) {
            if (!in_array($input['stage'], RENDICION_OPPORTUNITY_STAGES_LIST, true)) {
                json_error('stage inválido', 400);
            }
            $fields[] = 'stage = ?';
            $values[] = $input['stage'];
        }
        if (array_key_exists('estimated_value', $input)) {
            $v = $input['estimated_value'];
            $fields[] = 'estimated_value = ?';
            $values[] = ($v === null || $v === '') ? null : (float)$v;
        }
        if (!$fields) {
            json_error('Nada para actualizar', 400);
        }
        $values[] = $id;
        $pdo->prepare('UPDATE rendicion_opportunities SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($values);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
