<?php
declare(strict_types=1);

// Cliente mínimo del Bot API de Telegram para la revisión de piezas con IA.
// Nunca lanza excepciones por fallos de red: devuelve null y deja el motivo en
// telegram_last_error() (mismo criterio que google_sheets_last_error()).

function telegram_last_error(?string $set = null): ?string
{
    static $last = null;
    if ($set !== null) {
        $last = $set;
        error_log('[telegram] ' . $set);
    }
    return $last;
}

function telegram_configured(): bool
{
    return defined('TELEGRAM_BOT_TOKEN') && TELEGRAM_BOT_TOKEN !== '';
}

// Llama a un método del Bot API. Devuelve el campo "result" o null si falló.
function telegram_call(string $method, array $params = [], int $timeout = 20): mixed
{
    if (!telegram_configured()) {
        telegram_last_error('TELEGRAM_BOT_TOKEN no está definido en config.php');
        return null;
    }
    $ch = curl_init('https://api.telegram.org/bot' . TELEGRAM_BOT_TOKEN . '/' . $method);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode($params, JSON_UNESCAPED_UNICODE),
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT        => $timeout,
    ]);
    $raw = curl_exec($ch);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        telegram_last_error("{$method}: " . $curlErr);
        return null;
    }
    $data = json_decode((string)$raw, true);
    if (!is_array($data) || empty($data['ok'])) {
        telegram_last_error("{$method}: " . ($data['description'] ?? (string)$raw));
        return null;
    }
    return $data['result'] ?? true;
}

function telegram_send_message(int $chatId, string $html, ?int $replyTo = null, ?array $keyboard = null): ?array
{
    $params = [
        'chat_id'                  => $chatId,
        'text'                     => $html,
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => true,
    ];
    if ($replyTo) {
        $params['reply_parameters'] = ['message_id' => $replyTo, 'allow_sending_without_reply' => true];
    }
    if ($keyboard) {
        $params['reply_markup'] = ['inline_keyboard' => $keyboard];
    }
    $res = telegram_call('sendMessage', $params);
    return is_array($res) ? $res : null;
}

function telegram_edit_message(int $chatId, int $messageId, string $html, ?array $keyboard = null): bool
{
    $params = [
        'chat_id'                  => $chatId,
        'message_id'               => $messageId,
        'text'                     => $html,
        'parse_mode'               => 'HTML',
        'disable_web_page_preview' => true,
        'reply_markup'             => ['inline_keyboard' => $keyboard ?? []],
    ];
    return telegram_call('editMessageText', $params) !== null;
}

function telegram_answer_callback(string $callbackId, string $text = '', bool $alert = false): void
{
    telegram_call('answerCallbackQuery', [
        'callback_query_id' => $callbackId,
        'text'              => $text,
        'show_alert'        => $alert,
    ]);
}

// Escapa texto para parse_mode=HTML de Telegram.
function tg_h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

// Descarga un archivo del chat al disco. El Bot API estándar limita la descarga
// a 20 MB. Devuelve ['path' => ..., 'size' => ...] o ['error' => 'too_big'|'download'].
function telegram_download_file(string $fileId, string $destDir, string $baseName): array
{
    $info = telegram_call('getFile', ['file_id' => $fileId]);
    if (!is_array($info) || empty($info['file_path'])) {
        $err = (string)telegram_last_error();
        return ['error' => stripos($err, 'too big') !== false ? 'too_big' : 'download'];
    }
    if (!is_dir($destDir)) {
        @mkdir($destDir, 0700, true);
    }
    $ext = pathinfo((string)$info['file_path'], PATHINFO_EXTENSION);
    $path = rtrim($destDir, '/\\') . DIRECTORY_SEPARATOR . $baseName . ($ext !== '' ? '.' . $ext : '');

    $fh = fopen($path, 'wb');
    if (!$fh) {
        return ['error' => 'download'];
    }
    $ch = curl_init('https://api.telegram.org/file/bot' . TELEGRAM_BOT_TOKEN . '/' . $info['file_path']);
    curl_setopt_array($ch, [
        CURLOPT_FILE           => $fh,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT        => 120,
    ]);
    $ok = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    fclose($fh);

    if ($ok === false || $status !== 200) {
        @unlink($path);
        telegram_last_error("Descarga de archivo falló (HTTP {$status})");
        return ['error' => 'download'];
    }
    return ['path' => $path, 'size' => (int)filesize($path)];
}

// Borra una carpeta temporal y su contenido (un nivel).
function tg_rrmdir(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    foreach (scandir($dir) ?: [] as $f) {
        if ($f !== '.' && $f !== '..') {
            @unlink($dir . DIRECTORY_SEPARATOR . $f);
        }
    }
    @rmdir($dir);
}
