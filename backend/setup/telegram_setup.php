<?php
// Registra / consulta el webhook del bot de Telegram SIN Terminal (cPanel).
//
// Uso:
//   1. En backend/config.php define SETUP_TOKEN, TELEGRAM_BOT_TOKEN y TELEGRAM_WEBHOOK_SECRET.
//   2. Visita en el navegador:
//        .../backend/setup/telegram_setup.php?token=EL_SETUP_TOKEN&action=set    (registrar)
//        .../backend/setup/telegram_setup.php?token=EL_SETUP_TOKEN&action=info   (ver estado)
//        .../backend/setup/telegram_setup.php?token=EL_SETUP_TOKEN&action=delete (quitar)
//   3. Al terminar, BORRA este archivo del servidor y vacía SETUP_TOKEN en config.php.

declare(strict_types=1);

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/telegram_api.php';

header('Content-Type: text/plain; charset=utf-8');

if (!defined('SETUP_TOKEN') || SETUP_TOKEN === '') {
    http_response_code(403);
    exit('SETUP_TOKEN no está configurado en backend/config.php.');
}
if (!hash_equals(SETUP_TOKEN, (string)($_GET['token'] ?? ''))) {
    http_response_code(403);
    exit('Token inválido.');
}
if (!telegram_configured() || !defined('TELEGRAM_WEBHOOK_SECRET') || TELEGRAM_WEBHOOK_SECRET === '') {
    exit('Define TELEGRAM_BOT_TOKEN y TELEGRAM_WEBHOOK_SECRET en backend/config.php.');
}

$action = (string)($_GET['action'] ?? 'info');

if ($action === 'set') {
    $url = rtrim(APP_BASE_URL, '/') . '/backend/webhook/telegram.php';
    $res = telegram_call('setWebhook', [
        'url'             => $url,
        'secret_token'    => TELEGRAM_WEBHOOK_SECRET,
        'allowed_updates' => ['message', 'callback_query'],
        'drop_pending_updates' => true,
    ]);
    echo $res !== null ? "Webhook registrado en:\n{$url}\n" : 'Error: ' . telegram_last_error() . "\n";
    exit;
}

if ($action === 'delete') {
    $res = telegram_call('deleteWebhook', ['drop_pending_updates' => true]);
    echo $res !== null ? "Webhook eliminado.\n" : 'Error: ' . telegram_last_error() . "\n";
    exit;
}

$me = telegram_call('getMe');
$info = telegram_call('getWebhookInfo');
echo 'Bot: ' . json_encode($me, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n";
echo 'Webhook: ' . json_encode($info, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n";
if ($me === null || $info === null) {
    echo 'Error: ' . telegram_last_error() . "\n";
}
