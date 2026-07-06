<?php
// Job de cPanel (Cron Jobs): ejecutar cada minuto, ej.
//   php /home/USUARIO/public_html/dashboard/backend/cron/process_scheduled.php
// Reclama las scheduled_actions vencidas, revalida la ventana de 24h en el momento de
// ejecución (pudo cerrarse desde que se agendó) y reanuda el flujo o marca el mensaje
// como "requiere seguimiento manual" para que aparezca en el inbox.

declare(strict_types=1);

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Este script solo puede ejecutarse desde cron/línea de comandos.');
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/crypto.php';
require_once __DIR__ . '/../includes/meta_client.php';
require_once __DIR__ . '/../includes/trigger_engine.php';

$pdo = db();

// Reclama en un solo UPDATE (con un timestamp propio, no NOW() de MySQL) para evitar
// doble envío si el cron se solapa con una corrida anterior todavía en curso.
$claimStamp = date('Y-m-d H:i:s');
$pdo->prepare('
    UPDATE scheduled_actions
    SET claimed_at = ?
    WHERE status = "pending" AND run_at <= NOW() AND claimed_at IS NULL
')->execute([$claimStamp]);

$stmt = $pdo->prepare('SELECT * FROM scheduled_actions WHERE status = "pending" AND claimed_at = ?');
$stmt->execute([$claimStamp]);
$pending = $stmt->fetchAll();

$processed = 0;
foreach ($pending as $action) {
    $processed++;
    $payload  = json_decode((string)$action['payload_json'], true) ?? [];
    $platform = $payload['platform'] ?? 'messenger';

    try {
        $result = TriggerEngine::runScheduledNode(
            (int)$action['conversation_id'],
            (int)$action['flow_id'],
            (string)$action['node_id'],
            $platform
        );

        $status = match ($result) {
            'sent' => 'sent',
            'needs_manual_followup' => 'needs_manual_followup',
            'cancelled' => 'cancelled',
            default => 'failed',
        };

        $pdo->prepare('
            UPDATE scheduled_actions
            SET status = ?, last_error = NULL, attempts = attempts + 1, updated_at = NOW()
            WHERE id = ?
        ')->execute([$status, $action['id']]);
    } catch (Throwable $e) {
        $pdo->prepare('
            UPDATE scheduled_actions
            SET status = "failed", last_error = ?, attempts = attempts + 1, updated_at = NOW()
            WHERE id = ?
        ')->execute([$e->getMessage(), $action['id']]);
    }
}

echo "Procesadas {$processed} acción(es) programada(s).\n";
