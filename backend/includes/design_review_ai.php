<?php
declare(strict_types=1);

// Revisión de una pieza (imagen/video) con Gemini (capa gratuita), cruzada con lo
// que dice el cronograma para ese post. Imágenes van en línea (base64); videos
// se suben primero a la File API de Gemini y se borran al terminar. Nunca lanza
// excepciones: devuelve ['error' => '...'] y deja el detalle en gemini_last_error().

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

function gemini_last_error(?string $set = null): ?string
{
    static $last = null;
    if ($set !== null) {
        $last = $set;
        error_log('[gemini] ' . $set);
    }
    return $last;
}

function gemini_configured(): bool
{
    return defined('GEMINI_API_KEY') && GEMINI_API_KEY !== '';
}

function gemini_model(): string
{
    return (defined('GEMINI_MODEL') && GEMINI_MODEL !== '') ? GEMINI_MODEL : 'gemini-2.5-flash';
}

function gemini_http(string $method, string $url, ?string $body = null, array $headers = [], int $timeout = 60): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_HTTPHEADER     => array_merge(['x-goog-api-key: ' . GEMINI_API_KEY], $headers),
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_TIMEOUT        => $timeout,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    return ['status' => $status, 'body' => $raw === false ? '' : (string)$raw, 'curl_error' => $err];
}

// Sube un video a la File API (multipart) y espera a que quede ACTIVE.
function gemini_upload_file(string $path, string $mime): ?array
{
    $boundary = 'ideaz' . bin2hex(random_bytes(8));
    $meta = json_encode(['file' => ['display_name' => basename($path)]]);
    $body = "--{$boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{$meta}\r\n"
        . "--{$boundary}\r\nContent-Type: {$mime}\r\n\r\n"
        . file_get_contents($path) . "\r\n--{$boundary}--\r\n";

    $res = gemini_http(
        'POST',
        GEMINI_BASE . '/upload/v1beta/files',
        $body,
        ['X-Goog-Upload-Protocol: multipart', 'Content-Type: multipart/related; boundary=' . $boundary],
        180
    );
    $data = json_decode($res['body'], true);
    if ($res['status'] !== 200 || empty($data['file']['name'])) {
        gemini_last_error('Subida a Gemini falló (HTTP ' . $res['status'] . '): ' . ($res['curl_error'] ?: substr($res['body'], 0, 300)));
        return null;
    }
    $file = $data['file'];

    // El video se procesa de forma asíncrona: esperar a ACTIVE (máx. ~90 s).
    for ($i = 0; $i < 30 && ($file['state'] ?? '') === 'PROCESSING'; $i++) {
        sleep(3);
        $poll = gemini_http('GET', GEMINI_BASE . '/v1beta/' . $file['name'], null, [], 30);
        $d = json_decode($poll['body'], true);
        if ($poll['status'] === 200 && is_array($d)) {
            $file = $d;
        }
    }
    if (($file['state'] ?? '') !== 'ACTIVE') {
        gemini_last_error('El video no quedó listo en Gemini (estado: ' . ($file['state'] ?? '?') . ')');
        gemini_delete_file((string)$file['name']);
        return null;
    }
    return ['name' => (string)$file['name'], 'uri' => (string)$file['uri'], 'mime' => (string)($file['mimeType'] ?? $mime)];
}

function gemini_delete_file(string $name): void
{
    gemini_http('DELETE', GEMINI_BASE . '/v1beta/' . $name, null, [], 20);
}

function design_review_mime(string $path, string $kind): string
{
    $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $map = [
        'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp',
        'heic' => 'image/heic', 'mp4' => 'video/mp4', 'mov' => 'video/quicktime', 'webm' => 'video/webm',
        'm4v' => 'video/mp4', 'mpeg' => 'video/mpeg', 'avi' => 'video/avi',
    ];
    return $map[$ext] ?? ($kind === 'video' ? 'video/mp4' : 'image/jpeg');
}

// Pesos del score final (suman 100). Si una categoría no aplica (p. ej. el cronograma
// no trae indicaciones en D), su peso se reparte entre las demás.
const DESIGN_REVIEW_WEIGHTS = ['art_text' => 30, 'spelling' => 20, 'design' => 25, 'brief' => 15, 'copy' => 10];

function design_review_prompt(array $row, string $clientName, string $formatHint, string $brandContext, bool $isVideo, int $fileCount): string
{
    $or = static fn(string $v): string => $v !== '' ? $v : '(vacío en el cronograma)';
    $media = $isVideo ? 'un VIDEO (revisa TODAS las escenas, subtítulos, textos en pantalla y el audio/locución)' : ($fileCount > 1 ? "{$fileCount} imágenes (un carrusel: cada archivo es una lámina, en orden)" : 'una IMAGEN');

    return <<<PROMPT
Eres el revisor de calidad de una agencia de marketing digital en Colombia. Te envían {$media} para el post "{$row['label']}" de la marca "{$clientName}". Formato indicado por el diseñador: "{$formatHint}"; formato en el cronograma: "{$row['format']}".
{$brandContext}

DATOS DEL CRONOGRAMA PARA ESTE POST:
- INDICACIONES / TEMA / REFERENCIA PARA EL DISEÑADOR (columna D):
{$or($row['topic'])}

- MENSAJE DE ARTE (columna E) — son ÚNICAMENTE los textos que deben ir dentro del arte/video:
{$or($row['art_text'])}

- COPY del post (columna F) — debe usar ganchos y CTA:
{$or($row['copy'])}

TAREA. Evalúa la pieza enviada y responde SOLO con un JSON válido (sin markdown) con esta forma exacta:
{
  "summary": "máximo 2 frases con el veredicto general",
  "art_text": {"score": 0-100 o null, "missing": ["textos de la col. E que NO aparecen en la pieza"], "extra": ["textos en la pieza que NO están en la col. E"], "notes": ["observaciones breves"]},
  "spelling": {"score": 0-100, "errors": [{"found": "texto con error tal como aparece", "suggestion": "corrección"}]},
  "design": {"score": 0-100, "notes": ["observaciones accionables sobre jerarquía, contraste, legibilidad, alineación, márgenes seguros, uso de marca/logo, proporción correcta para el formato"]},
  "brief": {"score": 0-100 o null, "notes": ["qué indicaciones de la col. D se cumplen o no"]},
  "copy": {"score": 0-100 o null, "has_hook": true/false, "has_cta": true/false, "spelling_errors": [{"found": "...", "suggestion": "..."}], "notes": ["observaciones sobre el copy de la col. F"]},
  "must_fix": ["lista priorizada (máx. 5) de lo que el diseñador debe corregir antes de enviar al cliente"]
}
REGLAS:
- Compara el texto REAL que ves en la pieza contra la columna E, palabra por palabra (ignora diferencias solo de mayúsculas o saltos de línea). Si la columna E está vacía, art_text.score = null.
- Si la columna D está vacía, brief.score = null. Si la columna F está vacía, copy.score = null.
- Revisa ortografía, tildes y puntuación en español del texto DENTRO de la pieza (spelling) y del copy de la columna F (copy.spelling_errors). No marques como error los nombres propios, marcas ni hashtags.
- Sé concreto y breve: cada nota en una frase. No inventes problemas; si algo está bien, dilo. Si no puedes leer algún texto, indícalo en notes.
- Escribe todo en español.
PROMPT;
}

// $files: [['path' => ..., 'kind' => 'image'|'video'], ...]. Devuelve ['report' => array] o ['error' => string].
function design_review_run(array $row, string $clientName, ?string $aiContext, string $formatHint, array $files): array
{
    if (!gemini_configured()) {
        return ['error' => 'GEMINI_API_KEY no está definido en config.php'];
    }

    $isVideo = false;
    $parts = [];
    $uploaded = [];
    foreach ($files as $f) {
        $mime = design_review_mime($f['path'], $f['kind']);
        if ($f['kind'] === 'video') {
            $isVideo = true;
            $up = gemini_upload_file($f['path'], $mime);
            if ($up === null) {
                foreach ($uploaded as $n) {
                    gemini_delete_file($n);
                }
                return ['error' => 'No se pudo subir el video a Gemini: ' . gemini_last_error()];
            }
            $uploaded[] = $up['name'];
            $parts[] = ['file_data' => ['mime_type' => $up['mime'], 'file_uri' => $up['uri']]];
        } else {
            $parts[] = ['inline_data' => ['mime_type' => $mime, 'data' => base64_encode((string)file_get_contents($f['path']))]];
        }
    }

    $brandContext = ($aiContext !== null && trim($aiContext) !== '') ? "CONTEXTO DE LA MARCA:\n" . trim($aiContext) : '';
    array_unshift($parts, ['text' => design_review_prompt($row, $clientName, $formatHint, $brandContext, $isVideo, count($files))]);

    $payload = json_encode([
        'contents'         => [['parts' => $parts]],
        'generationConfig' => ['responseMimeType' => 'application/json', 'temperature' => 0.2, 'maxOutputTokens' => 8192],
    ], JSON_UNESCAPED_UNICODE);

    $res = gemini_http(
        'POST',
        GEMINI_BASE . '/v1beta/models/' . rawurlencode(gemini_model()) . ':generateContent',
        (string)$payload,
        ['Content-Type: application/json'],
        180
    );
    foreach ($uploaded as $n) {
        gemini_delete_file($n);
    }

    if ($res['status'] !== 200) {
        $msg = $res['curl_error'] ?: (json_decode($res['body'], true)['error']['message'] ?? substr($res['body'], 0, 300));
        gemini_last_error('generateContent HTTP ' . $res['status'] . ': ' . $msg);
        return ['error' => $res['status'] === 429
            ? 'Se alcanzó el límite gratuito de Gemini (cuota por minuto/día). Se reintentará más tarde.'
            : 'Gemini respondió con error (HTTP ' . $res['status'] . '): ' . $msg, 'retry' => $res['status'] === 429 || $res['status'] >= 500];
    }

    $data = json_decode($res['body'], true);
    $text = '';
    foreach ($data['candidates'][0]['content']['parts'] ?? [] as $p) {
        $text .= (string)($p['text'] ?? '');
    }
    $text = trim((string)preg_replace('/^```(?:json)?\s*|\s*```$/i', '', trim($text)));
    $report = json_decode($text, true);
    if (!is_array($report)) {
        gemini_last_error('Respuesta de Gemini no es JSON válido: ' . substr($text, 0, 300));
        return ['error' => 'Gemini devolvió una respuesta ilegible. Se reintentará.', 'retry' => true];
    }

    $report['score'] = design_review_score($report);
    return ['report' => $report];
}

// Score final ponderado (0-100). Categorías sin score (null) no cuentan.
function design_review_score(array $report): int
{
    $sum = 0.0;
    $weight = 0;
    foreach (DESIGN_REVIEW_WEIGHTS as $key => $w) {
        $s = $report[$key]['score'] ?? null;
        if (is_numeric($s)) {
            $sum += max(0, min(100, (float)$s)) * $w;
            $weight += $w;
        }
    }
    return $weight > 0 ? (int)round($sum / $weight) : 0;
}
