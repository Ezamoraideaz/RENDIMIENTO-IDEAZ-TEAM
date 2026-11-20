<?php
declare(strict_types=1);

// Adjuntos de un egreso (fotos de recibo/factura) — guardados en
// backend/storage/expense_receipts/<expense_id>/, bloqueada al acceso web
// directo por backend/.htaccess (a diferencia de backend/public/uploads/:
// esto nunca debe ser público, se sirve solo autenticado vía
// backend/api/expense_attachment.php). Se optimizan al subir con
// image_optimize.php para no acumular fotos de celular de varios MB — se
// descarta el original y solo se guarda el resultado optimizado.

require_once __DIR__ . '/image_optimize.php';

const EXPENSE_ATTACHMENT_ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const EXPENSE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const EXPENSE_ATTACHMENT_MAX_FILES = 10;

function expense_attachments_dir(int $expenseId): string
{
    return __DIR__ . '/../storage/expense_receipts/' . $expenseId;
}

// Reorganiza $_FILES['files'] (input name="files[]", sin anidar por campo —
// acá solo hay un tipo de adjunto, a diferencia de los briefs) a una lista plana.
function expense_attachments_reindex_files(): array
{
    if (empty($_FILES['files']['name']) || !is_array($_FILES['files']['name'])) {
        return [];
    }
    $out = [];
    foreach ($_FILES['files']['name'] as $i => $name) {
        if (($_FILES['files']['error'][$i] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) continue;
        $out[] = [
            'name' => (string)$name,
            'tmp_name' => (string)$_FILES['files']['tmp_name'][$i],
            'size' => (int)$_FILES['files']['size'][$i],
        ];
    }
    return $out;
}

// Optimiza, guarda en disco e inserta en expense_attachments. Devuelve las
// filas insertadas (con su id) para que el llamador las regrese en la respuesta.
function expense_attachments_store(PDO $pdo, int $expenseId, array $files): array
{
    if (!$files) {
        return [];
    }
    $dir = expense_attachments_dir($expenseId);
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }

    $inserted = [];
    $count = 0;
    foreach ($files as $file) {
        if ($count >= EXPENSE_ATTACHMENT_MAX_FILES) break;
        if ($file['size'] <= 0 || $file['size'] > EXPENSE_ATTACHMENT_MAX_BYTES) continue;
        $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if (!in_array($ext, EXPENSE_ATTACHMENT_ALLOWED_EXT, true)) continue;
        if (!is_uploaded_file($file['tmp_name'])) continue;

        $body = file_get_contents($file['tmp_name']);
        if ($body === false) continue;
        $mimeType = $ext === 'png' ? 'image/png' : ($ext === 'webp' ? 'image/webp' : 'image/jpeg');

        // Si GD no pudo optimizarla (formato raro/CMYK/webp sin soporte de
        // decode en este build), se guarda el original tal cual — nunca se
        // rechaza la subida solo porque no se pudo achicar.
        $optimized = image_optimize_bytes($body, $mimeType);
        $finalData = $optimized['data'] ?? $body;
        $finalExt = $optimized ? ($optimized['mimeType'] === 'image/png' ? 'png' : 'jpg') : $ext;
        $width = $optimized['width'] ?? null;
        $height = $optimized['height'] ?? null;
        if (!$width || !$height) {
            $info = @getimagesizefromstring($finalData);
            $width = $info[0] ?? null;
            $height = $info[1] ?? null;
        }

        $storedName = bin2hex(random_bytes(16)) . '.' . $finalExt;
        if (file_put_contents($dir . '/' . $storedName, $finalData) === false) continue;

        $originalName = mb_substr($file['name'], 0, 190);
        $stmt = $pdo->prepare('
            INSERT INTO expense_attachments (expense_id, stored_name, original_name, size, width, height)
            VALUES (?, ?, ?, ?, ?, ?)
        ');
        $stmt->execute([$expenseId, $storedName, $originalName, strlen($finalData), $width, $height]);
        $inserted[] = [
            'id' => (int)$pdo->lastInsertId(),
            'stored_name' => $storedName,
            'original_name' => $originalName,
            'size' => strlen($finalData),
            'width' => $width,
            'height' => $height,
        ];
        $count++;
    }
    return $inserted;
}

// Borra un adjunto puntual — archivo en disco + fila en BD.
function expense_attachment_delete(PDO $pdo, int $attachmentId, int $expenseId): bool
{
    $stmt = $pdo->prepare('SELECT stored_name FROM expense_attachments WHERE id = ? AND expense_id = ?');
    $stmt->execute([$attachmentId, $expenseId]);
    $row = $stmt->fetch();
    if (!$row) {
        return false;
    }
    $path = expense_attachments_dir($expenseId) . '/' . $row['stored_name'];
    if (is_file($path)) {
        @unlink($path);
    }
    $pdo->prepare('DELETE FROM expense_attachments WHERE id = ?')->execute([$attachmentId]);
    return true;
}

// Borra toda la carpeta de adjuntos de un egreso (al eliminar el egreso completo).
function expense_attachments_delete_all(int $expenseId): void
{
    $dir = expense_attachments_dir($expenseId);
    if (!is_dir($dir)) {
        return;
    }
    foreach (scandir($dir) ?: [] as $file) {
        if ($file === '.' || $file === '..') continue;
        @unlink($dir . '/' . $file);
    }
    @rmdir($dir);
}
