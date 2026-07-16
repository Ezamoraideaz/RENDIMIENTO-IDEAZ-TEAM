<?php
declare(strict_types=1);

// Respuesta generada por IA para el nodo "ai" del constructor de flujos y para la
// opción "Responder con IA" del disparador de comentarios. Usa la capa gratuita de
// Groq (API compatible con el formato de chat de OpenAI, modelos open source) para
// no depender de ninguna membresía paga. Nunca lanza excepciones hacia arriba: si
// Groq falla, tarda o no está configurado, se devuelve null y quien llama decide el
// comportamiento de respaldo (mismo criterio "best effort" que MetaClient::getUserProfile()).
class AiResponder
{
    private const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
    private const MODEL   = 'llama-3.1-8b-instant';

    private static function request(array $messages, int $maxTokens): ?string
    {
        if (!defined('GROQ_API_KEY') || GROQ_API_KEY === '') {
            return null;
        }

        $ch = curl_init(self::API_URL);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . GROQ_API_KEY,
            ],
            CURLOPT_POSTFIELDS => json_encode([
                'model' => self::MODEL,
                'messages' => $messages,
                'max_tokens' => $maxTokens,
                'temperature' => 0.4,
            ]),
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_TIMEOUT => 15,
        ]);
        $response = curl_exec($ch);
        $curlErr  = curl_error($ch);
        curl_close($ch);

        if ($curlErr) {
            return null;
        }

        $data = json_decode((string)$response, true);
        $text = $data['choices'][0]['message']['content'] ?? null;
        return is_string($text) ? trim($text) : null;
    }

    // Nodo "ai" del constructor de flujos: interpreta el mensaje libre del usuario con
    // el contexto de negocio del cliente y un historial corto de la conversación.
    public static function generateNodeReply(string $businessContext, array $recentMessages, int $maxChars): ?string
    {
        $system = "Sos el asistente de atención al cliente de este negocio. "
            . "Respondé breve, en español, con este contexto del negocio:\n\n"
            . ($businessContext !== '' ? $businessContext : '(sin contexto configurado — respondé de forma genérica y cordial)')
            . "\n\nMáximo {$maxChars} caracteres. No inventes precios, horarios ni datos que no estén en el contexto.";

        $messages = [['role' => 'system', 'content' => $system]];
        foreach ($recentMessages as $m) {
            $messages[] = ['role' => $m['direction'] === 'in' ? 'user' : 'assistant', 'content' => (string)$m['content']];
        }

        $reply = self::request($messages, 300);
        if ($reply === null || $reply === '') {
            return null;
        }
        return mb_substr($reply, 0, $maxChars);
    }

    // Respuesta privada (DM) automática a alguien que comentó en una publicación de
    // Instagram/Facebook — el comentario público se queda con un texto genérico/estático
    // para no exponer info del negocio ante cualquiera que vea el post; esta respuesta
    // detallada va solo por privado. Antes de llamar a la IA, filtra por lista de
    // palabras a evitar — si el comentario la contiene, no se genera respuesta (el
    // llamador cae al texto fijo o al del nodo conectado).
    public static function generateCommentReply(string $businessContext, string $commentText, int $maxChars, array $blocklist): ?string
    {
        $needle = mb_strtolower($commentText);
        foreach ($blocklist as $word) {
            $word = trim((string)$word);
            if ($word !== '' && mb_strpos($needle, mb_strtolower($word)) !== false) {
                return null;
            }
        }

        $system = "Sos el asistente de atención al cliente de este negocio, respondiendo "
            . "por mensaje privado a alguien que comentó en una publicación. Contexto del negocio:\n\n"
            . ($businessContext !== '' ? $businessContext : '(sin contexto configurado — respondé de forma genérica y cordial)')
            . "\n\nRespondé breve y en tono profesional, máximo {$maxChars} caracteres. "
            . "No inventes precios, horarios ni datos que no estén en el contexto.";

        $messages = [
            ['role' => 'system', 'content' => $system],
            ['role' => 'user', 'content' => $commentText],
        ];

        $reply = self::request($messages, 200);
        if ($reply === null || $reply === '') {
            return null;
        }
        return mb_substr($reply, 0, $maxChars);
    }
}
