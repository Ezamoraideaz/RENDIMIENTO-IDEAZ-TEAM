<?php
declare(strict_types=1);

require_once __DIR__ . '/review_parser.php';

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
    return (defined('GEMINI_MODEL') && GEMINI_MODEL !== '') ? GEMINI_MODEL : 'gemini-3.8-flash';
}

// Modelos a probar en orden: el principal y, si está definido, uno de respaldo (GEMINI_FALLBACK_MODEL).
function gemini_models(): array
{
    $models = [gemini_model()];
    if (defined('GEMINI_FALLBACK_MODEL') && GEMINI_FALLBACK_MODEL !== '' && GEMINI_FALLBACK_MODEL !== $models[0]) {
        $models[] = (string)GEMINI_FALLBACK_MODEL;
    }
    return $models;
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

function design_review_prompt(array $row, string $clientName, string $formatHint, string $brandContext, bool $isVideo, int $fileCount, bool $isStory): string
{
    $or = static fn(string $v): string => $v !== '' ? $v : '(vacío en el cronograma)';
    $copyBlock = $isStory
        ? "- COPY: NO APLICA. Esta pieza es una HISTORIA y las historias no llevan copy/caption. No evalúes copy, gancho ni CTA."
        : "- COPY del post (columna F) — debe usar ganchos y CTA:\n" . $or($row['copy']);
    if (!empty($row['extra'])) {
        $notes = trim((string)$row['topic']);
        $dataBlock = "CONTENIDO EXTRA: esta pieza NO está en el cronograma, así que no hay indicaciones oficiales (columna D), mensaje de arte (columna E) ni copy (columna F) con qué compararla.\n"
            . 'Notas libres del diseñador (pueden venir vacías o solo traer el formato): ' . ($notes !== '' ? $notes : '(ninguna)') . "\n"
            . 'Revisa ortografía, diseño y formato con criterio profesional. Usa art_text.score = null y copy.score = null (no hay con qué comparar). '
            . 'brief.score = null salvo que las notas del diseñador traigan indicaciones concretas: en ese caso evalúalas en brief.';
    } else {
        $dataBlock = "DATOS DEL CRONOGRAMA PARA ESTE POST:\n- INDICACIONES / TEMA / REFERENCIA PARA EL DISEÑADOR (columna D):\n" . $or($row['topic'])
            . "\n\n- MENSAJE DE ARTE (columna E) — son ÚNICAMENTE los textos que deben ir dentro del arte/video:\n" . $or($row['art_text'])
            . "\n\n" . $copyBlock;
    }
    $videoRules = '';
    if ($isVideo) {
        $videoRules = <<<VIDEO

REGLAS ESPECÍFICAS PARA VIDEO / REEL (tienen prioridad sobre las reglas generales de abajo):
- El "mensaje de arte" (columna E) es el MENSAJE CLAVE en términos generales, NO un guion literal. En un video es normal que haya además subtítulos (transcripción de lo que se dice), textos de apoyo, títulos, CTA y elementos de marca. Nada de eso es un error.
- El texto cambia y se anima con rapidez (aparece palabra por palabra, por líneas, en varias escenas). El mensaje de la columna E cuenta como PRESENTE si aparece en algún momento: completo, por partes consecutivas o animado, o con el mismo sentido y casi las mismas palabras. Solo ponlo en art_text.missing si su idea central NUNCA aparece.
- art_text.extra: en video lista SOLO textos que contradigan el cronograma o no pertenezcan (datos, precios, fechas o promesas distintos a los del cronograma, otra marca, texto de relleno). NO listes subtítulos, textos de apoyo, CTA ni elementos de marca.
- art_text.score: 100 si el mensaje clave aparece con claridad; baja solo si falta o su sentido se distorsiona.
- Antes de juzgar, anota en "observed_text" todo el texto que veas en pantalla (con el minuto:segundo aproximado en "at" y su tipo en "kind": titulo, subtitulo, cta, marca u otro; máximo 40 elementos). Reporta errores ortográficos SOLO de palabras que hayas anotado ahí, completamente visibles y legibles. Ignora texto a medio animar, borroso, en movimiento rápido o parcialmente tapado: ante la duda NO lo reportes.
- En cada error ortográfico y en cada falta importante indica "at" con el mm:ss aproximado.
VIDEO;
    }
    $media = $isVideo ? 'un VIDEO (revisa TODAS las escenas, subtítulos, textos en pantalla y el audio/locución)' : ($fileCount > 1 ? "{$fileCount} imágenes (un carrusel: cada archivo es una lámina, en orden)" : 'una IMAGEN');

    return <<<PROMPT
Eres el revisor de calidad de una agencia de marketing digital en Colombia. Te envían {$media} para el post "{$row['label']}" de la marca "{$clientName}". Formato indicado por el diseñador: "{$formatHint}"; formato en el cronograma: "{$row['format']}".
{$brandContext}

{$dataBlock}
{$videoRules}

TAREA. Evalúa la pieza enviada y responde SOLO con un JSON válido (sin markdown) con esta forma exacta:
{
  "observed_text": [{"at": "mm:ss", "text": "texto visto en pantalla", "kind": "titulo|subtitulo|cta|marca|otro"}],
  "summary": "máximo 2 frases con el veredicto general",
  "art_text": {"score": 0-100 o null, "missing": ["textos de la col. E que NO aparecen en la pieza"], "extra": ["textos en la pieza que NO están en la col. E"], "notes": ["observaciones breves"]},
  "spelling": {"score": 0-100, "errors": [{"found": "texto con error tal como aparece", "suggestion": "corrección", "at": "mm:ss solo en video"}]},
  "design": {"score": 0-100, "notes": ["observaciones accionables sobre jerarquía, contraste, legibilidad, alineación, márgenes seguros, uso de marca/logo, proporción correcta para el formato"]},
  "brief": {"score": 0-100 o null, "notes": ["qué indicaciones de la col. D se cumplen o no"]},
  "copy": {"score": 0-100 o null, "has_hook": true/false, "has_cta": true/false, "spelling_errors": [{"found": "...", "suggestion": "..."}], "notes": ["observaciones sobre el copy de la col. F"]},
  "must_fix": ["lista priorizada (máx. 5) de lo que el diseñador debe corregir antes de enviar al cliente"]
}
REGLAS:
- En IMÁGENES compara el texto REAL que ves en la pieza contra la columna E, palabra por palabra (ignora diferencias solo de mayúsculas o saltos de línea). En VIDEO aplica las reglas específicas de video. "observed_text" solo se llena en video; en imágenes devuélvelo como []. Si la columna E está vacía, art_text.score = null.
- Si la columna D está vacía, brief.score = null. Si la columna F está vacía, copy.score = null. Si la pieza es una HISTORIA, copy.score = null (no se evalúa copy).
- Revisa ortografía, tildes y puntuación en español del texto DENTRO de la pieza (spelling) y del copy de la columna F (copy.spelling_errors). No marques como error los nombres propios, marcas ni hashtags.
- Una sola falta de ortografía o tilde en el texto de la pieza descalifica la pieza: repórtala SIEMPRE en spelling.errors, aunque la columna E tenga el mismo error. Si no hay ninguna, deja spelling.errors vacío y spelling.score = 100. No inventes errores: lista solo faltas reales.
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
            // 3 fotogramas por segundo (por defecto es 1): el texto animado de los reels cambia más rápido.
            $parts[] = ['file_data' => ['mime_type' => $up['mime'], 'file_uri' => $up['uri']], 'video_metadata' => ['fps' => 3]];
        } else {
            $parts[] = ['inline_data' => ['mime_type' => $mime, 'data' => base64_encode((string)file_get_contents($f['path']))]];
        }
    }

    $brandContext = ($aiContext !== null && trim($aiContext) !== '') ? "CONTEXTO DE LA MARCA:\n" . trim($aiContext) : '';
    $isStory = review_is_story((string)$row['format'], $formatHint);
    array_unshift($parts, ['text' => design_review_prompt($row, $clientName, $formatHint, $brandContext, $isVideo, count($files), $isStory)]);

    // Saturación pasajera (503/500/502/504): reintenta dos veces con pausa y luego prueba el modelo de respaldo.
    $trail = []; // último resultado por modelo (para explicar bien un error de cuota)
    $send = static function (array $parts) use (&$trail): array {
        $payload = json_encode([
            'contents'         => [['parts' => $parts]],
            'generationConfig' => ['responseMimeType' => 'application/json', 'temperature' => 0.2, 'maxOutputTokens' => 8192],
        ], JSON_UNESCAPED_UNICODE);

        $res = ['status' => 0, 'body' => '', 'curl_error' => ''];
        $models = gemini_models();
        foreach ($models as $idx => $model) {
            $previous = $res;
            for ($try = 0; $try < 2; $try++) {
                $res = gemini_http(
                    'POST',
                    GEMINI_BASE . '/v1beta/models/' . rawurlencode($model) . ':generateContent',
                    (string)$payload,
                    ['Content-Type: application/json'],
                    180
                );
                $trail[$model] = ['status' => $res['status'], 'body' => $res['body']];
                if ($idx > 0 && in_array($res['status'], [400, 403, 404], true)) {
                    // Modelo de respaldo mal escrito o sin acceso: ignorarlo y conservar el error real del principal.
                    gemini_last_error("Modelo de respaldo {$model} no usable (HTTP {$res['status']}); revisa GEMINI_FALLBACK_MODEL");
                    $res = $previous;
                    break 2;
                }
                if ($res['status'] === 429 && $idx < count($models) - 1) {
                    // Cuota agotada en este modelo (cada modelo tiene su propio cupo): pasar de inmediato al siguiente.
                    gemini_last_error("Cuota agotada en {$model}; probando {$models[$idx + 1]}");
                    continue 2;
                }
                if (!in_array($res['status'], [500, 502, 503, 504], true)) {
                    break 2; // éxito o error que reintentar no arregla
                }
                if ($try === 0) {
                    sleep(8);
                }
            }
        }
        return $res;
    };

    $res = $send($parts);
    if ($res['status'] === 400 && $isVideo) {
        // Por si el API rechazara video_metadata (fps): reintentar una vez sin ese ajuste.
        gemini_last_error('HTTP 400 con video_metadata; reintentando sin fps: ' . substr($res['body'], 0, 200));
        $plain = array_map(static function (array $p): array {
            unset($p['video_metadata']);
            return $p;
        }, $parts);
        $res = $send($plain);
    }
    foreach ($uploaded as $n) {
        gemini_delete_file($n);
    }

    if ($res['status'] !== 200) {
        $msg = $res['curl_error'] ?: (json_decode($res['body'], true)['error']['message'] ?? substr($res['body'], 0, 300));
        gemini_last_error('generateContent HTTP ' . $res['status'] . ': ' . $msg);
        if ($res['status'] === 429) {
            // Juzgar TODOS los modelos probados: la revisión solo es imposible hoy si todos agotaron su cuota diaria;
            // si alguno solo topó el límite por minuto, vale la pena reintentar en unos minutos.
            $notes = [];
            $allDaily = true;
            foreach ($trail as $m => $r) {
                if ($r['status'] === 429) {
                    $daily = stripos($r['body'], 'PerDay') !== false;
                    $notes[] = $m . ': ' . ($daily ? 'cuota diaria agotada' : 'límite por minuto');
                    $allDaily = $allDaily && $daily;
                } else {
                    $allDaily = false;
                    $notes[] = $m . ': HTTP ' . $r['status'];
                }
            }
            $detail = $notes ? ' (' . implode('; ', $notes) . ')' : '';
            if ($allDaily && $notes) {
                return ['error' => 'Se agotó la cuota DIARIA gratuita de todos los modelos de Gemini' . $detail . '. Reenvía la pieza más tarde o mañana.', 'retry' => false];
            }
            return ['error' => 'Límite gratuito de Gemini alcanzado' . $detail . '. Se reintentará en unos minutos.', 'retry' => true];
        }
        return ['error' => 'Gemini respondió con error (HTTP ' . $res['status'] . '): ' . $msg, 'retry' => $res['status'] >= 500];
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

    if ($isStory || !empty($row['extra'])) {
        $report['copy'] = ['score' => null, 'not_applicable' => true]; // las historias no llevan copy; los extras no tienen copy de cronograma
    }
    if (!empty($row['extra'])) {
        $report['art_text'] = ['score' => null, 'not_applicable' => true]; // sin mensaje de arte con qué comparar
    }
    $report = design_review_postprocess($report, $row, $isVideo);
    return ['report' => $report];
}

// Normaliza para comparar textos: minúsculas y espacios colapsados (las tildes SÍ cuentan).
function design_review_norm(string $s): string
{
    return trim((string)preg_replace('/\s+/u', ' ', mb_strtolower($s)));
}

// ¿Aparece $needle como palabra/frase completa dentro de $haystack?
function design_review_contains(string $haystack, string $needle): bool
{
    $needle = design_review_norm($needle);
    if ($needle === '') {
        return false;
    }
    return preg_match('/(?<![\p{L}\p{N}])' . preg_quote($needle, '/') . '(?![\p{L}\p{N}])/u', design_review_norm($haystack)) === 1;
}

// Reglas de negocio sobre lo que devolvió la IA:
//  - Cualquier error ortográfico en el arte DESCALIFICA la pieza (score tope 49, semáforo rojo).
//  - Si ese error ya está escrito igual en la columna E del cronograma, se marca (el diseñador copió sin revisar).
//  - Los errores del copy (columna F) los escribió la CM, no el diseñador: se reportan pero no descalifican la pieza.
function design_review_postprocess(array $report, array $row, bool $isVideo = false): array
{
    // Video: solo cuenta (y descalifica) un error si la IA lo anotó antes en observed_text, o sea que de
    // verdad lo vio en pantalla. Los demás se muestran "por confirmar" para no descalificar por una alucinación.
    $observed = '';
    $observedCount = 0;
    if ($isVideo) {
        foreach ((array)($report['observed_text'] ?? []) as $o) {
            if (is_array($o) && !empty($o['text'])) {
                $observed .= ' ' . design_review_norm((string)$o['text']);
                $observedCount++;
            }
        }
    }
    $verifiable = $isVideo && $observedCount >= 3;

    $artErrors = [];
    $unverified = [];
    foreach ((array)($report['spelling']['errors'] ?? []) as $e) {
        if (is_array($e) && !empty($e['found'])) {
            $e['in_schedule'] = design_review_contains((string)$row['art_text'], (string)$e['found']);
            if ($verifiable && mb_strpos($observed, design_review_norm((string)$e['found'])) === false) {
                $e['unverified'] = true;
                $unverified[] = $e;
                continue;
            }
            $artErrors[] = $e;
        }
    }
    $report['spelling']['errors'] = array_merge($artErrors, $unverified);

    $copyErrors = [];
    foreach ((array)($report['copy']['spelling_errors'] ?? []) as $e) {
        if (is_array($e) && !empty($e['found'])) {
            $copyErrors[] = $e;
        }
    }
    $report['copy']['spelling_errors'] = $copyErrors;

    $report['score'] = design_review_score($report);
    $report['disqualified'] = count($artErrors) > 0; // los "por confirmar" no descalifican
    $report['error_from_schedule'] = (bool)array_filter($artErrors, fn($e) => !empty($e['in_schedule']));
    if ($report['disqualified']) {
        $report['score'] = min($report['score'], 49);
    }
    return $report;
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
