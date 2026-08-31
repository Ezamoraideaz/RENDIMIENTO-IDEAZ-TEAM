<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/expense_attachments.php';

// Agregar/quitar adjuntos de un egreso ya existente (crear el egreso con sus
// primeros adjuntos va todo junto en expenses.php POST).

require_expenses_access();
$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'POST':
        $operator = require_state_changing_request();
        $expenseId = (int)($_POST['expense_id'] ?? 0);
        if ($expenseId <= 0) {
            json_error('expense_id requerido', 400);
        }
        $stmt = $pdo->prepare('SELECT id FROM expenses WHERE id = ?');
        $stmt->execute([$expenseId]);
        if (!$stmt->fetch()) {
            json_error('Egreso no encontrado', 404);
        }

        $files = expense_attachments_reindex_files();
        if (!$files) {
            json_error('No se recibió ningún archivo', 400);
        }
        $attachments = expense_attachments_store($pdo, $expenseId, $files);
        json_response(['attachments' => $attachments], 201);
        break;

    case 'DELETE':
        require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        $expenseId = (int)($_GET['expense_id'] ?? 0);
        if ($id <= 0 || $expenseId <= 0) {
            json_error('id y expense_id son requeridos', 400);
        }
        if (!expense_attachment_delete($pdo, $id, $expenseId)) {
            json_error('No encontrado', 404);
        }
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
