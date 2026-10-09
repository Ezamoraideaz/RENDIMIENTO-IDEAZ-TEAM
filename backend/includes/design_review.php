<?php
declare(strict_types=1);

// Orquesta la revisión de piezas por Telegram: ingesta de mensajes del grupo
// (webhook), procesamiento de la cola (cron), formato del reporte y botones de CM/PM.
// Los botones son solo comunicación: registran el evento y avisan en el grupo, sin
// tocar Trello ni content_items (el estado en Trello lo sigue moviendo la CM/PM a mano).

require_once __DIR__ . '/telegram_api.php';
require_once __DIR__ . '/review_parser.php';
require_once __DIR__ . '/design_review_ai.php';
require_once __DIR__ . '/google_sheets.php';

const DESIGN_REVIEW_MAX_ATTEMPTS = 3;

function design_review_tmp_dir(int $reviewId): string
{
    return __DIR__ . '/../storage/review_tmp/' . $reviewId;
}

// ---------------------------------------------------------------- Roles

// 'cm' | 'pm' | null (null = diseñador). Compara las reglas contra @usuario + nombre + apellido.
function design_review_role(PDO $pdo, ?int $clientId, array $from): ?string
{
    $haystack = mb_strtolower(trim(
        ($from['username'] ?? '') . ' ' . ($from['first_name'] ?? '') . ' ' . ($from['last_name'] ?? '')
    ));
    if ($haystack === '') {
        return null;
    }
    $stmt = $pdo->prepare('SELECT role, match_text FROM telegram_role_rules WHERE client_id IS NULL OR client_id = ? ORDER BY role');
    $stmt->execute([$clientId]);
    foreach ($stmt->fetchAll() as $rule) {
        $needle = mb_strtolower(trim((string)$rule['match_text']));
        if ($needle !== '' && mb_strpos($haystack, $needle) !== false) {
            return (string)$rule['role'];
        }
    }
    return null;
}

function design_review_display_name(array $from): string
{
    $name = trim(($from['first_name'] ?? '') . ' ' . ($from['last_name'] ?? ''));
    return $name !== '' ? $name : (string)($from['username'] ?? 'Usuario');
}

function design_review_mention(int $userId, string $name): string
{
    return '<a href="tg://user?id=' . $userId . '">' . tg_h($name) . '</a>';
}

// ---------------------------------------------------------------- Ingesta

// Punto de entrada único para un update de Telegram (lo usan el webhook y el polling).
function design_review_dispatch_update(PDO $pdo, array $update): void
{
    if (isset($update['message']) && is_array($update['message'])) {
        design_review_ingest_message($pdo, $update['message']);
    } elseif (isset($update['callback_query']) && is_array($update['callback_query'])) {
        design_review_handle_callback($pdo, $update['callback_query']);
    }
}

// Extrae [kind, file_id, mime, size, name] del mensaje, o null si no trae una pieza.
function design_review_extract_media(array $msg): ?array
{
    if (!empty($msg['photo']) && is_array($msg['photo'])) {
        $p = end($msg['photo']); // la más grande
        return ['kind' => 'image', 'file_id' => (string)$p['file_id'], 'mime' => 'image/jpeg', 'size' => (int)($p['file_size'] ?? 0), 'name' => null];
    }
    if (!empty($msg['video'])) {
        $v = $msg['video'];
        return ['kind' => 'video', 'file_id' => (string)$v['file_id'], 'mime' => (string)($v['mime_type'] ?? 'video/mp4'), 'size' => (int)($v['file_size'] ?? 0), 'name' => $v['file_name'] ?? null];
    }
    if (!empty($msg['animation'])) {
        $v = $msg['animation'];
        return ['kind' => 'video', 'file_id' => (string)$v['file_id'], 'mime' => (string)($v['mime_type'] ?? 'video/mp4'), 'size' => (int)($v['file_size'] ?? 0), 'name' => $v['file_name'] ?? null];
    }
    if (!empty($msg['document'])) {
        $d = $msg['document'];
        $mime = (string)($d['mime_type'] ?? '');
        if (str_starts_with($mime, 'image/')) {
            return ['kind' => 'image', 'file_id' => (string)$d['file_id'], 'mime' => $mime, 'size' => (int)($d['file_size'] ?? 0), 'name' => $d['file_name'] ?? null];
        }
        if (str_starts_with($mime, 'video/')) {
            return ['kind' => 'video', 'file_id' => (string)$d['file_id'], 'mime' => $mime, 'size' => (int)($d['file_size'] ?? 0), 'name' => $d['file_name'] ?? null];
        }
    }
    return null;
}

function design_review_group_client(PDO $pdo, int $chatId): ?array
{
    $stmt = $pdo->prepare('SELECT c.id, c.name FROM telegram_groups g JOIN clients c ON c.id = g.client_id WHERE g.chat_id = ?');
    $stmt->execute([$chatId]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function design_review_next_version(PDO $pdo, int $clientId, int $post, int $excludeId = 0): int
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM design_reviews WHERE client_id = ? AND post_number = ? AND id <> ? AND status IN ("pending","processing","done","failed")');
    $stmt->execute([$clientId, $post, $excludeId]);
    return (int)$stmt->fetchColumn() + 1;
}

function design_review_ingest_message(PDO $pdo, array $msg): void
{
    $chat = $msg['chat'] ?? [];
    $chatId = (int)($chat['id'] ?? 0);
    $from = $msg['from'] ?? [];
    if ($chatId === 0 || empty($from['id']) || !empty($from['is_bot'])) {
        return;
    }
    $isGroup = in_array($chat['type'] ?? '', ['group', 'supergroup'], true);

    // Comandos (/vincular, /estado, /ayuda)
    $text = (string)($msg['text'] ?? '');
    if ($text !== '' && $text[0] === '/') {
        design_review_command($pdo, $msg, $isGroup);
        return;
    }
    if (!$isGroup) {
        return;
    }

    $media = design_review_extract_media($msg);
    if ($media === null) {
        return;
    }

    $group = design_review_group_client($pdo, $chatId);
    $caption = trim((string)($msg['caption'] ?? ''));
    $parsed = review_parse_caption($caption);

    if ($group === null) {
        // Solo avisar cuando claramente intentaron enviar una pieza (llevaba "#número").
        if ($parsed['post'] !== null) {
            telegram_send_message($chatId, '⚠️ Este grupo todavía no está vinculado a una marca. Un administrador del grupo debe escribir <code>/vincular nombre-o-slug-de-la-marca</code>.', (int)$msg['message_id']);
        }
        return;
    }

    // CM/PM comentan; no suben piezas para revisar.
    if (design_review_role($pdo, (int)$group['id'], $from) !== null) {
        return;
    }

    $mgid = isset($msg['media_group_id']) ? (string)$msg['media_group_id'] : null;
    if ($mgid === null && $parsed['post'] === null) {
        return; // foto suelta sin "#número": no es una pieza para revisar
    }

    $lockName = $mgid !== null ? 'tgmg:' . $chatId . ':' . $mgid : null;
    if ($lockName !== null) {
        $l = $pdo->prepare('SELECT GET_LOCK(?, 5)');
        $l->execute([$lockName]);
    }
    try {
        $reviewId = 0;
        if ($mgid !== null) {
            $stmt = $pdo->prepare('SELECT id, post_number FROM design_reviews WHERE chat_id = ? AND media_group_id = ? AND status IN ("collecting","pending") ORDER BY id LIMIT 1');
            $stmt->execute([$chatId, $mgid]);
            $existing = $stmt->fetch();
            if ($existing) {
                $reviewId = (int)$existing['id'];
                if ($existing['post_number'] === null && $parsed['post'] !== null) {
                    $pdo->prepare('UPDATE design_reviews SET post_number = ?, pub_day = ?, caption = ?, message_id = ?, version = ?, status = "pending" WHERE id = ?')
                        ->execute([$parsed['post'], $parsed['day'], $caption, (int)$msg['message_id'], design_review_next_version($pdo, (int)$group['id'], $parsed['post'], $reviewId), $reviewId]);
                }
                $pdo->prepare('UPDATE design_reviews SET last_file_at = NOW() WHERE id = ?')->execute([$reviewId]);
            }
        }
        if ($reviewId === 0) {
            $pdo->prepare('
                INSERT INTO design_reviews (client_id, chat_id, message_id, media_group_id, from_user_id, from_name, post_number, pub_day, caption, version, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ')->execute([
                (int)$group['id'], $chatId, (int)$msg['message_id'], $mgid, (int)$from['id'], design_review_display_name($from),
                $parsed['post'], $parsed['day'], $caption,
                $parsed['post'] !== null ? design_review_next_version($pdo, (int)$group['id'], $parsed['post']) : 1,
                $parsed['post'] !== null ? 'pending' : 'collecting',
            ]);
            $reviewId = (int)$pdo->lastInsertId();
        }
        $pdo->prepare('INSERT INTO design_review_files (review_id, tg_file_id, kind, mime, size_bytes, file_name) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$reviewId, $media['file_id'], $media['kind'], $media['mime'], $media['size'] ?: null, $media['name']]);
    } finally {
        if ($lockName !== null) {
            $r = $pdo->prepare('SELECT RELEASE_LOCK(?)');
            $r->execute([$lockName]);
        }
    }
}

function design_review_command(PDO $pdo, array $msg, bool $isGroup): void
{
    $chatId = (int)$msg['chat']['id'];
    $from = $msg['from'];
    $replyTo = (int)$msg['message_id'];
    $parts = preg_split('/\s+/', trim((string)$msg['text']), 2);
    $cmd = strtolower(preg_replace('/@.*$/', '', (string)$parts[0]));
    $arg = trim((string)($parts[1] ?? ''));

    if (!$isGroup) {
        if ($cmd === '/start' || $cmd === '/ayuda') {
            telegram_send_message($chatId, 'Hola 👋 Soy el revisor de piezas de IDEAZ. Agrégame como administrador al grupo de una marca y escribe allí <code>/vincular marca</code>.');
        }
        return;
    }

    if ($cmd === '/vincular') {
        $member = telegram_call('getChatMember', ['chat_id' => $chatId, 'user_id' => (int)$from['id']]);
        $status = is_array($member) ? (string)($member['status'] ?? '') : '';
        if (!in_array($status, ['creator', 'administrator'], true)) {
            telegram_send_message($chatId, '🔒 Solo un administrador del grupo puede vincularlo a una marca.', $replyTo);
            return;
        }
        $clients = $pdo->query('SELECT id, name, slug FROM clients WHERE status = "active" ORDER BY name')->fetchAll();
        $match = null;
        $needle = mb_strtolower($arg);
        foreach ($clients as $c) {
            if ($needle !== '' && ($needle === mb_strtolower($c['slug']) || $needle === mb_strtolower($c['name']))) {
                $match = $c;
                break;
            }
        }
        if ($match === null && $needle !== '') {
            $cands = array_values(array_filter($clients, fn($c) => mb_strpos(mb_strtolower($c['name'] . ' ' . $c['slug']), $needle) !== false));
            if (count($cands) === 1) {
                $match = $cands[0];
            }
        }
        if ($match === null) {
            $list = implode("\n", array_map(fn($c) => '• <code>' . tg_h($c['slug']) . '</code> — ' . tg_h($c['name']), array_slice($clients, 0, 40)));
            telegram_send_message($chatId, "No encontré esa marca. Usa <code>/vincular slug</code> con uno de estos:\n" . $list, $replyTo);
            return;
        }
        $pdo->prepare('INSERT INTO telegram_groups (chat_id, client_id, title) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE client_id = VALUES(client_id), title = VALUES(title)')
            ->execute([$chatId, (int)$match['id'], (string)($msg['chat']['title'] ?? '')]);
        telegram_send_message($chatId, '✅ Grupo vinculado a <b>' . tg_h($match['name']) . "</b>.\nPara revisar una pieza, envíala con un texto como: <code>#5 - 18 REEL FEED</code> (#ID del post - día de publicación - formato).\nTip: envía imágenes como <b>archivo</b> (sin comprimir) para que la IA lea mejor los textos.", $replyTo);
        return;
    }

    if ($cmd === '/estado') {
        $g = design_review_group_client($pdo, $chatId);
        if ($g === null) {
            telegram_send_message($chatId, 'Este grupo no está vinculado a ninguna marca (usa <code>/vincular</code>).', $replyTo);
            return;
        }
        $stmt = $pdo->prepare('SELECT status, COUNT(*) n FROM design_reviews WHERE chat_id = ? AND created_at >= (NOW() - INTERVAL 30 DAY) GROUP BY status');
        $stmt->execute([$chatId]);
        $counts = [];
        foreach ($stmt->fetchAll() as $r) {
            $counts[$r['status']] = (int)$r['n'];
        }
        telegram_send_message($chatId, 'Marca: <b>' . tg_h($g['name']) . '</b>' . "\nÚltimos 30 días — revisadas: " . ($counts['done'] ?? 0) . ', en cola: ' . (($counts['pending'] ?? 0) + ($counts['processing'] ?? 0)) . ', con error: ' . ($counts['failed'] ?? 0), $replyTo);
        return;
    }

    if ($cmd === '/ayuda' || $cmd === '/start') {
        telegram_send_message($chatId, "Envía la pieza (imagen, carrusel o video de hasta 20 MB) con un texto así:\n<code>#5 - 18 REEL FEED</code>\n(#ID del post · día de publicación · formato)\nLa IA la cruza con el cronograma (indicaciones, mensaje de arte y copy) y responde con un reporte. Si corriges la pieza, reenvíala con el mismo #ID: queda como nueva versión.", $replyTo);
    }
}

// ---------------------------------------------------------------- Reporte

function design_review_clip(string $s, int $max = 220): string
{
    $s = trim(preg_replace('/\s+/u', ' ', $s) ?? $s);
    return mb_strlen($s) > $max ? mb_substr($s, 0, $max - 1) . '…' : $s;
}

function design_review_bullets(array $items, string $icon, int $limit = 4): string
{
    $out = '';
    $items = array_values(array_filter($items, fn($i) => is_string($i) && trim($i) !== ''));
    foreach (array_slice($items, 0, $limit) as $i) {
        $out .= $icon . ' ' . tg_h(design_review_clip($i)) . "\n";
    }
    if (count($items) > $limit) {
        $out .= '… y ' . (count($items) - $limit) . " más\n";
    }
    return $out;
}

function design_review_errors_list(array $errors, int $limit = 5): string
{
    $out = '';
    $errors = array_values(array_filter($errors, fn($e) => is_array($e) && !empty($e['found'])));
    foreach (array_slice($errors, 0, $limit) as $e) {
        $out .= '✏️ <s>' . tg_h(design_review_clip((string)$e['found'], 80)) . '</s> → <b>' . tg_h(design_review_clip((string)($e['suggestion'] ?? '?'), 80)) . "</b>\n";
    }
    if (count($errors) > $limit) {
        $out .= '… y ' . (count($errors) - $limit) . " más\n";
    }
    return $out;
}

function design_review_cat_title(string $title, $score): string
{
    return '<b>' . $title . '</b>' . (is_numeric($score) ? ' · ' . (int)$score . '/100' : ' · n/a') . "\n";
}

function design_review_format_report(array $review, array $row, array $report, ?DateTimeImmutable $pubMonth, ?string $warning): string
{
    $score = (int)$report['score'];
    [$icon, $label] = review_semaphore($score);
    $dayTxt = $review['pub_day'] ? ' · publica ' . str_pad((string)$review['pub_day'], 2, '0', STR_PAD_LEFT) . ($pubMonth ? '/' . $pubMonth->format('m') : '') : '';

    $t = "{$icon} <b>Revisión IA · " . tg_h($row['label']) . ' · v' . (int)$review['version'] . '</b>' . tg_h($dayTxt) . "\n";
    $t .= '<b>Score: ' . $score . '/100</b> — ' . $label . "\n";
    if (!empty($report['summary'])) {
        $t .= '<i>' . tg_h(design_review_clip((string)$report['summary'], 300)) . "</i>\n";
    }
    if ($warning) {
        $t .= '⚠️ ' . tg_h($warning) . "\n";
    }

    $a = $report['art_text'] ?? [];
    $t .= "\n" . design_review_cat_title('Texto del arte vs cronograma (E)', $a['score'] ?? null);
    $t .= design_review_bullets((array)($a['missing'] ?? []), '❌ Falta:');
    $t .= design_review_bullets((array)($a['extra'] ?? []), '➕ Sobra:');
    $t .= design_review_bullets((array)($a['notes'] ?? []), '•', 2);

    $s = $report['spelling'] ?? [];
    $t .= "\n" . design_review_cat_title('Ortografía en la pieza', $s['score'] ?? null);
    $errs = design_review_errors_list((array)($s['errors'] ?? []));
    $t .= $errs !== '' ? $errs : "✅ Sin errores detectados\n";

    $d = $report['design'] ?? [];
    $t .= "\n" . design_review_cat_title('Diseño', $d['score'] ?? null);
    $t .= design_review_bullets((array)($d['notes'] ?? []), '•', 4);

    $b = $report['brief'] ?? [];
    if (is_numeric($b['score'] ?? null) || !empty($b['notes'])) {
        $t .= "\n" . design_review_cat_title('Indicaciones del diseñador (D)', $b['score'] ?? null);
        $t .= design_review_bullets((array)($b['notes'] ?? []), '•', 3);
    }

    $c = $report['copy'] ?? [];
    if (is_numeric($c['score'] ?? null) || isset($c['has_hook'])) {
        $t .= "\n" . design_review_cat_title('Copy (F)', $c['score'] ?? null);
        $t .= 'Gancho ' . (!empty($c['has_hook']) ? '✅' : '❌') . ' · CTA ' . (!empty($c['has_cta']) ? '✅' : '❌') . "\n";
        $t .= design_review_errors_list((array)($c['spelling_errors'] ?? []), 3);
        $t .= design_review_bullets((array)($c['notes'] ?? []), '•', 2);
    }

    $fix = array_values(array_filter((array)($report['must_fix'] ?? []), 'is_string'));
    if ($fix) {
        $t .= "\n<b>Corregir antes de enviar al cliente</b>\n";
        foreach (array_slice($fix, 0, 5) as $i => $f) {
            $t .= ($i + 1) . '. ' . tg_h(design_review_clip($f)) . "\n";
        }
    }

    // Telegram limita a 4096 caracteres
    if (mb_strlen($t) > 3900) {
        $t = mb_substr($t, 0, 3880) . "…\n(reporte recortado)";
    }
    return $t;
}

function design_review_keyboard(int $reviewId): array
{
    return [[
        ['text' => '✅ Aprobar para cliente', 'callback_data' => "rv:{$reviewId}:approve"],
        ['text' => '✏️ Pedir ajustes', 'callback_data' => "rv:{$reviewId}:adjust"],
    ], [
        ['text' => '💬 Comentar', 'callback_data' => "rv:{$reviewId}:comment"],
    ]];
}

// ---------------------------------------------------------------- Botones CM/PM

function design_review_handle_callback(PDO $pdo, array $cb): void
{
    $cbId = (string)($cb['id'] ?? '');
    if (!preg_match('/^rv:(\d+):(approve|adjust|comment)$/', (string)($cb['data'] ?? ''), $m)) {
        telegram_answer_callback($cbId);
        return;
    }
    $reviewId = (int)$m[1];
    $action = $m[2];
    $from = $cb['from'] ?? [];

    $stmt = $pdo->prepare('SELECT * FROM design_reviews WHERE id = ?');
    $stmt->execute([$reviewId]);
    $review = $stmt->fetch();
    if (!$review) {
        telegram_answer_callback($cbId, 'No encontré esa revisión.', true);
        return;
    }
    $role = design_review_role($pdo, (int)$review['client_id'], $from);
    if ($role === null) {
        telegram_answer_callback($cbId, 'Solo la CM o la PM pueden usar estos botones.', true);
        return;
    }

    $pdo->prepare('INSERT INTO design_review_events (review_id, telegram_user_id, user_name, role, action) VALUES (?, ?, ?, ?, ?)')
        ->execute([$reviewId, (int)$from['id'], design_review_display_name($from), $role, $action]);
    telegram_answer_callback($cbId, 'Registrado ✔');

    $who = '<b>' . tg_h(design_review_display_name($from)) . '</b> (' . strtoupper($role) . ')';
    $designer = design_review_mention((int)$review['from_user_id'], (string)$review['from_name']);
    $post = '#' . (int)$review['post_number'] . ' v' . (int)$review['version'];
    $text = match ($action) {
        'approve' => "✅ {$who} aprobó el Post {$post} para pasar a validación con el cliente.\n(Recuerda mover la tarea en Trello.)",
        'adjust'  => "✏️ {$who} pide ajustes en el Post {$post}.\n{$designer}: respondan a este mensaje con los ajustes y, al corregir, reenvíen la pieza con el mismo #{$review['post_number']}.",
        default   => "💬 {$who} va a dejar un comentario sobre el Post {$post}. Respóndanle a este mensaje.",
    };
    $anchor = (int)($review['report_message_id'] ?: $review['message_id']);
    telegram_send_message((int)$review['chat_id'], $text, $anchor);
}

// ---------------------------------------------------------------- Procesamiento (cron)

// Reclama revisiones listas: con # y sin archivos nuevos hace 25 s (esperar álbumes).
function design_review_claim(PDO $pdo, int $limit): array
{
    // 'collecting' (álbum sin #) que nunca recibió su texto: se ignora en silencio.
    $pdo->exec('UPDATE design_reviews SET status = "ignored" WHERE status = "collecting" AND last_file_at < (NOW() - INTERVAL 90 SECOND)');
    // 'processing' colgado (cron cortado a la mitad): volver a la cola.
    $pdo->exec('UPDATE design_reviews SET status = "pending", claimed_at = NULL WHERE status = "processing" AND claimed_at < (NOW() - INTERVAL 15 MINUTE)');

    $stamp = date('Y-m-d H:i:s');
    $pdo->prepare('
        UPDATE design_reviews SET status = "processing", claimed_at = ?, attempts = attempts + 1
        WHERE status = "pending" AND post_number IS NOT NULL AND last_file_at <= (NOW() - INTERVAL 25 SECOND) AND attempts < ?
        ORDER BY id LIMIT ' . (int)$limit
    )->execute([$stamp, DESIGN_REVIEW_MAX_ATTEMPTS]);

    $stmt = $pdo->prepare('SELECT * FROM design_reviews WHERE status = "processing" AND claimed_at = ? ORDER BY id');
    $stmt->execute([$stamp]);
    return $stmt->fetchAll();
}

function design_review_fail(PDO $pdo, array $review, string $reason, bool $retry): void
{
    $final = !$retry || (int)$review['attempts'] >= DESIGN_REVIEW_MAX_ATTEMPTS;
    $pdo->prepare('UPDATE design_reviews SET status = ?, error = ?, claimed_at = NULL, processed_at = ? WHERE id = ?')
        ->execute([$final ? 'failed' : 'pending', $reason, $final ? date('Y-m-d H:i:s') : null, $review['id']]);
    // Si va a reintentarse, no molestar al grupo; solo avisar cuando es definitivo.
    if ($final) {
        $label = '#' . (int)$review['post_number'] . ' v' . (int)$review['version'];
        $text = '⚠️ No pude revisar el Post ' . $label . ': ' . tg_h($reason);
        if (!empty($review['report_message_id']) && telegram_edit_message((int)$review['chat_id'], (int)$review['report_message_id'], $text)) {
            return;
        }
        telegram_send_message((int)$review['chat_id'], $text, (int)$review['message_id']);
    }
}

function design_review_process(PDO $pdo, array $review): void
{
    $reviewId = (int)$review['id'];
    $chatId = (int)$review['chat_id'];

    $stmt = $pdo->prepare('SELECT name, timezone, sheet_id, ai_context FROM clients WHERE id = ?');
    $stmt->execute([$review['client_id']]);
    $client = $stmt->fetch();
    if (!$client) {
        design_review_fail($pdo, $review, 'La marca ya no existe.', false);
        return;
    }

    // Acuse: un solo mensaje que luego se convierte en el reporte (o en el error).
    $label = '#' . (int)$review['post_number'] . ' v' . (int)$review['version'];
    if (empty($review['report_message_id'])) {
        $ack = telegram_send_message($chatId, "🔎 Revisando el Post {$label}…", (int)$review['message_id']);
        if ($ack && !empty($ack['message_id'])) {
            $review['report_message_id'] = (int)$ack['message_id'];
            $pdo->prepare('UPDATE design_reviews SET report_message_id = ? WHERE id = ?')->execute([$review['report_message_id'], $reviewId]);
        }
    }

    if (empty($client['sheet_id'])) {
        design_review_fail($pdo, $review, 'Esta marca no tiene el cronograma (Google Sheet) vinculado todavía.', false);
        return;
    }

    // --- Mes y pestaña
    $parsed = review_parse_caption((string)$review['caption']);
    try {
        $tz = new DateTimeZone($client['timezone'] ?: 'America/Bogota');
    } catch (Throwable $e) {
        $tz = new DateTimeZone('America/Bogota');
    }
    $now = new DateTimeImmutable('now', $tz);
    $day = $review['pub_day'] !== null ? (int)$review['pub_day'] : null;

    $months = [];
    if ($day !== null) {
        $months[] = review_resolve_month($day, $now);
    }
    foreach ([$now->modify('first day of this month')->setTime(0, 0), $now->modify('first day of next month')->setTime(0, 0)] as $alt) {
        if (!array_filter($months, fn($m) => $m->format('Y-m') === $alt->format('Y-m'))) {
            $months[] = $alt;
        }
    }

    $row = null;
    $pubMonth = null;
    $tabUsed = null;
    $sheetError = null;
    foreach ($months as $month) {
        $tab = google_sheets_find_tab((string)$client['sheet_id'], review_month_name_es((int)$month->format('n')));
        if ($tab === null) {
            $sheetError = google_sheets_last_error();
            continue;
        }
        $values = google_sheets_get_values((string)$client['sheet_id'], google_sheets_quote_tab($tab) . '!A:H');
        if ($values === null) {
            $sheetError = google_sheets_last_error();
            continue;
        }
        $found = review_find_row($values, (int)$review['post_number'], $day);
        if ($found !== null) {
            $row = $found;
            $pubMonth = $month;
            $tabUsed = $tab;
            break;
        }
    }
    if ($row === null) {
        $reason = 'No encontré el Post #' . (int)$review['post_number'] . ' en el cronograma (pestañas probadas: '
            . implode(', ', array_map(fn($m) => review_month_name_es((int)$m->format('n')), $months)) . '). Revisa el número.';
        // Fallo de lectura de Sheets (permisos/red) puede ser transitorio; "no existe" no.
        design_review_fail($pdo, $review, $reason . ($sheetError ? ' (' . $sheetError . ')' : ''), $sheetError !== null);
        return;
    }

    $warning = null;
    if ($day !== null && $row['day'] !== null && $row['day'] !== $day) {
        $warning = "El día indicado ({$day}) no coincide con el cronograma ({$row['day_raw']}). Verifica que sea el post correcto.";
    } elseif (($row['duplicates'] ?? 1) > 1) {
        $warning = 'El #' . (int)$review['post_number'] . ' aparece ' . $row['duplicates'] . ' veces en la pestaña; revisé contra la fila que coincide con el día.';
    }

    // --- Archivos
    $fstmt = $pdo->prepare('SELECT * FROM design_review_files WHERE review_id = ? ORDER BY id');
    $fstmt->execute([$reviewId]);
    $dir = design_review_tmp_dir($reviewId);
    $files = [];
    try {
        foreach ($fstmt->fetchAll() as $i => $f) {
            $dl = telegram_download_file((string)$f['tg_file_id'], $dir, 'f' . $i);
            if (isset($dl['error'])) {
                $msg = $dl['error'] === 'too_big'
                    ? 'Un archivo pesa más de 20 MB y Telegram no me deja descargarlo. Envíalo comprimido (preview) o comparte el enlace de Drive.'
                    : 'No pude descargar el archivo de Telegram.';
                design_review_fail($pdo, $review, $msg, $dl['error'] !== 'too_big');
                return;
            }
            $files[] = ['path' => $dl['path'], 'kind' => (string)$f['kind']];
        }
        if (!$files) {
            design_review_fail($pdo, $review, 'No encontré archivos en el envío.', false);
            return;
        }

        $result = design_review_run($row, (string)$client['name'], $client['ai_context'], $parsed['hint'] !== '' ? $parsed['hint'] : (string)$row['format'], $files);
    } finally {
        tg_rrmdir($dir);
    }

    if (isset($result['error'])) {
        design_review_fail($pdo, $review, (string)$result['error'], (bool)($result['retry'] ?? false));
        return;
    }

    $report = $result['report'];
    $pdo->prepare('UPDATE design_reviews SET status = "done", score = ?, report_json = ?, sheet_tab = ?, error = NULL, claimed_at = NULL, processed_at = NOW() WHERE id = ?')
        ->execute([(int)$report['score'], json_encode($report, JSON_UNESCAPED_UNICODE), $tabUsed, $reviewId]);

    $html = design_review_format_report($review, $row, $report, $pubMonth, $warning);
    $kb = design_review_keyboard($reviewId);
    $sent = false;
    if (!empty($review['report_message_id'])) {
        $sent = telegram_edit_message($chatId, (int)$review['report_message_id'], $html, $kb);
    }
    if (!$sent) {
        $new = telegram_send_message($chatId, $html, (int)$review['message_id'], $kb);
        if ($new && !empty($new['message_id'])) {
            $pdo->prepare('UPDATE design_reviews SET report_message_id = ? WHERE id = ?')->execute([(int)$new['message_id'], $reviewId]);
        }
    }
}
