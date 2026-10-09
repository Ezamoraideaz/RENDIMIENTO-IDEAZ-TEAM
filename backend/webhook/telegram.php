<?php
declare(strict_types=1);

// Webhook del bot de Telegram para la revisión de piezas con IA.
// Telegram lo llama (POST, JSON) en cada mensaje de los grupos donde el bot es admin
// y en cada clic de los botones inline. Aquí solo se encola el trabajo y se responde
// rápido; la revisión con IA la hace backend/cron/process_design_reviews.php.
// Registro del webhook: backend/setup/telegram_setup.php (ver CLAUDE.md).

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/design_review.php';

header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit('{"ok":false}');
}

// Telegram reenvía el secret_token configurado en setWebhook en esta cabecera.
$secret = defined('TELEGRAM_WEBHOOK_SECRET') ? (string)TELEGRAM_WEBHOOK_SECRET : '';
$sent = (string)($_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '');
if ($secret === '' || !hash_equals($secret, $sent)) {
    http_response_code(403);
    exit('{"ok":false}');
}

$update = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($update)) {
    http_response_code(400);
    exit('{"ok":false}');
}

// Siempre 200 hacia Telegram (si no, reintenta el mismo update en bucle); los fallos se registran.
try {
    $pdo = db();
    if (isset($update['message']) && is_array($update['message'])) {
        design_review_ingest_message($pdo, $update['message']);
    } elseif (isset($update['callback_query']) && is_array($update['callback_query'])) {
        design_review_handle_callback($pdo, $update['callback_query']);
    }
} catch (Throwable $e) {
    error_log('[telegram webhook] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
}

echo '{"ok":true}';
