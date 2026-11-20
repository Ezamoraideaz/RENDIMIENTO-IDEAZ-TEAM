<?php
declare(strict_types=1);

// Recepción de mensajes de Telegram por "polling" (getUpdates) en vez de webhook.
// Se usa cuando el firewall del hosting bloquea las peticiones entrantes de Telegram
// (error 409 en el webhook): aquí es el servidor quien pregunta a Telegram, así que
// solo hace falta salida HTTPS. Lo ejecuta backend/cron/process_design_reviews.php.
// Telegram guarda los updates pendientes 24 h, así que nada se pierde si el cron se salta un turno.

require_once __DIR__ . '/design_review.php';

function telegram_poll_offset_file(): string
{
    return __DIR__ . '/../storage/telegram_offset.txt';
}

// Consulta y despacha updates durante hasta $seconds segundos (0 = una sola consulta rápida).
// Devuelve cuántos updates procesó.
function telegram_poll_run(PDO $pdo, int $seconds): int
{
    $file = telegram_poll_offset_file();
    @mkdir(dirname($file), 0700, true);
    $offset = (int)@file_get_contents($file);

    $deadline = time() + max(0, $seconds);
    $handled = 0;
    $errors = 0;
    $webhookRemoved = false;

    do {
        $timeout = max(0, min(10, $deadline - time()));
        $updates = telegram_call('getUpdates', [
            'offset'          => $offset,
            'timeout'         => $timeout,
            'limit'           => 50,
            'allowed_updates' => ['message', 'callback_query'],
        ], $timeout + 15);

        if ($updates === null) {
            // getUpdates no funciona mientras haya un webhook registrado: quitarlo (una sola vez).
            if (!$webhookRemoved && stripos((string)telegram_last_error(), 'webhook') !== false) {
                telegram_call('deleteWebhook', ['drop_pending_updates' => false]);
                $webhookRemoved = true;
                continue;
            }
            if (++$errors >= 3) {
                break;
            }
            sleep(2);
            continue;
        }
        $errors = 0;

        foreach ($updates as $update) {
            try {
                design_review_dispatch_update($pdo, $update);
            } catch (Throwable $e) {
                error_log('[telegram poll] update ' . ($update['update_id'] ?? '?') . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            }
            $offset = (int)$update['update_id'] + 1;
            @file_put_contents($file, (string)$offset, LOCK_EX); // confirmar de a uno: un fallo no re-procesa los anteriores
            $handled++;
        }
    } while (time() < $deadline);

    return $handled;
}
