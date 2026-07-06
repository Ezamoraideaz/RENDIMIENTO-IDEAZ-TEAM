<?php
declare(strict_types=1);

// Recibe eventos ya verificados del webhook, resuelve cuenta/contacto/conversación,
// hace matching contra los flujos activos de esa cuenta y ejecuta la cadena de nodos
// hasta un nodo de retraso (delegado a scheduled_actions + cron de la Fase 3) o hasta
// el final del flujo. Si la cuenta aún no tiene ningún flujo activo, responde con un
// mensaje de bienvenida fijo — esto valida el pipe completo (webhook -> envío -> log)
// desde el primer día, sin depender de que el constructor visual ya exista.
class TriggerEngine
{
    private const WINDOW_HOURS = 24;

    public static function handleMessagingEvent(array $event, string $platform): void
    {
        $senderId = $event['sender']['id'] ?? null;
        $pageId   = $event['recipient']['id'] ?? null;
        $text     = $event['message']['text'] ?? ($event['postback']['title'] ?? null);

        if (!$senderId || !$pageId || $text === null) {
            return; // delivery/read receipts u otros eventos sin contenido accionable
        }

        $account = self::findAccount($platform, $pageId);
        if (!$account) {
            return;
        }

        $contact      = self::findOrCreateContact($account, $platform, $senderId);
        $conversation = self::findOrCreateConversation($account, $contact);

        self::recordMessage($conversation['id'], 'in', 'text', $text, $event);
        self::touchWindow($conversation['id']);

        self::routeToFlow($account, $conversation, $platform, $text);
    }

    public static function handleChangeEvent(array $change, string $platform, string $pageId): void
    {
        $field = $change['field'] ?? '';
        $value = $change['value'] ?? [];

        $isComment = $field === 'comments' || ($field === 'feed' && ($value['item'] ?? '') === 'comment');
        if (!$isComment) {
            return;
        }

        $commentId   = $value['comment_id'] ?? $value['id'] ?? null;
        $commenterId = $value['from']['id'] ?? null;
        $text        = $value['message'] ?? $value['text'] ?? '';

        if (!$commentId || !$commenterId) {
            return;
        }

        $account = self::findAccount($platform, $pageId);
        if (!$account) {
            return;
        }

        $contact      = self::findOrCreateContact($account, $platform, $commenterId);
        $conversation = self::findOrCreateConversation($account, $contact);

        self::recordMessage($conversation['id'], 'in', 'comment_reply', $text, $change);
        self::touchWindow($conversation['id']); // la respuesta privada abre ventana de 24h igual que un DM

        $replyText = self::resolveCommentReply((int)$account['client_id'], $platform, $text);
        $pageToken = self::decryptAccountToken($account);

        MetaClient::sendPrivateReply($pageToken, (string)$commentId, $replyText);
        self::recordMessage($conversation['id'], 'out', 'private_reply', $replyText, null, 'flow');
    }

    // ── Ruteo a flujo (mensajes/postbacks) ──────────────────────────────────

    private static function routeToFlow(array $account, array $conversation, string $platform, string $text): void
    {
        $trigger   = self::matchTrigger((int)$account['client_id'], (int)$account['id'], $platform, $text);
        $pageToken = self::decryptAccountToken($account);

        if (!$trigger) {
            $fallback = '¡Hola! Gracias por escribirnos. En breve un asesor te contactará.';
            self::sendOutbound($platform, $pageToken, self::recipientId($conversation), $fallback);
            self::recordMessage($conversation['id'], 'out', 'text', $fallback, null, 'flow');
            return;
        }

        db()->prepare('UPDATE conversations SET active_flow_id = ?, current_node_id = ? WHERE id = ?')
            ->execute([$trigger['flow_id'], $trigger['node_id'], $conversation['id']]);

        self::executeFromNode((int)$trigger['flow_id'], $trigger['node_id'], $conversation, $platform, $pageToken);
    }

    private static function resolveCommentReply(int $clientId, string $platform, string $text): string
    {
        // Un comentario puede venir de cualquier plataforma con cuenta de IG vinculada a la Página
        $trigger = self::matchTrigger($clientId, 0, $platform, $text, true);
        if ($trigger) {
            $graph = self::loadGraph((int)$trigger['flow_id']);
            $node  = self::findNode($graph, $trigger['node_id']);
            if ($node && $node['type'] === 'message') {
                return (string)($node['data']['text'] ?? '');
            }
        }
        return 'Gracias por tu comentario, te escribimos por privado.';
    }

    // ── Matching de disparadores ─────────────────────────────────────────────

    private static function matchTrigger(int $clientId, int $accountId, string $platform, string $text, bool $anyAccount = false): ?array
    {
        $sql = '
            SELECT ft.flow_id, ft.match_config, ft.node_id
            FROM flow_triggers ft
            JOIN flows f ON f.id = ft.flow_id
            WHERE f.status = "active"
              AND f.client_id = ?
              AND ft.active = 1
              AND ft.trigger_type = "keyword"
              AND (ft.platform_scope = ? OR ft.platform_scope = "both")
        ';
        $params = [$clientId, $platform];
        if (!$anyAccount) {
            $sql .= ' AND (f.social_account_id = ? OR f.social_account_id IS NULL)';
            $params[] = $accountId;
        }
        $sql .= ' ORDER BY ft.priority DESC';

        $stmt = db()->prepare($sql);
        $stmt->execute($params);

        $needle = mb_strtolower(trim($text));
        foreach ($stmt->fetchAll() as $row) {
            $config = json_decode($row['match_config'], true) ?? [];
            foreach ($config['keywords'] ?? [] as $keyword) {
                if ($keyword !== '' && mb_strpos($needle, mb_strtolower((string)$keyword)) !== false) {
                    return $row;
                }
            }
        }
        return null;
    }

    // ── Ejecución del grafo de flujo ─────────────────────────────────────────

    private static function executeFromNode(int $flowId, string $nodeId, array $conversation, string $platform, string $pageToken): void
    {
        $graph = self::loadGraph($flowId);
        $node  = self::findNode($graph, $nodeId);
        $guard = 0;

        while ($node !== null && $guard < 20) {
            $guard++;

            if ($node['type'] === 'message') {
                $text = (string)($node['data']['text'] ?? '');
                self::sendOutbound($platform, $pageToken, self::recipientId($conversation), $text);
                self::recordMessage($conversation['id'], 'out', 'text', $text, null, 'flow');
                $node = self::nextNode($graph, $node['id']);
                continue;
            }

            if ($node['type'] === 'delay') {
                $minutes = max(1, (int)($node['data']['minutes'] ?? 1));
                $next = self::nextNode($graph, $node['id']);
                if ($next !== null) {
                    db()->prepare('
                        INSERT INTO scheduled_actions (conversation_id, flow_id, node_id, run_at, status, payload_json)
                        VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), "pending", ?)
                    ')->execute([$conversation['id'], $flowId, $next['id'], $minutes, json_encode(['platform' => $platform])]);
                }
                return; // el cron de la Fase 3 continúa la ejecución desde aquí
            }

            // Nodos de condición/acción avanzada se agregan cuando el constructor
            // visual (Fase 4) los emita; por ahora el flujo se detiene de forma segura.
            break;
        }
    }

    private static function loadGraph(int $flowId): array
    {
        $stmt = db()->prepare('SELECT graph_json FROM flows WHERE id = ?');
        $stmt->execute([$flowId]);
        $row = $stmt->fetch();
        if (!$row) {
            return ['nodes' => [], 'edges' => []];
        }
        $graph = json_decode((string)$row['graph_json'], true);
        return is_array($graph) ? ($graph + ['nodes' => [], 'edges' => []]) : ['nodes' => [], 'edges' => []];
    }

    private static function findNode(array $graph, string $nodeId): ?array
    {
        foreach ($graph['nodes'] ?? [] as $node) {
            if (($node['id'] ?? null) === $nodeId) {
                return $node;
            }
        }
        return null;
    }

    private static function nextNode(array $graph, string $nodeId): ?array
    {
        foreach ($graph['edges'] ?? [] as $edge) {
            if (($edge['from'] ?? null) === $nodeId) {
                return self::findNode($graph, $edge['to'] ?? '');
            }
        }
        return null;
    }

    // ── Envío manual desde el inbox (operador humano, Fase 5) ────────────────

    // Un envío manual siempre lo hace una persona, así que puede usar el tag
    // HUMAN_AGENT cuando la ventana de 24h ya cerró (excepción de 7 días de Meta).
    // Nunca se le escribe primero a un contacto que nunca ha iniciado conversación.
    public static function sendManual(int $conversationId, string $text): array
    {
        $conversation = self::loadConversation($conversationId);
        if (!$conversation) {
            throw new RuntimeException('Conversación no encontrada');
        }
        if (empty($conversation['last_inbound_at'])) {
            throw new RuntimeException('No se puede escribir primero a un contacto que nunca ha iniciado la conversación (política de Meta)');
        }

        $account = self::loadAccountForConversation($conversation);
        if (!$account) {
            throw new RuntimeException('Cuenta no encontrada o desconectada');
        }

        $platform  = $account['platform'] === 'instagram_business' ? 'instagram' : 'messenger';
        $pageToken = self::decryptAccountToken($account);
        $tag       = self::canSendFreeform($conversation) ? 'NONE' : 'HUMAN_AGENT';

        self::sendOutbound($platform, $pageToken, self::recipientId($conversation), $text);
        self::recordMessage($conversationId, 'out', 'text', $text, null, 'manual', $tag);

        if ($tag === 'HUMAN_AGENT') {
            db()->prepare('UPDATE conversations SET human_agent_tag_until = DATE_ADD(NOW(), INTERVAL 7 DAY) WHERE id = ?')
                ->execute([$conversationId]);
        }

        return ['tag' => $tag];
    }

    // ── Reanudación de flujo desde un nodo de retraso (llamado por el cron, Fase 3) ──

    public static function runScheduledNode(int $conversationId, int $flowId, string $nodeId, string $platform): string
    {
        $conversation = self::loadConversation($conversationId);
        if (!$conversation) {
            return 'cancelled';
        }

        if (!self::canSendFreeform($conversation)) {
            return 'needs_manual_followup';
        }

        $account = self::loadAccountForConversation($conversation);
        if (!$account) {
            return 'failed';
        }

        $pageToken = self::decryptAccountToken($account);
        self::executeFromNode($flowId, $nodeId, $conversation, $platform, $pageToken);
        return 'sent';
    }

    private static function loadConversation(int $conversationId): ?array
    {
        $stmt = db()->prepare('
            SELECT conv.*, c.psid AS psid
            FROM conversations conv
            JOIN contacts c ON c.id = conv.contact_id
            WHERE conv.id = ?
        ');
        $stmt->execute([$conversationId]);
        $conversation = $stmt->fetch();
        return $conversation ?: null;
    }

    private static function loadAccountForConversation(array $conversation): ?array
    {
        $stmt = db()->prepare('SELECT * FROM social_accounts WHERE id = ?');
        $stmt->execute([$conversation['social_account_id']]);
        $account = $stmt->fetch();
        return $account ?: null;
    }

    // ── Ventana de 24h / excepción HUMAN_AGENT ──────────────────────────────

    public static function canSendFreeform(array $conversation): bool
    {
        $now = new DateTimeImmutable('now');

        $windowExpires = !empty($conversation['window_expires_at']) ? new DateTimeImmutable($conversation['window_expires_at']) : null;
        if ($windowExpires && $now < $windowExpires) {
            return true;
        }

        $humanUntil = !empty($conversation['human_agent_tag_until']) ? new DateTimeImmutable($conversation['human_agent_tag_until']) : null;
        if ($humanUntil && $now < $humanUntil) {
            return true;
        }

        return false;
    }

    private static function sendOutbound(string $platform, string $pageToken, string $recipientId, string $text): void
    {
        if ($platform === 'instagram') {
            MetaClient::sendInstagramMessage($pageToken, $recipientId, $text);
        } else {
            MetaClient::sendMessengerMessage($pageToken, $recipientId, $text);
        }
    }

    private static function recipientId(array $conversation): string
    {
        return (string)$conversation['psid'];
    }

    // ── Cuenta / contacto / conversación ─────────────────────────────────────

    private static function findAccount(string $platform, string $pageId): ?array
    {
        $platformEnum = $platform === 'instagram' ? 'instagram_business' : 'facebook_page';
        $stmt = db()->prepare('
            SELECT * FROM social_accounts
            WHERE platform = ? AND (page_id = ? OR ig_business_id = ?) AND status = "active"
            LIMIT 1
        ');
        $stmt->execute([$platformEnum, $pageId, $pageId]);
        $account = $stmt->fetch();
        return $account ?: null;
    }

    private static function decryptAccountToken(array $account): string
    {
        return decrypt_token($account['page_access_token_encrypted'], $account['page_token_iv']);
    }

    private static function findOrCreateContact(array $account, string $platform, string $psid): array
    {
        $stmt = db()->prepare('SELECT * FROM contacts WHERE social_account_id = ? AND psid = ?');
        $stmt->execute([$account['id'], $psid]);
        $contact = $stmt->fetch();
        if ($contact) {
            db()->prepare('UPDATE contacts SET last_seen_at = NOW() WHERE id = ?')->execute([$contact['id']]);
            return $contact;
        }

        db()->prepare('
            INSERT INTO contacts (client_id, social_account_id, platform, psid)
            VALUES (?, ?, ?, ?)
        ')->execute([$account['client_id'], $account['id'], $platform === 'instagram' ? 'instagram' : 'messenger', $psid]);

        return [
            'id' => (int)db()->lastInsertId(),
            'client_id' => $account['client_id'],
            'social_account_id' => $account['id'],
            'platform' => $platform,
            'psid' => $psid,
        ];
    }

    private static function findOrCreateConversation(array $account, array $contact): array
    {
        $stmt = db()->prepare('SELECT * FROM conversations WHERE contact_id = ? ORDER BY id DESC LIMIT 1');
        $stmt->execute([$contact['id']]);
        $conversation = $stmt->fetch();
        if ($conversation) {
            return $conversation + ['psid' => $contact['psid']];
        }

        db()->prepare('
            INSERT INTO conversations (contact_id, social_account_id, status)
            VALUES (?, ?, "open")
        ')->execute([$contact['id'], $account['id']]);

        return [
            'id' => (int)db()->lastInsertId(),
            'contact_id' => $contact['id'],
            'social_account_id' => $account['id'],
            'status' => 'open',
            'window_expires_at' => null,
            'human_agent_tag_until' => null,
            'psid' => $contact['psid'],
        ];
    }

    private static function touchWindow(int $conversationId): void
    {
        db()->prepare('
            UPDATE conversations
            SET last_inbound_at = NOW(), window_expires_at = DATE_ADD(NOW(), INTERVAL ' . self::WINDOW_HOURS . ' HOUR)
            WHERE id = ?
        ')->execute([$conversationId]);
    }

    private static function recordMessage(
        int $conversationId,
        string $direction,
        string $type,
        string $content,
        ?array $rawPayload,
        string $sentBy = 'system',
        string $tag = 'NONE'
    ): void {
        db()->prepare('
            INSERT INTO messages (conversation_id, direction, message_type, content, payload_json, tag, sent_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ')->execute([
            $conversationId, $direction, $type, $content,
            $rawPayload ? json_encode($rawPayload) : null, $tag, $sentBy,
        ]);
    }
}
