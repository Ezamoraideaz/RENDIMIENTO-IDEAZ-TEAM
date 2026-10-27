<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/google_sheets.php';
require_once __DIR__ . '/../includes/google_drive.php';
require_once __DIR__ . '/../includes/trello_sync.php';

// Asistente de configuración de cliente (configurar-cliente.html).
// Reúne en un solo endpoint el estado de TODO lo que un cliente necesita para
// que el flujo de trabajo funcione (datos, parrilla, Trello, Drive, Telegram,
// Meta, flujos, pauta) y las verificaciones en vivo contra Google/Telegram.
// Las escrituras de campos simples reutilizan clients.php / project_settings.php;
// aquí solo viven las que no tenían endpoint (reglas de Telegram, pauta).
//
//   GET  ?client_id=N                    → checklist estático (rápido, solo BD)
//   GET  ?client_id=N&check=KEY          → verificación en vivo (sheet | approval_folder | artes_folder)
//   POST {action:'create_client', name}                       → crea el cliente (mismo criterio que clients.php)
//   POST {action:'save_fields', client_id, sheet_id?, drive_approval_folder_id?, trello_board_id?, artes_folder_id?, ai_context?}
//   POST {action:'save_roles', client_id, cm:[..], pm:[..]}   → reglas CM/PM de Telegram para esta marca
//   POST {action:'save_pauta', client_id, pauta_id?, platforms:{meta,google,tiktok}} → solo superadmin/admin

$operator = require_client_setup_access();
$pdo = db();
// Cuenta publicitaria y datos del proyecto (presupuesto/ingreso): admin y PM (agenda_full), no el CM.
$canManage = in_array($operator['role'], ['superadmin', 'admin', 'agenda_full'], true);

// Listas que el protocolo de Trello exige (js/timeCalc.js las reconoce por nombre).
const SETUP_TRELLO_REQUIRED = ['Tareas', 'En Proceso', 'Enviado', 'Cambios', 'Aprobado'];
const SETUP_TRELLO_RECOMMENDED = ['Montado en Drive', 'Publicado'];
const SETUP_TRELLO_PATTERNS = [
    'Tareas'           => '/^tareas?$|lista.*tarea|tarea|backlog|pendiente|to.?do|por\s*hacer/i',
    'En Proceso'       => '/en\s*proceso|in\s*progress|trabajando|en\s*curso/i',
    'Enviado'          => '/^enviado$|al\s*cliente|sent|esperando\s*cliente|en\s*revisi[oó]n/iu',
    'Cambios'          => '/^cambios?$|feedback|correcciones|ajustes|del\s*cliente/i',
    'Aprobado'         => '/^aprobado$|aprobado|finalizado|done|completado|terminado|entregado|listo/i',
    'Montado en Drive' => '/drive|montado/i',
    'Publicado'        => '/^publicado$|publicado|published|posted|ejecutado/i',
];

function setup_item(string $key, string $label, string $status, string $detail = '', bool $required = true): array
{
    // status: ok | missing | warn
    return ['key' => $key, 'label' => $label, 'status' => $status, 'detail' => $detail, 'required' => $required];
}

function setup_service_email(): ?string
{
    $raw = google_service_account_json();
    $data = $raw ? json_decode($raw, true) : null;
    return is_array($data) ? ($data['client_email'] ?? null) : null;
}

// Acepta el ID pelado o la URL completa de Sheets/Drive.
function setup_extract_id(string $value, string $kind): string
{
    $value = trim($value);
    $pattern = $kind === 'sheet' ? '#/spreadsheets/d/([a-zA-Z0-9_-]+)#' : '#/folders/([a-zA-Z0-9_-]+)#';
    if (preg_match($pattern, $value, $m)) {
        return $m[1];
    }
    return $value;
}

function setup_load_client(PDO $pdo, int $clientId): array
{
    $stmt = $pdo->prepare('SELECT * FROM clients WHERE id = ?');
    $stmt->execute([$clientId]);
    $client = $stmt->fetch();
    if (!$client) {
        json_error('Cliente no encontrado', 404);
    }
    return $client;
}

function setup_artes_folder(PDO $pdo, ?string $boardId): string
{
    if (!$boardId) {
        return '';
    }
    $stmt = $pdo->prepare('SELECT drive_folder_id FROM project_settings WHERE board_id = ?');
    $stmt->execute([$boardId]);
    return trim((string)($stmt->fetchColumn() ?: ''));
}

// Listas abiertas del tablero y cuáles de las del protocolo faltan (null si Trello no responde).
function setup_trello_lists(PDO $pdo, string $boardId): ?array
{
    $creds = trello_sync_credentials($pdo);
    if ($creds === null) {
        return null;
    }
    try {
        $lists = trello_sync_request('GET', '/boards/' . rawurlencode($boardId) . '/lists', $creds, ['filter' => 'open']);
    } catch (RuntimeException $e) {
        return null;
    }
    $names = array_map(fn($l) => (string)($l['name'] ?? ''), $lists);
    $missing = [];
    foreach (array_merge(SETUP_TRELLO_REQUIRED, SETUP_TRELLO_RECOMMENDED) as $wanted) {
        $found = array_filter($names, fn($n) => preg_match(SETUP_TRELLO_PATTERNS[$wanted], trim($n)) === 1);
        if (!$found) {
            $missing[] = $wanted;
        }
    }
    return ['names' => $names, 'missing' => $missing, 'creds' => $creds];
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET' && isset($_GET['list'])) {
    $rows = $pdo->query('SELECT id, name, slug, logo_url, status FROM clients ORDER BY name ASC')->fetchAll();
    json_response(['clients' => $rows]);
}

if ($method === 'GET') {
    $clientId = (int)($_GET['client_id'] ?? 0);
    if ($clientId <= 0) {
        json_error('client_id requerido', 400);
    }
    $client = setup_load_client($pdo, $clientId);
    $check = (string)($_GET['check'] ?? '');

    // ---- Verificaciones en vivo (consultan Google; por eso van aparte del checklist)
    if ($check !== '') {
        $service = setup_service_email();
        $shareHint = $service ? " Compártelo con {$service}." : '';
        if ($check === 'sheet') {
            if (!$client['sheet_id']) {
                json_response(['ok' => false, 'message' => 'Aún no hay Google Sheet guardado.']);
            }
            $monthNames = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
            $month = $monthNames[(int)date('n') - 1];
            $tab = google_sheets_find_tab($client['sheet_id'], $month);
            if ($tab === null) {
                $err = (string)google_sheets_last_error();
                $noTab = str_contains($err, 'Ninguna pestaña');
                json_response(['ok' => false, 'message' => $noTab
                    ? "El Sheet se puede leer, pero no tiene una pestaña del mes ({$month}). Crea una pestaña por mes con el nombre del mes."
                    : "No se puede leer el Sheet.{$shareHint}", 'detail' => $err, 'partial' => $noTab]);
            }
            json_response(['ok' => true, 'message' => "Sheet legible — pestaña del mes: «{$tab}»."]);
        }
        if ($check === 'approval_folder' || $check === 'artes_folder') {
            $folderId = $check === 'approval_folder'
                ? trim((string)$client['drive_approval_folder_id'])
                : setup_artes_folder($pdo, $client['trello_board_id']);
            if ($folderId === '') {
                json_response(['ok' => false, 'message' => 'Aún no hay carpeta guardada.']);
            }
            // Mover contenido exige Editor: se verifica con canEdit, no solo lectura.
            $data = google_drive_request('GET', 'https://www.googleapis.com/drive/v3/files/' . rawurlencode($folderId) . '?fields=' . rawurlencode('name,mimeType,capabilities(canEdit)') . '&supportsAllDrives=true');
            if ($data === null) {
                json_response(['ok' => false, 'message' => "No se puede abrir la carpeta.{$shareHint} Debe ser como Editor.", 'detail' => (string)google_drive_last_error()]);
            }
            if (($data['mimeType'] ?? '') !== 'application/vnd.google-apps.folder') {
                json_response(['ok' => false, 'message' => 'Ese ID no es una carpeta (¿pegaste el de un archivo?).']);
            }
            if (empty($data['capabilities']['canEdit'])) {
                json_response(['ok' => false, 'message' => "La carpeta se puede ver pero no editar.{$shareHint} Cambia el permiso a Editor.", 'partial' => true]);
            }
            json_response(['ok' => true, 'message' => 'Carpeta «' . ($data['name'] ?? '') . '» accesible con permiso de Editor.']);
        }
        if ($check === 'trello_lists' || $check === 'trello_members') {
            if (!$client['trello_board_id']) {
                json_response(['ok' => false, 'message' => 'Aún no hay tablero de Trello vinculado.']);
            }
            $info = setup_trello_lists($pdo, (string)$client['trello_board_id']);
            if ($info === null) {
                json_response(['ok' => false, 'message' => 'No se pudo leer el tablero en Trello — revisa las credenciales en Configuración y que el tablero exista.']);
            }
            if ($check === 'trello_lists') {
                $req = array_values(array_intersect($info['missing'], SETUP_TRELLO_REQUIRED));
                $rec = array_values(array_intersect($info['missing'], SETUP_TRELLO_RECOMMENDED));
                if ($req) {
                    json_response(['ok' => false, 'can_create' => true,
                        'message' => 'Faltan listas del protocolo: ' . implode(', ', $req) . '. Sin ellas no se calculan horas ni funciona la tanda automática.']);
                }
                json_response(['ok' => true, 'can_create' => (bool)$rec,
                    'message' => 'Listas del protocolo completas.' . ($rec ? ' (Recomendadas que faltan: ' . implode(', ', $rec) . '.)' : '')]);
            }
            // trello_members: miembros del tablero sin tarifa por hora → el costo por tarjeta queda en $0.
            try {
                $members = trello_sync_request('GET', '/boards/' . rawurlencode((string)$client['trello_board_id']) . '/members', $info['creds'], ['fields' => 'id,fullName,username']);
            } catch (RuntimeException $e) {
                json_response(['ok' => false, 'message' => 'No se pudieron leer los miembros del tablero.']);
            }
            if (!$members) {
                json_response(['ok' => false, 'message' => 'El tablero no tiene miembros.']);
            }
            $rates = $pdo->query('SELECT member_id, hourly_rate FROM member_settings')->fetchAll(PDO::FETCH_KEY_PAIR);
            $noRate = [];
            foreach ($members as $m) {
                if ((float)($rates[$m['id']] ?? 0) <= 0) {
                    $noRate[] = $m['fullName'] ?: $m['username'];
                }
            }
            json_response($noRate
                ? ['ok' => false, 'message' => 'Sin tarifa por hora (su costo sale en $0): ' . implode(', ', $noRate) . '. Se ajusta en Configuración → Miembros.']
                : ['ok' => true, 'message' => count($members) . ' miembro(s), todos con tarifa.']);
        }
        json_error('Verificación desconocida', 400);
    }

    // ---- Checklist estático
    $cid = (int)$client['id'];
    $items = [];

    // 1 · Datos básicos
    $items[] = setup_item('logo', 'Logo de la marca', $client['logo_url'] ? 'ok' : 'missing', $client['logo_url'] ? '' : 'Se muestra en los portales del cliente (aprobaciones, leads, brief).');
    $items[] = setup_item('ai_context', 'Contexto de la marca para la IA', trim((string)$client['ai_context']) !== '' ? 'ok' : 'warn', 'Servicios, horarios, precios y lo que NO se hace. Lo usa el bot para responder.', false);

    // 2 · Parrilla
    $items[] = setup_item('sheet', 'Google Sheet del cronograma', $client['sheet_id'] ? 'ok' : 'missing', (string)($client['sheet_id'] ?? ''));

    // 3 · Trello
    $items[] = setup_item('trello', 'Tablero de Trello', $client['trello_board_id'] ? 'ok' : 'missing', (string)($client['trello_board_id'] ?? ''));
    // 'live' = no se da por listo hasta que la verificación en vivo pase.
    $items[] = ['live' => true] + setup_item('trello_lists', 'Listas del protocolo en el tablero', $client['trello_board_id'] ? 'warn' : 'missing', $client['trello_board_id'] ? 'Verificando…' : 'Primero vincula el tablero.');
    $items[] = ['live' => true] + setup_item('trello_members', 'Miembros del tablero con tarifa por hora', $client['trello_board_id'] ? 'warn' : 'missing', $client['trello_board_id'] ? 'Verificando…' : 'Primero vincula el tablero.', false);

    // Proyecto en el dashboard (project_settings): sin esto la marca no aparece con costos/rentabilidad.
    $project = null;
    if ($client['trello_board_id']) {
        $ps = $pdo->prepare('SELECT * FROM project_settings WHERE board_id = ?');
        $ps->execute([$client['trello_board_id']]);
        $project = $ps->fetch() ?: null;
    }
    $projMissing = [];
    if (!$project || $project['project_type'] !== 'retencion') { $projMissing[] = 'tipo «Retención mensual»'; }
    if (!$project || (float)$project['budget'] <= 0) { $projMissing[] = 'presupuesto'; }
    if (!$project || (float)$project['revenue'] <= 0) { $projMissing[] = 'ingreso'; }
    if (!$project || (float)$project['hours_estimated'] <= 0) { $projMissing[] = 'horas estimadas'; }
    $items[] = setup_item('project', 'Datos del proyecto (tipo, presupuesto, ingreso, horas)', !$client['trello_board_id'] ? 'missing' : ($projMissing ? 'warn' : 'ok'),
        !$client['trello_board_id'] ? 'Primero vincula el tablero.' : ($projMissing ? 'Falta: ' . implode(', ', $projMissing) : ''));

    // 4 · Drive
    $items[] = setup_item('approval_folder', 'Carpeta Drive «Para aprobación»', $client['drive_approval_folder_id'] ? 'ok' : 'missing', (string)($client['drive_approval_folder_id'] ?? ''));
    $artes = setup_artes_folder($pdo, $client['trello_board_id']);
    $items[] = setup_item('artes_folder', 'Carpeta Drive ARTES del tablero', $artes !== '' ? 'ok' : 'missing', $client['trello_board_id'] ? $artes : 'Primero vincula el tablero de Trello.');

    // 5 · Telegram
    $stmt = $pdo->prepare('SELECT title, chat_id FROM telegram_groups WHERE client_id = ? LIMIT 1');
    $stmt->execute([$cid]);
    $group = $stmt->fetch();
    $tgDone = $group || !empty($client['telegram_setup_done']);
    $items[] = setup_item('telegram_group', 'Grupo de Telegram vinculado al revisor', $tgDone ? 'ok' : 'missing',
        $group ? (string)($group['title'] ?: $group['chat_id']) : ($tgDone ? 'Marcado como configurado por el equipo.' : 'Agrega el bot como administrador y escribe /vincular ' . $client['slug']));
    $stmt = $pdo->prepare('SELECT role, match_text, client_id FROM telegram_role_rules WHERE client_id IS NULL OR client_id = ? ORDER BY role, match_text');
    $stmt->execute([$cid]);
    $rules = $stmt->fetchAll();
    $hasCm = (bool)array_filter($rules, fn($r) => $r['role'] === 'cm');
    $hasPm = (bool)array_filter($rules, fn($r) => $r['role'] === 'pm');
    $items[] = setup_item('telegram_roles', 'CM y PM reconocidos en Telegram', ($hasCm && $hasPm) ? 'ok' : 'missing',
        $hasCm && $hasPm ? '' : 'Sin esto el bot trata al CM/PM como diseñador y les genera revisiones.');

    // 6 · Meta (Atención al Cliente)
    $stmt = $pdo->prepare('SELECT platform, page_name, ig_username, status FROM social_accounts WHERE client_id = ? AND status <> "revoked"');
    $stmt->execute([$cid]);
    $accounts = $stmt->fetchAll();
    $fb = current(array_filter($accounts, fn($a) => $a['platform'] === 'facebook_page')) ?: null;
    $ig = current(array_filter($accounts, fn($a) => $a['platform'] === 'instagram_business')) ?: null;
    $items[] = setup_item('meta_facebook', 'Página de Facebook conectada', !$fb ? 'missing' : ($fb['status'] === 'active' ? 'ok' : 'warn'),
        !$fb ? '' : ($fb['status'] === 'active' ? (string)$fb['page_name'] : 'El token venció: reconecta la cuenta.'));
    $items[] = setup_item('meta_instagram', 'Instagram Business conectado', !$ig ? 'missing' : ($ig['status'] === 'active' ? 'ok' : 'warn'),
        !$ig ? 'Se conecta junto con la Página (debe estar vinculada a la cuenta de Instagram).' : ($ig['status'] === 'active' ? '@' . $ig['ig_username'] : 'El token venció: reconecta la cuenta.'), false);

    // 7 · Flujos
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM flows WHERE client_id = ? AND status = "active"');
    $stmt->execute([$cid]);
    $activeFlows = (int)$stmt->fetchColumn();
    $items[] = setup_item('flows', 'Al menos un flujo activo', $activeFlows > 0 ? 'ok' : 'warn', $activeFlows > 0 ? "{$activeFlows} activo(s)" : 'Sin flujos activos el bot no responde nada.', false);

    // 8 · Leads
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM organic_lead_notify_emails WHERE client_id = ?');
    $stmt->execute([$cid]);
    $notify = (int)$stmt->fetchColumn();
    $items[] = setup_item('lead_emails', 'Correos que reciben los leads', $notify > 0 ? 'ok' : 'warn', $notify > 0 ? "{$notify} correo(s)" : 'Quién recibe el aviso cuando entra un lead.', false);

    $stmt = $pdo->prepare('SELECT COUNT(*) FROM organic_lead_share_links WHERE client_id = ?');
    $stmt->execute([$cid]);
    $items[] = setup_item('lead_portal', 'Portal de leads para el cliente (link)', (int)$stmt->fetchColumn() > 0 ? 'ok' : 'warn', 'Link para que el cliente vea sus leads. Se genera en Atención al Cliente → Leads.', false);
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM client_briefs WHERE client_id = ? AND (token_hash IS NOT NULL OR status = "filled")');
    $stmt->execute([$cid]);
    $items[] = setup_item('brief', 'Brief enviado al cliente', (int)$stmt->fetchColumn() > 0 ? 'ok' : 'warn', 'Sitio web, marketing digital o branding. Se envía en Atención al Cliente → Briefs.', false);

    // 9 · Pauta
    $stmt = $pdo->prepare('SELECT id, name, platforms FROM pauta_clients WHERE organic_client_id = ? LIMIT 1');
    $stmt->execute([$cid]);
    $pauta = $stmt->fetch();
    $pautaPlatforms = $pauta ? (json_decode($pauta['platforms'], true) ?: []) : [];
    $withAccount = array_filter($pautaPlatforms, fn($p) => !empty($p['enabled']) && trim((string)($p['account_id'] ?? $p['customer_id'] ?? $p['advertiser_id'] ?? '')) !== '');
    $items[] = setup_item('pauta', 'Cliente en Pauta con cuenta publicitaria', $withAccount ? 'ok' : ($pauta ? 'warn' : 'missing'),
        $withAccount ? ('Cuentas: ' . count($withAccount)) : ($pauta ? 'Vinculado, pero sin cuenta publicitaria activa.' : 'Sin esto no se lee la inversión ni se genera el reporte de pauta.'), false);

    $total = count(array_filter($items, fn($i) => $i['required']));
    $done = count(array_filter($items, fn($i) => $i['required'] && $i['status'] === 'ok'));

    json_response([
        'client'        => $client,
        'items'         => $items,
        'progress'      => ['required_total' => $total, 'required_done' => $done],
        'service_email' => setup_service_email(),
        'roles'         => [
            'cm' => array_values(array_map(fn($r) => $r['match_text'], array_filter($rules, fn($r) => $r['role'] === 'cm' && $r['client_id'] !== null))),
            'pm' => array_values(array_map(fn($r) => $r['match_text'], array_filter($rules, fn($r) => $r['role'] === 'pm' && $r['client_id'] !== null))),
            'global_cm' => array_values(array_map(fn($r) => $r['match_text'], array_filter($rules, fn($r) => $r['role'] === 'cm' && $r['client_id'] === null))),
            'global_pm' => array_values(array_map(fn($r) => $r['match_text'], array_filter($rules, fn($r) => $r['role'] === 'pm' && $r['client_id'] === null))),
        ],
        'pauta'         => $pauta ? ['id' => $pauta['id'], 'name' => $pauta['name'], 'platforms' => $pautaPlatforms] : null,
        'telegram_group_linked' => (bool)$group,
        'can_edit_pauta' => $canManage,
        'can_edit_project' => $canManage,
        'project'       => $project ? [
            'alias' => $project['alias'], 'project_type' => $project['project_type'], 'budget' => (float)$project['budget'],
            'revenue' => (float)$project['revenue'], 'hours_estimated' => (float)$project['hours_estimated'], 'currency' => $project['currency'],
        ] : null,
        'artes_folder_id' => $artes,
    ]);
}

if ($method !== 'POST') {
    json_error('Método no permitido', 405);
}

require_state_changing_request();
$input = json_body();
$action = (string)($input['action'] ?? '');

if ($action === 'create_client') {
    $name = trim((string)($input['name'] ?? ''));
    if ($name === '') {
        json_error('El nombre del cliente es requerido', 400);
    }
    $slug = trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($name)) ?? '', '-') ?: bin2hex(random_bytes(4));
    $stmt = $pdo->prepare('INSERT INTO clients (name, slug, timezone) VALUES (?, ?, ?)');
    try {
        $stmt->execute([$name, $slug, 'America/Bogota']);
    } catch (PDOException $e) {
        if ($e->getCode() !== '23000') {
            throw $e;
        }
        $slug .= '-' . bin2hex(random_bytes(2));
        $stmt->execute([$name, $slug, 'America/Bogota']);
    }
    json_response(['id' => (int)$pdo->lastInsertId(), 'name' => $name, 'slug' => $slug], 201);
}

$clientId = (int)($input['client_id'] ?? 0);
if ($clientId <= 0) {
    json_error('client_id requerido', 400);
}
$client = setup_load_client($pdo, $clientId);

if ($action === 'save_fields') {
    // IDs de Sheet/Drive: se normalizan (acepta URL completa) y se guardan en clients.
    $sets = [];
    $vals = [];
    foreach (['sheet_id' => 'sheet', 'drive_approval_folder_id' => 'folder'] as $field => $kind) {
        if (array_key_exists($field, $input)) {
            $sets[] = "{$field} = ?";
            $vals[] = setup_extract_id((string)$input[$field], $kind) ?: null;
        }
    }
    if (array_key_exists('timezone', $input) && trim((string)$input['timezone']) !== '') {
        $sets[] = 'timezone = ?';
        $vals[] = trim((string)$input['timezone']);
    }
    if (array_key_exists('ai_context', $input)) {
        $sets[] = 'ai_context = ?';
        $vals[] = (string)$input['ai_context'];
    }
    if (array_key_exists('trello_board_id', $input)) {
        $sets[] = 'trello_board_id = ?';
        $vals[] = trim((string)$input['trello_board_id']) ?: null;
    }
    if (array_key_exists('telegram_setup_done', $input)) {
        $sets[] = 'telegram_setup_done = ?';
        $vals[] = !empty($input['telegram_setup_done']) ? 1 : 0;
    }
    if (!$sets) {
        json_error('Nada para actualizar', 400);
    }
    $vals[] = $clientId;
    $pdo->prepare('UPDATE clients SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($vals);

    // Carpeta ARTES: vive por tablero en project_settings.
    if (array_key_exists('artes_folder_id', $input)) {
        $boardId = (string)(array_key_exists('trello_board_id', $input) ? $input['trello_board_id'] : $client['trello_board_id']);
        if ($boardId === '') {
            json_error('Primero vincula el tablero de Trello', 400);
        }
        $pdo->prepare('INSERT INTO project_settings (board_id, drive_folder_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE drive_folder_id = VALUES(drive_folder_id)')
            ->execute([$boardId, setup_extract_id((string)$input['artes_folder_id'], 'folder')]);
    }
    json_response(['ok' => true]);
}

if ($action === 'save_roles') {
    // Reemplaza las reglas propias de esta marca (las globales no se tocan).
    $clean = function ($list): array {
        $out = [];
        foreach ((array)$list as $t) {
            $t = trim((string)$t);
            if ($t !== '' && mb_strlen($t) <= 100) {
                $out[mb_strtolower($t)] = $t;
            }
        }
        return array_values($out);
    };
    $pdo->beginTransaction();
    $pdo->prepare('DELETE FROM telegram_role_rules WHERE client_id = ?')->execute([$clientId]);
    $ins = $pdo->prepare('INSERT INTO telegram_role_rules (role, match_text, client_id) VALUES (?, ?, ?)');
    foreach (['cm', 'pm'] as $role) {
        foreach ($clean($input[$role] ?? []) as $text) {
            $ins->execute([$role, $text, $clientId]);
        }
    }
    $pdo->commit();
    json_response(['ok' => true]);
}

if ($action === 'save_pauta') {
    if (!$canManage) {
        json_error('No autorizado para configurar la cuenta publicitaria', 403);
    }
    $stmt = $pdo->prepare('SELECT id, budgets, platforms FROM pauta_clients WHERE organic_client_id = ? LIMIT 1');
    $stmt->execute([$clientId]);
    $row = $stmt->fetch();
    $existingPlatforms = $row ? (json_decode($row['platforms'], true) ?: []) : [];

    $incoming = (array)($input['platforms'] ?? []);
    $platforms = [];
    foreach (['meta' => 'account_id', 'google' => 'customer_id', 'tiktok' => 'advertiser_id'] as $key => $idField) {
        $prev = current(array_filter($existingPlatforms, fn($p) => ($p['platform'] ?? '') === $key)) ?: [];
        $account = trim((string)($incoming[$key] ?? ''));
        $platforms[] = [
            'platform' => $key,
            'enabled'  => $account !== '',
            $idField   => $account,
            'budgets'  => $prev['budgets'] ?? (object)[],
        ];
    }
    $json = json_encode($platforms, JSON_UNESCAPED_UNICODE);
    if ($row) {
        $pdo->prepare('UPDATE pauta_clients SET platforms = ? WHERE id = ?')->execute([$json, $row['id']]);
        $id = $row['id'];
    } else {
        $id = 'c' . bin2hex(random_bytes(6));
        $pdo->prepare('INSERT INTO pauta_clients (id, name, budgets, platforms, organic_client_id) VALUES (?, ?, ?, ?, ?)')
            ->execute([$id, $client['name'], '{}', $json, $clientId]);
    }
    json_response(['ok' => true, 'pauta_id' => $id]);
}

if ($action === 'create_trello_lists') {
    if (!$client['trello_board_id']) {
        json_error('Primero vincula el tablero de Trello', 400);
    }
    $info = setup_trello_lists($pdo, (string)$client['trello_board_id']);
    if ($info === null) {
        json_error('No se pudo leer el tablero en Trello', 502);
    }
    $created = [];
    try {
        foreach ($info['missing'] as $name) {
            trello_sync_request('POST', '/lists', $info['creds'], ['name' => $name, 'idBoard' => $client['trello_board_id'], 'pos' => 'bottom']);
            $created[] = $name;
        }
    } catch (RuntimeException $e) {
        json_error('Trello rechazó la creación: ' . $e->getMessage(), 502);
    }
    json_response(['ok' => true, 'created' => $created]);
}

if ($action === 'save_project') {
    if (!$canManage) {
        json_error('No autorizado para modificar los datos del proyecto', 403);
    }
    if (!$client['trello_board_id']) {
        json_error('Primero vincula el tablero de Trello', 400);
    }
    $type = in_array($input['project_type'] ?? '', ['retencion', 'unico'], true) ? $input['project_type'] : 'retencion';
    $pdo->prepare('INSERT INTO project_settings (board_id, alias, project_type, budget, revenue, hours_estimated, currency)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE alias = VALUES(alias), project_type = VALUES(project_type), budget = VALUES(budget),
                       revenue = VALUES(revenue), hours_estimated = VALUES(hours_estimated), currency = VALUES(currency)')
        ->execute([
            $client['trello_board_id'],
            trim((string)($input['alias'] ?? '')),
            $type,
            max(0, (float)($input['budget'] ?? 0)),
            max(0, (float)($input['revenue'] ?? 0)),
            max(0, (float)($input['hours_estimated'] ?? 0)),
            trim((string)($input['currency'] ?? '')) ?: 'COP',
        ]);
    json_response(['ok' => true]);
}

json_error('Acción desconocida', 400);
