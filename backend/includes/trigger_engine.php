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
        // Los "echo" son copias de los mensajes que NOSOTROS enviamos (Meta los reenvía
        // por webhook). Si no se filtran, el bot se responde a sí mismo en bucle —
        // especialmente frecuente en Instagram.
        if (!empty($event['message']['is_echo'])) {
            return;
        }

        $senderId = $event['sender']['id'] ?? null;
        $pageId   = $event['recipient']['id'] ?? null;
        $text     = $event['message']['text'] ?? ($event['postback']['title'] ?? null);

        if (!$senderId || !$pageId || $text === null) {
            return; // delivery/read receipts, reacciones u otros eventos sin contenido accionable
        }

        $account = self::findAccount($platform, $pageId);
        if (!$account) {
            return;
        }

        $contact      = self::findOrCreateContact($account, $platform, $senderId);
        $conversation = self::findOrCreateConversation($account, $contact);
        $isNew        = !empty($conversation['_created']);

        $qrPayload = $event['message']['quick_reply']['payload'] ?? null;
        $msgType   = $qrPayload !== null ? 'quick_reply' : 'text';
        self::recordMessage($conversation['id'], 'in', $msgType, $text, $event);
        self::touchWindow($conversation['id']);

        // Respuesta a una historia de Instagram (Story reply): llega como un mensaje
        // normal, con reply_to.story presente. Alto valor de engagement en IG — se le
        // da prioridad sobre el ruteo por palabra clave (ver routeToFlow).
        $isStoryReply = !empty($event['message']['reply_to']['story']);

        // Una conversación tomada por un asesor humano no debe ser interrumpida por el bot.
        if (($conversation['status'] ?? '') === 'handed_off') {
            return;
        }

        $pageToken = self::decryptAccountToken($account);
        $stateVars = self::loadStateVars($conversation);

        // Mensaje que llegó por un anuncio "Enviar mensaje" (Click-to-Messenger o su
        // equivalente en Instagram — mismo formato de referral en ambas plataformas): Meta
        // manda un objeto referral con el ad_id. Se resuelve el nombre de campaña
        // (best-effort) para poder activar un flujo específico por campaña.
        $adCampaignName = null;
        $referral = $event['referral'] ?? null;
        if (!empty($referral['ad_id']) && ($referral['source'] ?? '') === 'ADS') {
            try {
                $adCampaignName = MetaClient::getAdCampaignName($pageToken, (string)$referral['ad_id']);
            } catch (Throwable $e) {
                // sin permiso/API caída: se sigue el ruteo normal, sin filtrar por campaña
            }
        }

        // 1) Respuesta a un nodo de botones (quick reply): continúa por la rama elegida.
        if ($qrPayload !== null && preg_match('/^qr:(\d+):([\w-]+):(\d+)$/', $qrPayload, $m)) {
            self::continueFromOutput((int)$m[1], $m[2], (int)$m[3], $conversation, $platform, $pageToken);
            return;
        }

        // 2) Respuesta a un nodo de pregunta (captura de lead): valida, guarda y continúa.
        if (!empty($stateVars['awaiting'])) {
            self::handleAwaitedAnswer($stateVars, $conversation, $contact, $platform, $pageToken, $text);
            return;
        }

        // 3) Continuación pendiente tras una respuesta privada a comentario.
        if (!empty($stateVars['resume'])) {
            $resume = $stateVars['resume'];
            unset($stateVars['resume']);
            self::saveStateVars($conversation['id'], $stateVars);
            self::executeFromNode((int)$resume['flow_id'], (string)$resume['node_id'], $conversation, $platform, $pageToken);
            return;
        }

        self::routeToFlow($account, $conversation, $platform, $text, $isNew, $pageToken, $isStoryReply, $adCampaignName);
    }

    public static function handleChangeEvent(array $change, string $platform, string $pageId): void
    {
        $field = $change['field'] ?? '';
        $value = $change['value'] ?? [];

        // Lead de formulario instantáneo (Instant Forms): no hay chat de por medio, se
        // maneja aparte del motor conversacional (ver backend/includes/ad_leads.php).
        if ($field === 'leadgen') {
            capture_ad_lead($change, $pageId);
            return;
        }

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

        // Meta reenvía por webhook también los comentarios/respuestas que el propio
        // bot publica (respuesta pública a comentario, o una respuesta anidada). Sin
        // este filtro, el bot podría terminar respondiéndose a sí mismo en bucle si
        // el texto de su propia respuesta llega a coincidir con algún trigger.
        if ($commenterId === $pageId) {
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

        $pageToken = self::decryptAccountToken($account);

        // Disparador "comentario en publicación": palabras clave vacías = cualquier comentario.
        $trigger = self::matchTrigger((int)$account['client_id'], (int)$account['id'], $platform, $text, false, 'comment_on_post')
                ?? self::matchTrigger((int)$account['client_id'], 0, $platform, $text, true); // compat: flujos viejos por keyword

        $replyText   = 'Gracias por tu comentario, te escribimos por privado.';
        $publicReply = '';
        $resumeNode  = null;
        if ($trigger) {
            $config = json_decode($trigger['match_config'] ?? '', true) ?? [];

            // Varias variantes de respuesta pública, elegidas al azar cada vez: repetir
            // siempre el mismo texto en los comentarios de un post delata que es un bot.
            $publicReplies = array_values(array_filter(array_map(
                static fn($t) => trim((string)$t),
                $config['public_replies'] ?? []
            ), static fn($t) => $t !== ''));
            if (!$publicReplies && !empty($config['public_reply'])) {
                $publicReplies = [trim((string)$config['public_reply'])]; // compat: flujos con el campo viejo (una sola respuesta)
            }
            $publicReply = $publicReplies ? $publicReplies[array_rand($publicReplies)] : '';

            $graph = self::loadGraph((int)$trigger['flow_id']);
            $node  = self::findNode($graph, $trigger['node_id']);
            if ($node && $node['type'] === 'message') {
                $replyText = (string)($node['data']['text'] ?? '') ?: $replyText;
                // Meta solo permite UNA respuesta privada por comentario; si el flujo sigue,
                // se reanuda cuando la persona conteste el DM.
                $resumeNode = self::nextNode($graph, $node['id']);
            } elseif ($node) {
                // El primer nodo no es un mensaje simple (p.ej. botones/pregunta): la respuesta
                // privada invita a continuar y el resto del flujo corre cuando responda.
                $resumeNode = $node;
            }
        }

        MetaClient::sendPrivateReply($pageToken, (string)$commentId, $replyText);
        self::recordMessage($conversation['id'], 'out', 'private_reply', $replyText, null, 'flow');

        // Respuesta pública opcional (visible en el post, sube el engagement de la
        // comunidad), configurada en el propio nodo disparador "Comentario en post".
        if ($publicReply !== '') {
            MetaClient::replyToComment($pageToken, (string)$commentId, $publicReply, $platform);
            self::recordMessage($conversation['id'], 'out', 'comment_reply', $publicReply, null, 'flow');
        }

        if ($trigger && $resumeNode !== null) {
            $stateVars = self::loadStateVars($conversation);
            $stateVars['resume'] = ['flow_id' => (int)$trigger['flow_id'], 'node_id' => (string)$resumeNode['id']];
            self::saveStateVars($conversation['id'], $stateVars);
        }
    }

    // ── Ruteo a flujo (mensajes/postbacks) ──────────────────────────────────

    private static function routeToFlow(array $account, array $conversation, string $platform, string $text, bool $isNew, string $pageToken, bool $isStoryReply = false, ?string $adCampaignName = null): void
    {
        // Prioridad 1: el mensaje vino de un anuncio "Enviar mensaje" — permite un
        // flujo específico por campaña (más específico que cualquier otra cosa).
        $trigger = $adCampaignName !== null
            ? self::matchTrigger((int)$account['client_id'], (int)$account['id'], $platform, $adCampaignName, false, 'ad_message')
            : null;

        // Prioridad 2: respuesta a una historia de Instagram.
        if (!$trigger && $isStoryReply) {
            $trigger = self::matchTrigger((int)$account['client_id'], (int)$account['id'], $platform, $text, false, 'story_reply');
        }

        if (!$trigger) {
            $trigger = self::matchTrigger((int)$account['client_id'], (int)$account['id'], $platform, $text);
        }

        // Sin match por palabra clave: si el contacto es nuevo, probar el disparador de
        // "nueva conversación" (bienvenida); si tampoco hay, mensaje fallback SOLO la
        // primera vez — en conversaciones ya abiertas el silencio es mejor que spamear
        // al usuario (o pisar a un asesor) con el fallback en cada mensaje.
        if (!$trigger && $isNew) {
            $trigger = self::matchTrigger((int)$account['client_id'], (int)$account['id'], $platform, $text, false, 'new_conversation');
        }

        if (!$trigger) {
            if ($isNew) {
                $fallback = '¡Hola! Gracias por escribirnos. En breve un asesor te contactará.';
                self::sendOutbound($platform, $pageToken, self::recipientId($conversation), $fallback);
                self::recordMessage($conversation['id'], 'out', 'text', $fallback, null, 'flow');
            }
            return;
        }

        db()->prepare('UPDATE conversations SET active_flow_id = ?, current_node_id = ? WHERE id = ?')
            ->execute([$trigger['flow_id'], $trigger['node_id'], $conversation['id']]);

        self::executeFromNode((int)$trigger['flow_id'], $trigger['node_id'], $conversation, $platform, $pageToken);
    }

    // ── Matching de disparadores ─────────────────────────────────────────────

    private static function matchTrigger(int $clientId, int $accountId, string $platform, string $text, bool $anyAccount = false, string $triggerType = 'keyword'): ?array
    {
        $sql = '
            SELECT ft.flow_id, ft.match_config, ft.node_id
            FROM flow_triggers ft
            JOIN flows f ON f.id = ft.flow_id
            WHERE f.status = "active"
              AND f.client_id = ?
              AND ft.active = 1
              AND ft.trigger_type = ?
              AND (ft.platform_scope = ? OR ft.platform_scope = "both")
        ';
        $params = [$clientId, $triggerType, $platform];
        if (!$anyAccount) {
            $sql .= ' AND (f.social_account_id = ? OR f.social_account_id IS NULL)';
            $params[] = $accountId;
        }
        $sql .= ' ORDER BY ft.priority DESC';

        $stmt = db()->prepare($sql);
        $stmt->execute($params);

        $needle = mb_strtolower(trim($text));
        foreach ($stmt->fetchAll() as $row) {
            $config   = json_decode($row['match_config'], true) ?? [];
            $keywords = $config['keywords'] ?? [];

            // "new_conversation" no filtra por texto; en "comment_on_post"/"ad_message"
            // una lista vacía significa "cualquier comentario"/"cualquier campaña".
            if ($triggerType === 'new_conversation'
                || (($triggerType === 'comment_on_post' || $triggerType === 'ad_message') && !array_filter($keywords))) {
                return $row;
            }
            foreach ($keywords as $keyword) {
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

            // Botones (quick replies): envía las opciones y espera la elección del usuario.
            // El payload de cada botón codifica flujo+nodo+salida para retomar por esa rama.
            if ($node['type'] === 'quick_replies') {
                $text    = (string)($node['data']['text'] ?? '');
                $options = [];
                foreach (array_values($node['data']['options'] ?? []) as $i => $label) {
                    $options[] = ['title' => (string)$label, 'payload' => "qr:{$flowId}:{$node['id']}:" . ($i + 1)];
                }
                if ($text !== '' && $options) {
                    MetaClient::sendQuickReplies($pageToken, self::recipientId($conversation), $text, $options);
                    self::recordMessage($conversation['id'], 'out', 'quick_reply', $text, ['options' => $node['data']['options'] ?? []], 'flow');
                    db()->prepare('UPDATE conversations SET active_flow_id = ?, current_node_id = ? WHERE id = ?')
                        ->execute([$flowId, $node['id'], $conversation['id']]);
                }
                return; // continúa en continueFromOutput() cuando el usuario toque un botón
            }

            // Pregunta (captura de lead): envía la pregunta y deja la conversación
            // "esperando respuesta"; handleAwaitedAnswer() valida, guarda y continúa.
            if ($node['type'] === 'question') {
                $text = (string)($node['data']['text'] ?? '');
                if ($text !== '') {
                    self::sendOutbound($platform, $pageToken, self::recipientId($conversation), $text);
                    self::recordMessage($conversation['id'], 'out', 'text', $text, null, 'flow');
                }
                $stateVars = self::loadStateVars($conversation);
                $stateVars['awaiting'] = [
                    'flow_id'    => $flowId,
                    'node_id'    => (string)$node['id'],
                    'field'      => (string)($node['data']['field'] ?? 'nota'),
                    'validate'   => (string)($node['data']['validate'] ?? 'none'),
                    'retry_text' => (string)($node['data']['retry_text'] ?? ''),
                ];
                self::saveStateVars($conversation['id'], $stateVars);
                return;
            }

            // Pasar a humano: el bot se detiene en esta conversación hasta que un
            // operador la reabra desde el inbox.
            if ($node['type'] === 'handoff') {
                $text = (string)($node['data']['text'] ?? '');
                if ($text !== '') {
                    self::sendOutbound($platform, $pageToken, self::recipientId($conversation), $text);
                    self::recordMessage($conversation['id'], 'out', 'text', $text, null, 'flow');
                }
                db()->prepare('UPDATE conversations SET status = "handed_off" WHERE id = ?')
                    ->execute([$conversation['id']]);
                return;
            }

            // Imagen por URL pública.
            if ($node['type'] === 'image') {
                $url = (string)($node['data']['url'] ?? '');
                if ($url !== '') {
                    MetaClient::sendImage($pageToken, self::recipientId($conversation), $url);
                    self::recordMessage($conversation['id'], 'out', 'text', '🖼️ [Imagen] ' . $url, null, 'flow');
                }
                $node = self::nextNode($graph, $node['id']);
                continue;
            }

            // Tarjeta con botones de enlace (CTA a landing/catálogo/WhatsApp).
            if ($node['type'] === 'card') {
                $title = (string)($node['data']['title'] ?? '');
                if ($title !== '') {
                    MetaClient::sendCard(
                        $pageToken,
                        self::recipientId($conversation),
                        $title,
                        (string)($node['data']['subtitle'] ?? ''),
                        (string)($node['data']['image_url'] ?? ''),
                        $node['data']['buttons'] ?? []
                    );
                    self::recordMessage($conversation['id'], 'out', 'text', '🃏 [Tarjeta] ' . $title, null, 'flow');
                }
                $node = self::nextNode($graph, $node['id']);
                continue;
            }

            // Carrusel de tarjetas (varias imágenes/promos en un solo mensaje).
            if ($node['type'] === 'carousel') {
                $items = array_slice($node['data']['items'] ?? [], 0, 10);
                if ($items) {
                    MetaClient::sendCarousel($pageToken, self::recipientId($conversation), $items);
                    self::recordMessage($conversation['id'], 'out', 'text', '🎠 [Carrusel] ' . count($items) . ' elementos', null, 'flow');
                }
                $node = self::nextNode($graph, $node['id']);
                continue;
            }

            // Encuesta de satisfacción (CSAT): 5 salidas fijas, una por calificación
            // (1=😡 … 5=😍). El rating elegido se guarda en continueFromOutput().
            if ($node['type'] === 'csat') {
                $text = (string)($node['data']['text'] ?? '') ?: '¿Cómo calificarías tu experiencia?';
                $emojis = ['😡', '🙁', '😐', '🙂', '😍'];
                $options = [];
                foreach ($emojis as $i => $emoji) {
                    $options[] = ['title' => $emoji, 'payload' => "qr:{$flowId}:{$node['id']}:" . ($i + 1)];
                }
                MetaClient::sendQuickReplies($pageToken, self::recipientId($conversation), $text, $options);
                self::recordMessage($conversation['id'], 'out', 'quick_reply', $text, ['options' => $emojis], 'flow');
                db()->prepare('UPDATE conversations SET active_flow_id = ?, current_node_id = ? WHERE id = ?')
                    ->execute([$flowId, $node['id'], $conversation['id']]);
                return; // continúa en continueFromOutput() cuando el usuario elija una carita
            }

            // Condición sobre datos capturados: salida 1 = sí, salida 2 = no.
            if ($node['type'] === 'condition') {
                $out = self::evaluateCondition($node['data'] ?? [], $conversation) ? 1 : 2;
                $node = self::nextNode($graph, $node['id'], $out);
                continue;
            }

            // Horario de atención (zona horaria del cliente): salida 1 = dentro, 2 = fuera.
            if ($node['type'] === 'hours') {
                $out = self::isWithinBusinessHours($node['data'] ?? [], (int)$conversation['social_account_id']) ? 1 : 2;
                $node = self::nextNode($graph, $node['id'], $out);
                continue;
            }

            // Test A/B: reparte el tráfico al azar entre dos ramas según el porcentaje.
            if ($node['type'] === 'ab_split') {
                $percentA = max(0, min(100, (int)($node['data']['percent_a'] ?? 50)));
                $out = random_int(1, 100) <= $percentA ? 1 : 2;
                $node = self::nextNode($graph, $node['id'], $out);
                continue;
            }

            // Etiqueta al contacto (segmentación de leads); no envía nada.
            if ($node['type'] === 'tag') {
                $tag = trim((string)($node['data']['tag'] ?? ''));
                if ($tag !== '') {
                    $stateVars = self::loadStateVars($conversation);
                    $tags = $stateVars['tags'] ?? [];
                    if (!in_array($tag, $tags, true)) {
                        $tags[] = $tag;
                        $stateVars['tags'] = $tags;
                        self::saveStateVars($conversation['id'], $stateVars);
                    }
                }
                $node = self::nextNode($graph, $node['id']);
                continue;
            }

            // Alerta por email al equipo (lead nuevo, cita, etc.); no envía nada al usuario.
            if ($node['type'] === 'notify') {
                self::notifyTeam($node['data'] ?? [], $conversation);
                $node = self::nextNode($graph, $node['id']);
                continue;
            }

            // Tipo de nodo desconocido: el flujo se detiene de forma segura.
            break;
        }
    }

    // ── Evaluadores de nodos de lógica ───────────────────────────────────────

    private static function evaluateCondition(array $data, array $conversation): bool
    {
        $field = (string)($data['field'] ?? '');
        $op    = (string)($data['op'] ?? 'exists');
        $value = mb_strtolower(trim((string)($data['value'] ?? '')));

        // El dato puede venir de los campos capturados por el flujo o de la ficha del contacto.
        $stateVars = self::loadStateVars($conversation);
        $actual = (string)($stateVars['fields'][$field] ?? '');
        if ($actual === '' && !empty($conversation['contact_id'])) {
            $column = ['nombre' => 'name', 'email' => 'email', 'telefono' => 'phone'][$field] ?? null;
            if ($column !== null) {
                $stmt = db()->prepare("SELECT {$column} FROM contacts WHERE id = ?");
                $stmt->execute([$conversation['contact_id']]);
                $actual = (string)($stmt->fetchColumn() ?: '');
            }
        }
        if ($field === 'etiqueta') {
            $tags = array_map('mb_strtolower', $stateVars['tags'] ?? []);
            return $op === 'exists' ? !empty($tags) : in_array($value, $tags, true);
        }

        $actualLower = mb_strtolower(trim($actual));
        if ($op === 'exists') {
            return $actualLower !== '';
        }
        if ($op === 'equals') {
            return $actualLower === $value;
        }
        return $value !== '' && mb_strpos($actualLower, $value) !== false; // contains
    }

    private static function isWithinBusinessHours(array $data, int $socialAccountId): bool
    {
        $stmt = db()->prepare('
            SELECT c.timezone FROM clients c
            JOIN social_accounts sa ON sa.client_id = c.id
            WHERE sa.id = ?
        ');
        $stmt->execute([$socialAccountId]);
        $timezone = (string)($stmt->fetchColumn() ?: 'America/Mexico_City');

        try {
            $now = new DateTimeImmutable('now', new DateTimeZone($timezone));
        } catch (Throwable $e) {
            $now = new DateTimeImmutable('now');
        }

        $days = $data['days'] ?? [1, 2, 3, 4, 5]; // ISO: 1=lunes … 7=domingo
        if (!in_array((int)$now->format('N'), array_map('intval', $days), true)) {
            return false;
        }

        $start = (string)($data['start'] ?? '09:00');
        $end   = (string)($data['end'] ?? '18:00');
        $time  = $now->format('H:i');
        return $time >= $start && $time < $end;
    }

    private static function notifyTeam(array $data, array $conversation): void
    {
        $to = trim((string)($data['email'] ?? ''));
        if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
            return;
        }

        $stmt = db()->prepare('
            SELECT c.name, c.email, c.phone, c.platform, cl.name AS client_name
            FROM contacts c
            JOIN clients cl ON cl.id = c.client_id
            WHERE c.id = ?
        ');
        $stmt->execute([$conversation['contact_id'] ?? 0]);
        $contact = $stmt->fetch() ?: [];

        $stateVars = self::loadStateVars($conversation);
        $lines = [
            'Nuevo lead desde el flujo de conversación:',
            '',
            'Marca: ' . ($contact['client_name'] ?? '—'),
            'Plataforma: ' . ($contact['platform'] ?? '—'),
            'Nombre: ' . ($contact['name'] ?? '—'),
            'Email: ' . ($contact['email'] ?? '—'),
            'Teléfono: ' . ($contact['phone'] ?? '—'),
        ];
        foreach (($stateVars['fields'] ?? []) as $k => $v) {
            $lines[] = ucfirst($k) . ': ' . $v;
        }
        if (!empty($stateVars['tags'])) {
            $lines[] = 'Etiquetas: ' . implode(', ', $stateVars['tags']);
        }
        if (!empty($stateVars['csat'])) {
            $lines[] = 'Satisfacción (CSAT): ' . $stateVars['csat'] . '/5';
        }
        $lines[] = '';
        $lines[] = 'Ver conversación: ' . APP_BASE_URL . '/atencion-cliente.html';

        $subject = trim((string)($data['subject'] ?? '')) ?: 'Nuevo lead capturado';
        $headers = 'From: no-reply@' . (parse_url(APP_BASE_URL, PHP_URL_HOST) ?: 'localhost') . "\r\n"
                 . "Content-Type: text/plain; charset=UTF-8\r\n";
        @mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', implode("\n", $lines), $headers);
    }

    // ── Continuación desde nodos interactivos ────────────────────────────────

    // El usuario tocó un botón de un nodo quick_replies: sigue por la rama (salida) elegida.
    private static function continueFromOutput(int $flowId, string $nodeId, int $output, array $conversation, string $platform, string $pageToken): void
    {
        $graph = self::loadGraph($flowId);

        // Si el nodo que se está respondiendo es una encuesta CSAT, la salida elegida
        // (1-5) ES la calificación: se guarda antes de seguir por esa rama.
        $answered = self::findNode($graph, $nodeId);
        if ($answered && $answered['type'] === 'csat') {
            $stateVars = self::loadStateVars($conversation);
            $stateVars['csat'] = $output;
            self::saveStateVars($conversation['id'], $stateVars);
        }

        $next = self::nextNode($graph, $nodeId, $output);
        if ($next !== null) {
            self::executeFromNode($flowId, $next['id'], $conversation, $platform, $pageToken);
        }
    }

    // El usuario respondió a un nodo de pregunta: valida, guarda el dato en el
    // contacto (lead) y continúa el flujo.
    private static function handleAwaitedAnswer(array $stateVars, array $conversation, array $contact, string $platform, string $pageToken, string $answer): void
    {
        $awaiting = $stateVars['awaiting'];
        $value    = trim($answer);

        if (!self::validateAnswer($value, (string)($awaiting['validate'] ?? 'none'))) {
            $retry = (string)($awaiting['retry_text'] ?? '');
            if ($retry === '') {
                $retry = $awaiting['validate'] === 'email'
                    ? 'Ese correo no parece válido, ¿puedes revisarlo? (ej: nombre@dominio.com)'
                    : 'Ese número no parece válido, ¿puedes revisarlo? (solo dígitos, ej: 3001234567)';
            }
            self::sendOutbound($platform, $pageToken, self::recipientId($conversation), $retry);
            self::recordMessage($conversation['id'], 'out', 'text', $retry, null, 'flow');
            return; // sigue esperando una respuesta válida
        }

        $field = (string)($awaiting['field'] ?? 'nota');
        $stateVars['fields'][$field] = $value;
        unset($stateVars['awaiting']);
        self::saveStateVars($conversation['id'], $stateVars);
        self::saveLeadField((int)$contact['id'], $field, $value);

        $flowId = (int)$awaiting['flow_id'];
        $next   = self::nextNode(self::loadGraph($flowId), (string)$awaiting['node_id']);
        if ($next !== null) {
            self::executeFromNode($flowId, $next['id'], $conversation, $platform, $pageToken);
        }
    }

    private static function validateAnswer(string $value, string $validate): bool
    {
        if ($validate === 'email') {
            return filter_var($value, FILTER_VALIDATE_EMAIL) !== false;
        }
        if ($validate === 'phone') {
            $digits = preg_replace('/[\s\-().]/', '', $value);
            return (bool)preg_match('/^\+?\d{7,15}$/', $digits);
        }
        return $value !== '';
    }

    // Los campos estándar (nombre/email/teléfono) se guardan también en la ficha del
    // contacto para que el lead quede visible en el inbox y sea exportable.
    private static function saveLeadField(int $contactId, string $field, string $value): void
    {
        $column = ['nombre' => 'name', 'name' => 'name', 'email' => 'email', 'correo' => 'email', 'phone' => 'phone', 'telefono' => 'phone', 'teléfono' => 'phone'][mb_strtolower($field)] ?? null;
        if ($column !== null) {
            db()->prepare("UPDATE contacts SET {$column} = ? WHERE id = ?")->execute([$value, $contactId]);
        }
    }

    // ── Variables de estado de la conversación ───────────────────────────────

    private static function loadStateVars(array $conversation): array
    {
        if (!empty($conversation['state_vars'])) {
            $vars = json_decode((string)$conversation['state_vars'], true);
            if (is_array($vars)) {
                return $vars;
            }
        }
        // La fila pudo crearse en este mismo request (sin state_vars en el array): releer.
        $stmt = db()->prepare('SELECT state_vars FROM conversations WHERE id = ?');
        $stmt->execute([$conversation['id']]);
        $vars = json_decode((string)($stmt->fetchColumn() ?: ''), true);
        return is_array($vars) ? $vars : [];
    }

    private static function saveStateVars(int $conversationId, array $vars): void
    {
        db()->prepare('UPDATE conversations SET state_vars = ? WHERE id = ?')
            ->execute([$vars ? json_encode($vars) : null, $conversationId]);
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

    // $output: número de salida del nodo (1-indexado, para nodos con ramas como los
    // botones). null = primera conexión encontrada (nodos de salida única).
    private static function nextNode(array $graph, string $nodeId, ?int $output = null): ?array
    {
        foreach ($graph['edges'] ?? [] as $edge) {
            if (($edge['from'] ?? null) !== $nodeId) {
                continue;
            }
            if ($output !== null && (int)($edge['output'] ?? 1) !== $output) {
                continue;
            }
            return self::findNode($graph, $edge['to'] ?? '');
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

        // Nombre/foto del perfil, best-effort: sin esto el inbox muestra "Contacto" para
        // siempre (Meta no manda estos datos en el webhook). Si la Graph API falla o
        // restringe el campo, se sigue creando el contacto igual, solo sin nombre.
        $name = '';
        $profilePic = null;
        try {
            $profile = MetaClient::getUserProfile(self::decryptAccountToken($account), $psid);
            $name = $profile['name'];
            $profilePic = $profile['profile_pic_url'] ?: null;
        } catch (Throwable $e) {
            // silencioso: el contacto se crea sin nombre, igual que antes de este cambio
        }

        db()->prepare('
            INSERT INTO contacts (client_id, social_account_id, platform, psid, name, profile_pic_url)
            VALUES (?, ?, ?, ?, ?, ?)
        ')->execute([$account['client_id'], $account['id'], $platform === 'instagram' ? 'instagram' : 'messenger', $psid, $name, $profilePic]);

        return [
            'id' => (int)db()->lastInsertId(),
            'client_id' => $account['client_id'],
            'social_account_id' => $account['id'],
            'platform' => $platform,
            'psid' => $psid,
            'name' => $name,
            'profile_pic_url' => $profilePic,
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
            'state_vars' => null,
            'psid' => $contact['psid'],
            '_created' => true, // conversación recién creada (primer mensaje del contacto)
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
