<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/meta_client.php';
require_once __DIR__ . '/../includes/trigger_engine.php';

$method = $_SERVER['REQUEST_METHOD'];

// ── Verificación de suscripción (Meta la llama al configurar el producto Webhooks) ──
if ($method === 'GET') {
    $mode      = $_GET['hub_mode'] ?? '';
    $token     = $_GET['hub_verify_token'] ?? '';
    $challenge = $_GET['hub_challenge'] ?? '';

    if ($mode === 'subscribe' && hash_equals(WEBHOOK_VERIFY_TOKEN, (string)$token)) {
        header('Content-Type: text/plain');
        echo $challenge;
        exit;
    }
    http_response_code(403);
    exit('Verificación fallida');
}

// ── Recepción de eventos (mensajes, postbacks, comentarios) ─────────────────────────
if ($method === 'POST') {
    $rawBody   = (string)file_get_contents('php://input');
    $signature = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? null;
    $signatureValid = MetaClient::verifySignature($rawBody, $signature, META_APP_SECRET);

    $payload  = json_decode($rawBody, true) ?? [];
    $object   = $payload['object'] ?? '';
    $platform = $object === 'instagram' ? 'instagram' : 'messenger';

    // Meta espera un 200 casi inmediato; respondemos ya y seguimos procesando.
    http_response_code(200);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['received' => true]);
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    }

    foreach ($payload['entry'] ?? [] as $entry) {
        $eventType = isset($entry['messaging']) ? 'messaging' : (isset($entry['changes']) ? 'changes' : 'unknown');

        $stmt = db()->prepare('
            INSERT INTO webhook_events (platform, event_type, raw_payload, signature_valid, received_at)
            VALUES (?, ?, ?, ?, NOW())
        ');
        $stmt->execute([$platform, $eventType, json_encode($entry), $signatureValid ? 1 : 0]);
        $eventId = (int)db()->lastInsertId();

        if (!$signatureValid) {
            mark_webhook_event_error($eventId, 'Firma X-Hub-Signature-256 inválida, evento ignorado');
            continue;
        }

        try {
            if ($eventType === 'messaging') {
                foreach ($entry['messaging'] as $messagingEvent) {
                    TriggerEngine::handleMessagingEvent($messagingEvent, $platform);
                }
            } elseif ($eventType === 'changes') {
                foreach ($entry['changes'] as $change) {
                    TriggerEngine::handleChangeEvent($change, $platform, (string)($entry['id'] ?? ''));
                }
            }
            mark_webhook_event_processed($eventId);
        } catch (Throwable $e) {
            mark_webhook_event_error($eventId, $e->getMessage());
        }
    }
    exit;
}

http_response_code(405);
exit;

function mark_webhook_event_processed(int $id): void
{
    db()->prepare('UPDATE webhook_events SET processed = 1, processed_at = NOW() WHERE id = ?')->execute([$id]);
}

function mark_webhook_event_error(int $id, string $error): void
{
    db()->prepare('UPDATE webhook_events SET processed = 0, error = ? WHERE id = ?')->execute([$error, $id]);
}
