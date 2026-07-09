<?php
declare(strict_types=1);

// Wrapper de la Graph API de Meta: intercambio de tokens OAuth, listado de Páginas
// administradas y su cuenta de Instagram vinculada, y suscripción a webhooks.
// Los métodos de envío de mensajes (sendMessengerMessage/sendInstagramMessage/
// sendPrivateReply) se agregan en la Fase 2 junto con el motor de disparadores.
class MetaClient
{
    private const GRAPH_VERSION = 'v21.0';
    private const GRAPH_URL = 'https://graph.facebook.com/' . self::GRAPH_VERSION;

    private static function request(string $method, string $path, array $params = [], ?string $accessToken = null): array
    {
        if ($accessToken !== null) {
            $params['access_token'] = $accessToken;
        }

        $ch = curl_init();
        if (strtoupper($method) === 'GET') {
            curl_setopt($ch, CURLOPT_URL, self::GRAPH_URL . $path . '?' . http_build_query($params));
        } else {
            curl_setopt($ch, CURLOPT_URL, self::GRAPH_URL . $path);
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($params));
        }
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 20);

        $response = curl_exec($ch);
        $curlErr  = curl_error($ch);
        curl_close($ch);

        if ($curlErr) {
            throw new RuntimeException("cURL error llamando a Meta Graph API: {$curlErr}");
        }

        $data = json_decode((string)$response, true) ?? [];
        if (isset($data['error'])) {
            throw new RuntimeException('Meta Graph API error: ' . ($data['error']['message'] ?? 'desconocido'));
        }

        return $data;
    }

    public static function exchangeCodeForUserToken(string $code): string
    {
        $data = self::request('GET', '/oauth/access_token', [
            'client_id'     => META_APP_ID,
            'client_secret' => META_APP_SECRET,
            'redirect_uri'  => OAUTH_REDIRECT_URI,
            'code'          => $code,
        ]);
        return $data['access_token'];
    }

    public static function exchangeForLongLivedUserToken(string $shortLivedToken): string
    {
        $data = self::request('GET', '/oauth/access_token', [
            'grant_type'        => 'fb_exchange_token',
            'client_id'         => META_APP_ID,
            'client_secret'     => META_APP_SECRET,
            'fb_exchange_token' => $shortLivedToken,
        ]);
        return $data['access_token'];
    }

    // Devuelve las Páginas administradas por el usuario, cada una con su token de
    // página (no expira mientras el token de usuario sea válido) y su cuenta de
    // Instagram Business vinculada (si existe).
    public static function listManagedPages(string $userAccessToken): array
    {
        $data = self::request('GET', '/me/accounts', [
            'fields' => 'id,name,access_token,instagram_business_account{id,username}',
        ], $userAccessToken);
        return $data['data'] ?? [];
    }

    public static function subscribePageToWebhook(string $pageId, string $pageAccessToken, array $fields): array
    {
        return self::request('POST', "/{$pageId}/subscribed_apps", [
            'subscribed_fields' => implode(',', $fields),
        ], $pageAccessToken);
    }

    public static function sendMessengerMessage(string $pageAccessToken, string $recipientPsid, string $text): array
    {
        return self::request('POST', '/me/messages', [
            'recipient'      => json_encode(['id' => $recipientPsid]),
            'message'        => json_encode(['text' => $text]),
            'messaging_type' => 'RESPONSE',
        ], $pageAccessToken);
    }

    public static function sendInstagramMessage(string $pageAccessToken, string $recipientIgsid, string $text): array
    {
        // Mismo endpoint que Messenger; Meta enruta según a qué activo pertenece el token.
        return self::sendMessengerMessage($pageAccessToken, $recipientIgsid, $text);
    }

    // Mensaje con botones de respuesta rápida (quick replies). Funciona igual en
    // Messenger e Instagram (content_type "text", máx. 13 opciones). Cada opción lleva
    // un payload que el webhook recibe en message.quick_reply.payload al ser tocada.
    // $options: [['title' => 'Sí', 'payload' => 'qr:...'], ...]
    public static function sendQuickReplies(string $pageAccessToken, string $recipientPsid, string $text, array $options): array
    {
        $quickReplies = [];
        foreach (array_slice($options, 0, 13) as $option) {
            $quickReplies[] = [
                'content_type' => 'text',
                'title'        => mb_substr((string)$option['title'], 0, 20), // límite de Meta: 20 caracteres
                'payload'      => (string)$option['payload'],
            ];
        }
        return self::request('POST', '/me/messages', [
            'recipient'      => json_encode(['id' => $recipientPsid]),
            'message'        => json_encode(['text' => $text, 'quick_replies' => $quickReplies]),
            'messaging_type' => 'RESPONSE',
        ], $pageAccessToken);
    }

    // Envía una imagen por URL pública (jpg/png/gif). Funciona en Messenger e Instagram.
    public static function sendImage(string $pageAccessToken, string $recipientPsid, string $imageUrl): array
    {
        return self::request('POST', '/me/messages', [
            'recipient'      => json_encode(['id' => $recipientPsid]),
            'message'        => json_encode([
                'attachment' => [
                    'type'    => 'image',
                    'payload' => ['url' => $imageUrl, 'is_reusable' => true],
                ],
            ]),
            'messaging_type' => 'RESPONSE',
        ], $pageAccessToken);
    }

    // Tarjeta (generic template): imagen + título + subtítulo + botones de enlace.
    // Es el formato de conversión por excelencia (llevar al usuario a una landing,
    // catálogo o WhatsApp). Soportado en Messenger e Instagram.
    // $buttons: [['title' => 'Ver más', 'url' => 'https://...'], ...] (máx. 3)
    public static function sendCard(string $pageAccessToken, string $recipientPsid, string $title, string $subtitle, string $imageUrl, array $buttons): array
    {
        $urlButtons = [];
        foreach (array_slice($buttons, 0, 3) as $btn) {
            if (empty($btn['url'])) {
                continue;
            }
            $urlButtons[] = [
                'type'  => 'web_url',
                'url'   => (string)$btn['url'],
                'title' => mb_substr((string)($btn['title'] ?? 'Ver más'), 0, 20),
            ];
        }

        $element = ['title' => mb_substr($title, 0, 80)];
        if ($subtitle !== '') {
            $element['subtitle'] = mb_substr($subtitle, 0, 80);
        }
        if ($imageUrl !== '') {
            $element['image_url'] = $imageUrl;
        }
        if ($urlButtons) {
            $element['buttons'] = $urlButtons;
        }

        return self::request('POST', '/me/messages', [
            'recipient'      => json_encode(['id' => $recipientPsid]),
            'message'        => json_encode([
                'attachment' => [
                    'type'    => 'template',
                    'payload' => ['template_type' => 'generic', 'elements' => [$element]],
                ],
            ]),
            'messaging_type' => 'RESPONSE',
        ], $pageAccessToken);
    }

    public static function sendPrivateReply(string $pageAccessToken, string $commentId, string $text): array
    {
        return self::request('POST', "/{$commentId}/private_replies", [
            'message' => $text,
        ], $pageAccessToken);
    }

    // Respuesta pública al propio comentario (visible para el resto de la comunidad,
    // a diferencia de sendPrivateReply que solo la ve quien comentó). Sube el engagement
    // del post y muestra a otros seguidores que la marca responde.
    public static function replyToComment(string $pageAccessToken, string $commentId, string $text): array
    {
        return self::request('POST', "/{$commentId}/comments", [
            'message' => $text,
        ], $pageAccessToken);
    }

    // Carrusel (generic template con varios elementos, máx. 10 de Meta): útil para
    // mostrar catálogo/promos/posts destacados en un solo mensaje. Cada item admite
    // título, subtítulo, imagen y un botón de enlace opcional.
    // $items: [['title','subtitle','image_url','button_title','button_url'], ...]
    public static function sendCarousel(string $pageAccessToken, string $recipientPsid, array $items): array
    {
        $elements = [];
        foreach (array_slice($items, 0, 10) as $item) {
            $element = ['title' => mb_substr((string)($item['title'] ?? ''), 0, 80)];
            if (!empty($item['subtitle'])) {
                $element['subtitle'] = mb_substr((string)$item['subtitle'], 0, 80);
            }
            if (!empty($item['image_url'])) {
                $element['image_url'] = (string)$item['image_url'];
            }
            if (!empty($item['button_url'])) {
                $element['buttons'] = [[
                    'type'  => 'web_url',
                    'url'   => (string)$item['button_url'],
                    'title' => mb_substr((string)($item['button_title'] ?? 'Ver más'), 0, 20),
                ]];
            }
            $elements[] = $element;
        }

        return self::request('POST', '/me/messages', [
            'recipient'      => json_encode(['id' => $recipientPsid]),
            'message'        => json_encode([
                'attachment' => [
                    'type'    => 'template',
                    'payload' => ['template_type' => 'generic', 'elements' => $elements],
                ],
            ]),
            'messaging_type' => 'RESPONSE',
        ], $pageAccessToken);
    }

    // Perfil público básico del usuario que escribió (nombre + foto), para no mostrar
    // "Contacto" genérico en el inbox. Best-effort: Meta restringe algunos campos de
    // perfil sin revisión de app adicional, así que se debe tolerar que falle.
    public static function getUserProfile(string $pageAccessToken, string $psid): array
    {
        $data = self::request('GET', "/{$psid}", [
            'fields' => 'name,profile_pic',
        ], $pageAccessToken);
        return [
            'name'            => (string)($data['name'] ?? ''),
            'profile_pic_url' => (string)($data['profile_pic'] ?? ''),
        ];
    }

    // Datos completos de un lead de formulario instantáneo (Instant Forms / Lead Ads),
    // capturado vía el campo de webhook "leadgen". Requiere el permiso leads_retrieval.
    public static function getLeadDetails(string $pageAccessToken, string $leadgenId): array
    {
        return self::request('GET', "/{$leadgenId}", [
            'fields' => 'field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,created_time',
        ], $pageAccessToken);
    }

    // Formularios instantáneos configurados en la página (para mostrar nombres reales
    // en vez de IDs al filtrar/organizar leads por formulario).
    public static function listLeadForms(string $pageAccessToken, string $pageId): array
    {
        $data = self::request('GET', "/{$pageId}/leadgen_forms", [
            'fields' => 'id,name,status',
        ], $pageAccessToken);
        return $data['data'] ?? [];
    }

    // Nombre de un formulario puntual (getLeadDetails solo trae form_id, no el nombre).
    public static function getFormName(string $pageAccessToken, string $formId): string
    {
        $data = self::request('GET', "/{$formId}", ['fields' => 'name'], $pageAccessToken);
        return (string)($data['name'] ?? '');
    }

    public static function verifySignature(string $rawBody, ?string $signatureHeader, string $appSecret): bool
    {
        if (!$signatureHeader || strpos($signatureHeader, 'sha256=') !== 0) {
            return false;
        }
        $expected = 'sha256=' . hash_hmac('sha256', $rawBody, $appSecret);
        return hash_equals($expected, $signatureHeader);
    }
}
