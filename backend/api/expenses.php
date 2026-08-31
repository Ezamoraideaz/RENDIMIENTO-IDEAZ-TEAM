<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/expense_attachments.php';

// Módulo Egresos (gastos y préstamos del equipo) — registro general de
// agencia, sin ligar a clientes/tableros de Trello. Ver require_expenses_access()
// en includes/auth.php (superadmin/admin/agenda_full — "PM" en CLAUDE.md).

require_expenses_access();
$pdo = db();

function expenses_row_out(array $row): array
{
    $row['amount'] = (float)$row['amount'];
    if (isset($row['attachment_count'])) {
        $row['attachment_count'] = (int)$row['attachment_count'];
    }
    return $row;
}

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        if (($_GET['detail'] ?? '') === '1') {
            $id = (int)($_GET['id'] ?? 0);
            if ($id <= 0) {
                json_error('id requerido', 400);
            }
            $stmt = $pdo->prepare('
                SELECT e.*, o.name AS created_by_name
                FROM expenses e LEFT JOIN operators o ON o.id = e.created_by
                WHERE e.id = ?
            ');
            $stmt->execute([$id]);
            $expense = $stmt->fetch();
            if (!$expense) {
                json_error('No encontrado', 404);
            }
            $attStmt = $pdo->prepare('
                SELECT id, original_name, size, width, height, created_at
                FROM expense_attachments WHERE expense_id = ? ORDER BY id ASC
            ');
            $attStmt->execute([$id]);
            json_response(['expense' => expenses_row_out($expense), 'attachments' => $attStmt->fetchAll()]);
            break;
        }

        $where = [];
        $params = [];
        if (($_GET['date_from'] ?? '') !== '') {
            $where[] = 'e.expense_date >= ?';
            $params[] = $_GET['date_from'];
        }
        if (($_GET['date_to'] ?? '') !== '') {
            $where[] = 'e.expense_date <= ?';
            $params[] = $_GET['date_to'];
        }
        if (in_array($_GET['type'] ?? '', ['gasto', 'prestamo'], true)) {
            $where[] = 'e.type = ?';
            $params[] = $_GET['type'];
        }
        if (($_GET['category'] ?? '') !== '') {
            $where[] = 'e.category = ?';
            $params[] = $_GET['category'];
        }
        if (in_array($_GET['reimbursement_status'] ?? '', ['pendiente', 'reembolsado'], true)) {
            $where[] = 'e.reimbursement_status = ?';
            $params[] = $_GET['reimbursement_status'];
        }
        $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

        $stmt = $pdo->prepare("
            SELECT e.*, (SELECT COUNT(*) FROM expense_attachments a WHERE a.expense_id = e.id) AS attachment_count
            FROM expenses e
            {$whereSql}
            ORDER BY e.expense_date DESC, e.id DESC
        ");
        $stmt->execute($params);
        json_response(['expenses' => array_map('expenses_row_out', $stmt->fetchAll())]);
        break;

    case 'POST':
        $operator = require_state_changing_request();

        $date = trim($_POST['expense_date'] ?? '');
        $type = $_POST['type'] ?? 'gasto';
        $category = trim($_POST['category'] ?? '');
        $account = trim($_POST['account'] ?? '');
        $concept = trim($_POST['concept'] ?? '');
        $amount = (float)($_POST['amount'] ?? 0);
        $currency = trim($_POST['currency'] ?? '') ?: 'COP';
        $notes = trim($_POST['notes'] ?? '') ?: null;

        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            json_error('Fecha inválida', 400);
        }
        if (!in_array($type, ['gasto', 'prestamo'], true)) {
            json_error('type inválido', 400);
        }
        if ($concept === '') {
            json_error('El concepto es requerido', 400);
        }
        if ($amount <= 0) {
            json_error('El monto debe ser mayor a 0', 400);
        }

        $paidByName = null;
        $reimbursementStatus = null;
        if ($type === 'prestamo') {
            $paidByName = trim($_POST['paid_by_name'] ?? '');
            if ($paidByName === '') {
                json_error('Indica quién puso el dinero', 400);
            }
            $reimbursementStatus = in_array($_POST['reimbursement_status'] ?? '', ['pendiente', 'reembolsado'], true)
                ? $_POST['reimbursement_status'] : 'pendiente';
        }
        $reimbursedAt = $reimbursementStatus === 'reembolsado' ? date('Y-m-d H:i:s') : null;

        $stmt = $pdo->prepare('
            INSERT INTO expenses (expense_date, type, category, account, concept, amount, currency, paid_by_name, reimbursement_status, reimbursed_at, notes, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ');
        $stmt->execute([$date, $type, $category, $account, $concept, $amount, $currency, $paidByName, $reimbursementStatus, $reimbursedAt, $notes, $operator['id']]);
        $id = (int)$pdo->lastInsertId();

        $files = expense_attachments_reindex_files();
        $attachments = expense_attachments_store($pdo, $id, $files);

        json_response(['id' => $id, 'attachments' => $attachments], 201);
        break;

    case 'PUT':
        require_state_changing_request();
        $input = json_body();
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $stmt = $pdo->prepare('SELECT id FROM expenses WHERE id = ?');
        $stmt->execute([$id]);
        if (!$stmt->fetch()) {
            json_error('No encontrado', 404);
        }

        $fields = [];
        $values = [];
        $editable = ['expense_date', 'type', 'category', 'account', 'concept', 'amount', 'currency', 'paid_by_name', 'notes'];
        foreach ($editable as $f) {
            if (array_key_exists($f, $input)) {
                $fields[] = "{$f} = ?";
                $values[] = is_string($input[$f]) ? trim($input[$f]) : $input[$f];
            }
        }
        if (array_key_exists('reimbursement_status', $input)) {
            $status = $input['reimbursement_status'];
            if (!in_array($status, ['pendiente', 'reembolsado'], true)) {
                json_error('reimbursement_status inválido', 400);
            }
            $fields[] = 'reimbursement_status = ?';
            $values[] = $status;
            $fields[] = 'reimbursed_at = ?';
            $values[] = $status === 'reembolsado' ? date('Y-m-d H:i:s') : null;
        }
        if (!$fields) {
            json_error('Nada para actualizar', 400);
        }
        $values[] = $id;
        $pdo->prepare('UPDATE expenses SET ' . implode(', ', $fields) . ' WHERE id = ?')->execute($values);
        json_response(['ok' => true]);
        break;

    case 'DELETE':
        require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $pdo->prepare('DELETE FROM expenses WHERE id = ?')->execute([$id]);
        expense_attachments_delete_all($id);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
