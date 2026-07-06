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

    public static function sendPrivateReply(string $pageAccessToken, string $commentId, string $text): array
    {
        return self::request('POST', "/{$commentId}/private_replies", [
            'message' => $text,
        ], $pageAccessToken);
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
