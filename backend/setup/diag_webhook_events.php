<?php
// Diagnóstico temporal: últimos webhook_events + estado de social_accounts/flows,
// para depurar por qué el flujo no responde a ciertos usuarios de Instagram.
// Salida en texto plano/Markdown (fácil de copiar y pegar en la conversación con Claude).
//
// Uso (una sola vez, mientras se depura):
//   1. Asegúrate que backend/config.php tiene SETUP_TOKEN definido (el mismo que
//      usaste para bootstrap_operator.php, o genera uno nuevo).
//   2. Sube este archivo al servidor y visita:
//      https://tudominio.com/dashboard/backend/setup/diag_webhook_events.php?token=EL_TOKEN
//   3. Copia TODO el resultado y pégalo en la conversación con Claude.
//   4. BORRA este archivo del servidor cuando termines — expone contenido de
//      conversaciones de clientes reales.

declare(strict_types=1);

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';

if (!defined('SETUP_TOKEN') || SETUP_TOKEN === '') {
    http_response_code(403);
    exit('SETUP_TOKEN no está configurado en backend/config.php. Define un valor aleatorio y vuelve a intentar.');
}

$token = (string)($_GET['token'] ?? '');
if ($token === '' || !hash_equals(SETUP_TOKEN, $token)) {
    http_response_code(403);
    exit('Token inválido. Visita esta página con ?token=EL_VALOR_DE_SETUP_TOKEN.');
}

// Escapa pipes y saltos de línea para no romper las tablas Markdown.
function md(string $s, int $limit = 0): string
{
    $s = str_replace(["\r\n", "\r", "\n"], ' ⏎ ', $s);
    $s = str_replace('|', '\\|', $s);
    if ($limit > 0 && mb_strlen($s) > $limit) {
        $s = mb_substr($s, 0, $limit) . '…';
    }
    return $s;
}

$pdo = db();

$events = $pdo->query('
    SELECT id, platform, event_type, signature_valid, processed, error, received_at, raw_payload
    FROM webhook_events
    ORDER BY id DESC
    LIMIT 25
')->fetchAll();

$accounts = $pdo->query('
    SELECT id, client_id, platform, page_id, page_name, ig_business_id, ig_username, status, last_verified_at, webhook_subscribed_fields
    FROM social_accounts
    ORDER BY id DESC
')->fetchAll();

$flows = $pdo->query('
    SELECT f.id, f.client_id, f.name, f.status, f.social_account_id,
           (SELECT COUNT(*) FROM flow_triggers ft WHERE ft.flow_id = f.id AND ft.active = 1) AS active_triggers
    FROM flows f
    ORDER BY f.id DESC
')->fetchAll();

$triggers = $pdo->query('
    SELECT ft.id, ft.flow_id, ft.trigger_type, ft.platform_scope, ft.active, ft.priority, ft.match_config
    FROM flow_triggers ft
    ORDER BY ft.flow_id DESC, ft.priority DESC
')->fetchAll();

$conversations = $pdo->query('
    SELECT conv.id, c.psid, c.platform, conv.status, conv.active_flow_id, conv.current_node_id,
           conv.last_inbound_at, conv.window_expires_at, conv.human_agent_tag_until, conv.state_vars,
           conv.updated_at
    FROM conversations conv
    JOIN contacts c ON c.id = conv.contact_id
    ORDER BY conv.id DESC
    LIMIT 15
')->fetchAll();

header('Content-Type: text/plain; charset=utf-8');

echo "⚠️ Borra este archivo del servidor cuando termines — expone contenido de conversaciones de clientes.\n\n";

echo "# Diagnóstico webhook — Atención al Cliente\n\n";
echo "Generado: " . date('Y-m-d H:i:s') . "\n\n";

echo "## Últimos 25 webhook_events\n\n";
echo "| id | plataforma | tipo | firma | procesado | error | recibido | payload (recorte) |\n";
echo "|---|---|---|---|---|---|---|---|\n";
if ($events) {
    foreach ($events as $e) {
        echo '| ' . (int)$e['id']
            . ' | ' . md((string)$e['platform'])
            . ' | ' . md((string)$e['event_type'])
            . ' | ' . ($e['signature_valid'] ? 'válida' : '**INVÁLIDA**')
            . ' | ' . ($e['processed'] ? 'sí' : '**no**')
            . ' | ' . md((string)($e['error'] ?? ''))
            . ' | ' . md((string)$e['received_at'])
            . ' | ' . md((string)$e['raw_payload'], 300)
            . " |\n";
    }
} else {
    echo "| _sin eventos registrados todavía_ | | | | | | | |\n";
}

echo "\n## social_accounts\n\n";
echo "| id | client_id | plataforma | page_id | page_name | ig_business_id | ig_username | status | last_verified_at | webhook_subscribed_fields |\n";
echo "|---|---|---|---|---|---|---|---|---|---|\n";
foreach ($accounts as $a) {
    echo '| ' . (int)$a['id']
        . ' | ' . (int)$a['client_id']
        . ' | ' . md((string)$a['platform'])
        . ' | ' . md((string)$a['page_id'])
        . ' | ' . md((string)$a['page_name'])
        . ' | ' . md((string)$a['ig_business_id'])
        . ' | ' . md((string)$a['ig_username'])
        . ' | ' . ($a['status'] === 'active' ? $a['status'] : '**' . $a['status'] . '**')
        . ' | ' . md((string)$a['last_verified_at'])
        . ' | ' . md((string)$a['webhook_subscribed_fields'])
        . " |\n";
}

echo "\n## flows\n\n";
echo "| id | client_id | nombre | status | social_account_id | triggers activos |\n";
echo "|---|---|---|---|---|---|\n";
foreach ($flows as $f) {
    echo '| ' . (int)$f['id']
        . ' | ' . (int)$f['client_id']
        . ' | ' . md((string)$f['name'])
        . ' | ' . ($f['status'] === 'active' ? $f['status'] : '**' . $f['status'] . '**')
        . ' | ' . md((string)($f['social_account_id'] ?? 'todas'))
        . ' | ' . (int)$f['active_triggers']
        . " |\n";
}

echo "\n## flow_triggers\n\n";
echo "| id | flow_id | trigger_type | platform_scope | active | priority | match_config |\n";
echo "|---|---|---|---|---|---|---|\n";
foreach ($triggers as $t) {
    echo '| ' . (int)$t['id']
        . ' | ' . (int)$t['flow_id']
        . ' | ' . md((string)$t['trigger_type'])
        . ' | ' . md((string)$t['platform_scope'])
        . ' | ' . ($t['active'] ? 'sí' : '**no**')
        . ' | ' . (int)$t['priority']
        . ' | ' . md((string)$t['match_config'], 300)
        . " |\n";
}

echo "\n## conversations (últimas 15)\n\n";
echo "| id | psid | plataforma | status | active_flow_id | current_node_id | last_inbound_at | window_expires_at | human_agent_tag_until | state_vars | updated_at |\n";
echo "|---|---|---|---|---|---|---|---|---|---|---|\n";
foreach ($conversations as $c) {
    echo '| ' . (int)$c['id']
        . ' | ' . md((string)$c['psid'])
        . ' | ' . md((string)$c['platform'])
        . ' | ' . ($c['status'] === 'open' ? $c['status'] : '**' . $c['status'] . '**')
        . ' | ' . md((string)($c['active_flow_id'] ?? ''))
        . ' | ' . md((string)($c['current_node_id'] ?? ''))
        . ' | ' . md((string)$c['last_inbound_at'])
        . ' | ' . md((string)$c['window_expires_at'])
        . ' | ' . md((string)$c['human_agent_tag_until'])
        . ' | ' . md((string)$c['state_vars'], 200)
        . ' | ' . md((string)$c['updated_at'])
        . " |\n";
}
