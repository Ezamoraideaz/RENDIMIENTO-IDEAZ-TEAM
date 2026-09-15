<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';

// Formulario 1 — Rendición Trimestral de Gestión (una fila por cliente +
// trimestre + CM). El CM (rol `cm`) solo ve/edita sus propias filas;
// superadmin/admin ven todas y pueden reabrir una ya enviada. Ver
// require_rendicion_access() en includes/auth.php.
//
// Las respuestas de las secciones 2, 4, 5, 6, 7, 8 y 9 del formulario (MD)
// viven en la columna `answers` (JSON) — solo se sacan a columnas reales los
// campos numéricos/enum que el dashboard necesita filtrar o promediar
// directamente (ver migration_020_rendicion.sql).

const RENDICION_ACTIVITY_LEVELS = ['baja', 'media', 'alta'];
const RENDICION_HEALTH = ['verde', 'amarillo', 'rojo'];
const RENDICION_OPPORTUNITY_STAGES = ['detectada', 'reportada', 'presentada', 'cotizada', 'en_negociacion', 'aprobada', 'vendida', 'perdida', 'pendiente'];

$operator = require_rendicion_access();
$pdo = db();
$isAdmin = in_array($operator['role'], ['superadmin', 'admin'], true);

function rendicion_quarter_valid(string $q): bool
{
    return (bool)preg_match('/^\d{4}-Q[1-4]$/', $q);
}

function rendicion_row_out(array $row): array
{
    $intFields = ['meetings_total', 'meetings_planning', 'meetings_client_requested', 'meetings_cm_initiated',
        'followups_count', 'proactivity_self_score', 'pieces_generated', 'pieces_delivered', 'pieces_approved',
        'pieces_rework', 'creation_sessions', 'client_visits', 'incidents_count'];
    foreach ($intFields as $f) {
        $row[$f] = $row[$f] === null ? null : (int)$row[$f];
    }
    $row['has_risk'] = $row['has_risk'] === null ? null : (bool)$row['has_risk'];
    $row['contracted_services'] = $row['contracted_services'] ? json_decode($row['contracted_services'], true) : [];
    $row['answers'] = $row['answers'] ? json_decode($row['answers'], true) : [];
    return $row;
}

function rendicion_find(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM rendicion_forms WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function rendicion_opportunities_for(PDO $pdo, int $formId): array
{
    $stmt = $pdo->prepare('SELECT id, needs, services, stage, estimated_value, created_at FROM rendicion_opportunities WHERE rendicion_form_id = ? ORDER BY id ASC');
    $stmt->execute([$formId]);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $r['needs'] = $r['needs'] ? json_decode($r['needs'], true) : [];
        $r['services'] = $r['services'] ? json_decode($r['services'], true) : [];
        $r['estimated_value'] = $r['estimated_value'] === null ? null : (float)$r['estimated_value'];
    }
    unset($r);
    return $rows;
}

// Obligatorios cuando se envía en firme (status=submitted). Las condicionales
// (ej. razón de contenidos sin producir, detalle de riesgo) solo se exigen si
// el campo disparador aplica — así se respeta "DATOS CONDICIONALES" del MD.
function rendicion_validate_submit(array $input, array $answers): ?string
{
    if (empty($input['activity_level']) || !in_array($input['activity_level'], RENDICION_ACTIVITY_LEVELS, true)) {
        return 'Selecciona el nivel de actividad de la cuenta';
    }
    foreach (['meetings_total', 'proactivity_self_score', 'pieces_generated'] as $f) {
        if (!isset($input[$f]) || $input[$f] === '') {
            return 'Faltan datos de la sección de Gestión/Producción';
        }
    }
    if (empty($answers['calendar_status'])) {
        return 'Falta indicar si el calendario de contenido fue propuesto oportunamente';
    }
    if (($answers['unproduced_content'] ?? '') === 'si' && empty($answers['unproduced_reason'])) {
        return 'Falta indicar por qué quedaron contenidos sin producir';
    }
    if (!empty($input['opportunities_detected']) && empty($input['opportunities'])) {
        return 'Agrega al menos una oportunidad detectada o marca que no detectaste ninguna';
    }
    if (empty($answers['fidelizacion_detail'])) {
        return 'Falta la acción de mayor valor para fortalecer la relación con el cliente';
    }
    if (($input['incidents_count'] ?? 0) > 0 && empty($answers['error_detail'])) {
        return 'Falta describir qué ocurrió y cómo evitarlo';
    }
    $improvements = $answers['improvements'] ?? [];
    if (!is_array($improvements) || count(array_filter($improvements, fn($i) => !empty($i['problem']))) < 3) {
        return 'Se requieren al menos 3 oportunidades de mejora';
    }
    // "Conocimiento del cliente" es intencionalmente opcional: puede
    // completarse después, en la reunión de socialización presencial —
    // no bloquea el envío de la rendición.
    if (empty($input['account_health']) || !in_array($input['account_health'], RENDICION_HEALTH, true)) {
        return 'Selecciona la salud actual de la cuenta';
    }
    if (!empty($input['has_risk']) && empty($answers['risk_detail'])) {
        return 'Falta explicar el riesgo detectado y qué recomiendas hacer';
    }
    $value = $answers['value_generated'] ?? [];
    $requiredValueKeys = ['problem_detected', 'solved', 'opportunity_detected', 'additional_service', 'current_risk', 'next_quarter_action'];
    foreach ($requiredValueKeys as $k) {
        if (empty($value[$k])) {
            return 'Falta completar la sección "Valor generado para IDeaz"';
        }
    }
    return null;
}

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        if (($_GET['detail'] ?? '') === '1') {
            $id = (int)($_GET['id'] ?? 0);
            $row = $id > 0 ? rendicion_find($pdo, $id) : null;
            if (!$row) {
                json_error('No encontrado', 404);
            }
            if (!$isAdmin && (int)$row['operator_id'] !== (int)$operator['id']) {
                json_error('No autorizado', 403);
            }
            $row = rendicion_row_out($row);
            $row['opportunities'] = rendicion_opportunities_for($pdo, $id);
            json_response(['form' => $row]);
            break;
        }

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
            $where[] = 'f.client_id = ?';
            $params[] = (int)$_GET['client_id'];
        }
        if (($_GET['quarter'] ?? '') !== '') {
            $where[] = 'f.quarter = ?';
            $params[] = $_GET['quarter'];
        }
        if (($_GET['status'] ?? '') !== '') {
            $where[] = 'f.status = ?';
            $params[] = $_GET['status'];
        }
        $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

        $stmt = $pdo->prepare("
            SELECT f.id, f.client_id, f.operator_id, f.quarter, f.status, f.activity_level,
                   f.account_health, f.has_risk, f.pieces_approved, f.pieces_rework,
                   f.incidents_count, f.submitted_at, f.updated_at,
                   c.name AS client_name, c.logo_url AS client_logo_url, o.name AS operator_name
            FROM rendicion_forms f
            JOIN clients c ON c.id = f.client_id
            JOIN operators o ON o.id = f.operator_id
            {$whereSql}
            ORDER BY f.quarter DESC, c.name ASC
        ");
        $stmt->execute($params);
        $rows = $stmt->fetchAll();
        foreach ($rows as &$r) {
            $r['has_risk'] = $r['has_risk'] === null ? null : (bool)$r['has_risk'];
        }
        unset($r);
        json_response(['forms' => $rows]);
        break;

    case 'POST':
    case 'PUT':
        $operator = require_state_changing_request();
        $isAdmin = in_array($operator['role'], ['superadmin', 'admin'], true);
        $input = json_body();

        // Reabrir un formulario ya enviado (solo dueño/directivos) — no toca datos.
        if (($input['action'] ?? '') === 'reopen') {
            if (!$isAdmin) {
                json_error('No autorizado', 403);
            }
            $id = (int)($input['id'] ?? 0);
            if (!rendicion_find($pdo, $id)) {
                json_error('No encontrado', 404);
            }
            $pdo->prepare("UPDATE rendicion_forms SET status = 'draft', submitted_at = NULL WHERE id = ?")->execute([$id]);
            json_response(['ok' => true]);
            break;
        }

        $clientId = (int)($input['client_id'] ?? 0);
        $quarter = trim($input['quarter'] ?? '');
        if ($clientId <= 0 || !rendicion_quarter_valid($quarter)) {
            json_error('client_id y quarter (ej: 2026-Q3) son requeridos', 400);
        }

        $existingId = (int)($input['id'] ?? 0);
        $existing = $existingId > 0 ? rendicion_find($pdo, $existingId) : null;
        if ($existing && !$isAdmin && (int)$existing['operator_id'] !== (int)$operator['id']) {
            json_error('No autorizado', 403);
        }
        if ($existing && $existing['status'] === 'submitted') {
            json_error('Este formulario ya fue enviado; un administrador debe reabrirlo primero', 409);
        }
        $formOperatorId = $existing ? (int)$existing['operator_id'] : (int)$operator['id'];

        $answers = is_array($input['answers'] ?? null) ? $input['answers'] : [];
        $wantsSubmit = !empty($input['submit']);
        if ($wantsSubmit) {
            $error = rendicion_validate_submit($input, $answers);
            if ($error) {
                json_error($error, 400);
            }
        }

        $intOrNull = fn($v) => ($v === null || $v === '') ? null : (int)$v;
        $activityLevel = in_array($input['activity_level'] ?? '', RENDICION_ACTIVITY_LEVELS, true) ? $input['activity_level'] : null;
        $accountHealth = in_array($input['account_health'] ?? '', RENDICION_HEALTH, true) ? $input['account_health'] : null;
        $hasRisk = array_key_exists('has_risk', $input) && $input['has_risk'] !== '' ? (int)(bool)$input['has_risk'] : null;

        $fields = [
            'client_id' => $clientId,
            'operator_id' => $formOperatorId,
            'quarter' => $quarter,
            'status' => $wantsSubmit ? 'submitted' : 'draft',
            'activity_level' => $activityLevel,
            'contracted_services' => json_encode($input['contracted_services'] ?? []),
            'meetings_total' => $intOrNull($input['meetings_total'] ?? null),
            'meetings_planning' => $intOrNull($input['meetings_planning'] ?? null),
            'meetings_client_requested' => $intOrNull($input['meetings_client_requested'] ?? null),
            'meetings_cm_initiated' => $intOrNull($input['meetings_cm_initiated'] ?? null),
            'followups_count' => $intOrNull($input['followups_count'] ?? null),
            'avg_response_time' => trim($input['avg_response_time'] ?? '') ?: null,
            'proactivity_self_score' => $intOrNull($input['proactivity_self_score'] ?? null),
            'pieces_generated' => $intOrNull($input['pieces_generated'] ?? null),
            'pieces_delivered' => $intOrNull($input['pieces_delivered'] ?? null),
            'pieces_approved' => $intOrNull($input['pieces_approved'] ?? null),
            'pieces_rework' => $intOrNull($input['pieces_rework'] ?? null),
            'creation_sessions' => $intOrNull($input['creation_sessions'] ?? null),
            'client_visits' => $intOrNull($input['client_visits'] ?? null),
            'incidents_count' => $intOrNull($input['incidents_count'] ?? null),
            'account_health' => $accountHealth,
            'has_risk' => $hasRisk,
            'answers' => json_encode($answers),
        ];

        $pdo->beginTransaction();
        try {
            if ($existing) {
                $set = implode(', ', array_map(fn($k) => "{$k} = ?", array_keys($fields)));
                if ($wantsSubmit) {
                    $set .= ', submitted_at = NOW()';
                }
                $pdo->prepare("UPDATE rendicion_forms SET {$set} WHERE id = ?")
                    ->execute([...array_values($fields), $existing['id']]);
                $formId = (int)$existing['id'];
            } else {
                $cols = array_keys($fields);
                $placeholders = implode(', ', array_fill(0, count($cols), '?'));
                $sql = 'INSERT INTO rendicion_forms (' . implode(', ', $cols) . ($wantsSubmit ? ', submitted_at' : '') . ')
                        VALUES (' . $placeholders . ($wantsSubmit ? ', NOW()' : '') . ')
                        ON DUPLICATE KEY UPDATE ' . implode(', ', array_map(fn($k) => "{$k} = VALUES({$k})", $cols))
                        . ($wantsSubmit ? ', submitted_at = NOW()' : '');
                $pdo->prepare($sql)->execute(array_values($fields));
                $stmt = $pdo->prepare('SELECT id FROM rendicion_forms WHERE client_id = ? AND quarter = ? AND operator_id = ?');
                $stmt->execute([$clientId, $quarter, $formOperatorId]);
                $formId = (int)$stmt->fetchColumn();
            }

            // Las oportunidades se reemplazan completas en cada guardado — es
            // más simple que hacer diff y el formulario siempre manda el set
            // completo vigente (ver js/rendicion.js).
            $pdo->prepare('DELETE FROM rendicion_opportunities WHERE rendicion_form_id = ?')->execute([$formId]);
            $opportunities = is_array($input['opportunities'] ?? null) ? $input['opportunities'] : [];
            if ($opportunities) {
                $oppStmt = $pdo->prepare('
                    INSERT INTO rendicion_opportunities (rendicion_form_id, client_id, needs, services, stage, estimated_value)
                    VALUES (?, ?, ?, ?, ?, ?)
                ');
                foreach ($opportunities as $opp) {
                    $stage = in_array($opp['stage'] ?? '', RENDICION_OPPORTUNITY_STAGES, true) ? $opp['stage'] : 'detectada';
                    $value = isset($opp['estimated_value']) && $opp['estimated_value'] !== '' ? (float)$opp['estimated_value'] : null;
                    $oppStmt->execute([
                        $formId, $clientId,
                        json_encode($opp['needs'] ?? []),
                        json_encode($opp['services'] ?? []),
                        $stage, $value,
                    ]);
                }
            }

            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }

        json_response(['id' => $formId, 'status' => $wantsSubmit ? 'submitted' : 'draft']);
        break;

    default:
        json_error('Método no permitido', 405);
}
