<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/google_sheets.php';
require_once __DIR__ . '/../includes/google_drive.php';
require_once __DIR__ . '/../includes/trello_sync.php';
require_once __DIR__ . '/../includes/telegram_api.php';

// Asistente "Configurar cliente" (configurar-cliente.html).
// Reúne en un solo endpoint el estado de TODO lo que una marca de retención
// necesita para que el flujo de trabajo funcione (datos, Trello, proyecto,
// parrilla, Drive, Telegram, Meta, flujos/leads, pauta), las verificaciones en
// vivo contra Google/Trello/Telegram y las escrituras de cada paso.
//
//   GET  ?list=1                        → clientes para el selector
//   GET  ?overview=1                    → avance de todas las marcas (solo checklist en BD)
//   GET  ?client_id=N                   → checklist de una marca (rápido, solo BD)
//   GET  ?client_id=N&check=KEY         → verificación en vivo:
//                                         sheet | approval_folder | artes_folder | trello_lists | trello_members | telegram
//   POST {action:'create_client', name}
//   POST {action:'save_fields', client_id, sheet_id?, drive_approval_folder_id?, artes_folder_id?, trello_board_id?, ai_context?, telegram_setup_done?}
//   POST {action:'save_roles', client_id, cm:[..], pm:[..]}      → reglas CM/PM de Telegram propias de la marca
//   POST {action:'save_lead_emails', client_id, emails:[..]}      → reemplaza los correos que reciben los leads
//   POST {action:'create_trello_lists', client_id}                → crea en el tablero las listas del protocolo que falten
//   POST {action:'save_project', client_id, ...}                  → project_settings del tablero (superadmin/admin/agenda_full)
//   POST {action:'save_pauta', client_id, pauta_id?, platforms}   → vincula o crea el cliente de Pauta (superadmin/admin/agenda_full)
//   GET  ?client_id=N&impact=1                                    → qué registros se borrarían al eliminar la marca
//   POST {action:'set_status', client_id, status:'active'|'archived'} → archivar / reactivar (superadmin/admin/agenda_full)
//   POST {action:'delete_client', client_id, confirm_name, delete_pauta?} → eliminar la marca (solo superadmin/admin)

$operator = require_client_setup_access();
$pdo = db();
// Cuenta publicitaria y datos del proyecto (presupuesto/ingreso): admin y PM (agenda_full), no el CM.
$canManage = in_array($operator['role'], ['superadmin', 'admin', 'agenda_full'], true);

// Listas que el protocolo de Trello exige (js/timeCalc.js las reconoce por nombre, mismos patrones).
const SETUP_TRELLO_REQUIRED = ['Tareas', 'En Proceso', 'Enviado', 'Cambios', 'Aprobado'];
const SETUP_TRELLO_RECOMMENDED = ['Montado en Drive', 'Publicado'];
const SETUP_TRELLO_PATTERNS = [
    'Tareas'           => '/^tareas?$|lista.*tarea|tarea|backlog|pendiente|to.?do|por\s*hacer/iu',
    'En Proceso'       => '/en\s*proceso|in\s*progress|trabajando|en\s*curso/iu',
    'Enviado'          => '/^enviado$|al\s*cliente|sent|esperando\s*cliente|en\s*revisi[oó]n/iu',
    'Cambios'          => '/^cambios?$|feedback|correcciones|ajustes|del\s*cliente/iu',
    'Aprobado'         => '/^aprobado$|aprobado|finalizado|done|completado|terminado|entregado|listo/iu',
    'Montado en Drive' => '/drive|montado/iu',
    'Publicado'        => '/^publicado$|publicado|published|posted|ejecutado/iu',
];
const SETUP_MONTHS = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

function setup_item(string $key, string $label, string $status, string $detail = '', bool $required = true, bool $live = false): array
{
    // status: ok | missing | warn. live = solo cuenta como listo cuando la verificación en vivo pasa.
    return ['key' => $key, 'label' => $label, 'status' => $status, 'detail' => $detail, 'required' => $required, 'live' => $live];
}

function setup_service_email(): ?string
{
    $raw = google_service_account_json();
    $data = $raw ? json_decode($raw, true) : null;
    return is_array($data) ? ($data['client_email'] ?? null) : null;
}

function setup_slug(string $name): string
{
    $slug = strtolower(trim($name));
    $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
    return trim($slug, '-');
}

// Acepta el ID pelado o la URL completa de Sheets/Drive. Devuelve '' si viene vacío
// y lanza un 400 si lo pegado no parece ni URL ni ID (evita guardar basura).
function setup_extract_id(string $value, string $kind): string
{
    $value = trim($value);
    if ($value === '') {
        return '';
    }
    $patterns = $kind === 'sheet'
        ? ['#/spreadsheets/d/([a-zA-Z0-9_-]+)#']
        : ['#/folders/([a-zA-Z0-9_-]+)#', '#[?&]id=([a-zA-Z0-9_-]+)#'];
    foreach ($patterns as $p) {
        if (preg_match($p, $value, $m)) {
            return $m[1];
        }
    }
    if (preg_match('/^[a-zA-Z0-9_-]{15,}$/', $value)) {
        return $value;
    }
    if ($kind === 'sheet' && str_contains($value, '/folders/')) {
        json_error('Pegaste el link de una carpeta de Drive; aquí va el link del Google Sheet.', 400);
    }
    if ($kind !== 'sheet' && str_contains($value, '/spreadsheets/')) {
        json_error('Pegaste el link de un Google Sheet; aquí va el link de una carpeta de Drive.', 400);
    }
    json_error('Eso no parece un link ni un ID válido de Google ' . ($kind === 'sheet' ? 'Sheets' : 'Drive') . '.', 400);
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

function setup_project(PDO $pdo, ?string $boardId): ?array
{
    if (!$boardId) {
        return null;
    }
    $stmt = $pdo->prepare('SELECT * FROM project_settings WHERE board_id = ?');
    $stmt->execute([$boardId]);
    return $stmt->fetch() ?: null;
}

// Listas abiertas del tablero y cuáles del protocolo faltan (null si Trello no responde).
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
    $names = array_map(fn($l) => trim((string)($l['name'] ?? '')), $lists);
    $missing = [];
    foreach (array_merge(SETUP_TRELLO_REQUIRED, SETUP_TRELLO_RECOMMENDED) as $wanted) {
        if (!array_filter($names, fn($n) => preg_match(SETUP_TRELLO_PATTERNS[$wanted], $n) === 1)) {
            $missing[] = $wanted;
        }
    }
    return ['names' => $names, 'missing' => $missing, 'creds' => $creds];
}

// Checklist de una marca, solo con lo que hay en BD (sin llamadas externas).
function setup_checklist(PDO $pdo, array $client): array
{
    $cid = (int)$client['id'];
    $board = $client['trello_board_id'] ?: null;
    $count = function (string $sql) use ($pdo, $cid): int {
        $stmt = $pdo->prepare($sql);
        $stmt->execute([$cid]);
        return (int)$stmt->fetchColumn();
    };
    $items = [];

    // Datos de la marca
    $items[] = setup_item('logo', 'Logo de la marca', $client['logo_url'] ? 'ok' : 'missing', $client['logo_url'] ? '' : 'Se muestra en los portales del cliente (aprobaciones, leads, brief).');
    $items[] = setup_item('ai_context', 'Contexto de la marca para la IA', trim((string)$client['ai_context']) !== '' ? 'ok' : 'warn', 'Servicios, horarios, precios y lo que NO se hace. Lo usa el bot para responder.', false);

    // Trello
    $items[] = setup_item('trello', 'Tablero de Trello', $board ? 'ok' : 'missing', '');
    $items[] = setup_item('trello_lists', 'Listas del protocolo en el tablero', $board ? 'warn' : 'missing', $board ? 'Sin verificar' : 'Primero vincula el tablero.', true, true);
    $items[] = setup_item('trello_members', 'Miembros del tablero con tarifa por hora', $board ? 'warn' : 'missing', $board ? 'Sin verificar' : 'Primero vincula el tablero.', false, true);

    // Proyecto en el dashboard: sin esto la marca no aparece con costos/rentabilidad.
    $project = setup_project($pdo, $board);
    $projMissing = [];
    if (!$project || $project['project_type'] !== 'retencion') { $projMissing[] = 'tipo «Retención mensual»'; }
    if (!$project || (float)$project['budget'] <= 0) { $projMissing[] = 'presupuesto'; }
    if (!$project || (float)$project['revenue'] <= 0) { $projMissing[] = 'ingreso'; }
    if (!$project || (float)$project['hours_estimated'] <= 0) { $projMissing[] = 'horas estimadas'; }
    $items[] = setup_item('project', 'Datos del proyecto (tipo, presupuesto, ingreso, horas)', !$board ? 'missing' : ($projMissing ? 'warn' : 'ok'),
        !$board ? 'Primero vincula el tablero.' : ($projMissing ? 'Falta: ' . implode(', ', $projMissing) : ''));

    // Parrilla
    $items[] = setup_item('sheet', 'Google Sheet del cronograma', $client['sheet_id'] ? 'ok' : 'missing', '');

    // Drive
    $artes = trim((string)($project['drive_folder_id'] ?? ''));
    $items[] = setup_item('approval_folder', 'Carpeta Drive «Para aprobación»', $client['drive_approval_folder_id'] ? 'ok' : 'missing', '');
    $items[] = setup_item('artes_folder', 'Carpeta Drive ARTES del tablero', $artes !== '' ? 'ok' : 'missing', $board ? '' : 'Primero vincula el tablero de Trello.');

    // Telegram
    $stmt = $pdo->prepare('SELECT title, chat_id FROM telegram_groups WHERE client_id = ? LIMIT 1');
    $stmt->execute([$cid]);
    $group = $stmt->fetch() ?: null;
    $tgDone = $group || !empty($client['telegram_setup_done']);
    $items[] = setup_item('telegram_group', 'Grupo de Telegram vinculado al revisor', $tgDone ? 'ok' : 'missing',
        $group ? 'Grupo «' . ($group['title'] ?: $group['chat_id']) . '»' : ($tgDone ? 'Marcado como configurado por el equipo.' : ''));
    $stmt = $pdo->prepare('SELECT role, match_text, client_id FROM telegram_role_rules WHERE client_id IS NULL OR client_id = ? ORDER BY role, match_text');
    $stmt->execute([$cid]);
    $rules = $stmt->fetchAll();
    $hasCm = (bool)array_filter($rules, fn($r) => $r['role'] === 'cm');
    $hasPm = (bool)array_filter($rules, fn($r) => $r['role'] === 'pm');
    $items[] = setup_item('telegram_roles', 'CM y PM reconocidos en Telegram', ($hasCm && $hasPm) ? 'ok' : 'missing',
        $hasCm && $hasPm ? '' : 'Sin esto el bot trata al CM/PM como diseñador y les genera revisiones.');

    // Meta
    $stmt = $pdo->prepare('SELECT platform, page_name, ig_username, status FROM social_accounts WHERE client_id = ? AND status <> "revoked"');
    $stmt->execute([$cid]);
    $accounts = $stmt->fetchAll();
    $fb = current(array_filter($accounts, fn($a) => $a['platform'] === 'facebook_page')) ?: null;
    $ig = current(array_filter($accounts, fn($a) => $a['platform'] === 'instagram_business')) ?: null;
    $items[] = setup_item('meta_facebook', 'Página de Facebook conectada', !$fb ? 'missing' : ($fb['status'] === 'active' ? 'ok' : 'warn'),
        !$fb ? '' : ($fb['status'] === 'active' ? (string)$fb['page_name'] : 'El token venció: vuelve a conectar la cuenta.'));
    $items[] = setup_item('meta_instagram', 'Instagram Business conectado', !$ig ? 'warn' : ($ig['status'] === 'active' ? 'ok' : 'warn'),
        !$ig ? 'Se conecta junto con la Página (la Página debe tener vinculada la cuenta de Instagram).' : ($ig['status'] === 'active' ? '@' . $ig['ig_username'] : 'El token venció: vuelve a conectar la cuenta.'), false);

    // Flujos, leads y brief
    $flows = $count('SELECT COUNT(*) FROM flows WHERE client_id = ? AND status = "active"');
    $items[] = setup_item('flows', 'Al menos un flujo activo', $flows > 0 ? 'ok' : 'warn', $flows > 0 ? "{$flows} activo(s)" : 'Sin flujos activos el bot no responde nada.', false);
    $stmt = $pdo->prepare('SELECT email FROM organic_lead_notify_emails WHERE client_id = ? ORDER BY id');
    $stmt->execute([$cid]);
    $leadEmails = $stmt->fetchAll(PDO::FETCH_COLUMN);
    $items[] = setup_item('lead_emails', 'Correos que reciben los leads', $leadEmails ? 'ok' : 'warn', $leadEmails ? count($leadEmails) . ' correo(s)' : 'Quién recibe el aviso cuando entra un lead.', false);
    $portal = $count('SELECT COUNT(*) FROM organic_lead_share_links WHERE client_id = ?');
    $items[] = setup_item('lead_portal', 'Portal de leads para el cliente (link)', $portal ? 'ok' : 'warn', $portal ? '' : 'Link para que el cliente vea sus leads. Se genera en Atención al Cliente → Leads Orgánicos.', false);
    $briefs = $count('SELECT COUNT(*) FROM client_briefs WHERE client_id = ? AND (token_hash IS NOT NULL OR status = "filled")');
    $items[] = setup_item('brief', 'Brief enviado al cliente', $briefs ? 'ok' : 'warn', $briefs ? '' : 'Sitio web, marketing digital o branding. Se envía en Atención al Cliente → Briefs.', false);

    // Pauta
    $stmt = $pdo->prepare('SELECT id, name, platforms FROM pauta_clients WHERE organic_client_id = ? LIMIT 1');
    $stmt->execute([$cid]);
    $pauta = $stmt->fetch() ?: null;
    $pautaPlatforms = $pauta ? (json_decode($pauta['platforms'], true) ?: []) : [];
    $withAccount = array_filter($pautaPlatforms, fn($p) => !empty($p['enabled']) && trim((string)($p['account_id'] ?? $p['customer_id'] ?? $p['advertiser_id'] ?? '')) !== '');
    $items[] = setup_item('pauta', 'Cliente en Pauta con cuenta publicitaria', $withAccount ? 'ok' : 'warn',
        $withAccount ? ('Vinculado a «' . $pauta['name'] . '» · ' . count($withAccount) . ' plataforma(s)') : ($pauta ? 'Vinculado, pero sin cuenta publicitaria activa.' : 'Sin esto no se lee la inversión ni se genera el reporte de pauta.'), false);

    return [
        'items'      => $items,
        'project'    => $project,
        'artes'      => $artes,
        'group'      => $group,
        'rules'      => $rules,
        'pauta'      => $pauta ? ['id' => $pauta['id'], 'name' => $pauta['name'], 'platforms' => $pautaPlatforms] : null,
        'lead_emails' => $leadEmails,
    ];
}

try {
    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET' && isset($_GET['list'])) {
        $rows = $pdo->query('SELECT id, name, slug, logo_url, status FROM clients ORDER BY name ASC')->fetchAll();
        json_response(['clients' => $rows]);
    }

    if ($method === 'GET' && isset($_GET['overview'])) {
        // Las verificaciones en vivo no corren aquí (serían decenas de llamadas a Google/Trello):
        // los items "live" no cuentan, el detalle se ve al abrir cada marca.
        $out = [];
        foreach ($pdo->query('SELECT * FROM clients WHERE status <> "archived" ORDER BY name ASC')->fetchAll() as $c) {
            $required = array_filter(setup_checklist($pdo, $c)['items'], fn($i) => $i['required'] && !$i['live']);
            $missing = array_values(array_map(fn($i) => $i['label'], array_filter($required, fn($i) => $i['status'] !== 'ok')));
            $out[] = [
                'id' => (int)$c['id'], 'name' => $c['name'], 'logo_url' => $c['logo_url'],
                'total' => count($required), 'done' => count($required) - count($missing), 'missing' => $missing,
            ];
        }
        json_response(['clients' => $out]);
    }

    if ($method === 'GET') {
        $clientId = (int)($_GET['client_id'] ?? 0);
        if ($clientId <= 0) {
            json_error('client_id requerido', 400);
        }
        $client = setup_load_client($pdo, $clientId);
        $check = (string)($_GET['check'] ?? '');

        // ---- Qué se borra si se elimina la marca (para mostrarlo antes de confirmar)
        if (isset($_GET['impact'])) {
            $counts = [];
            $queries = [
                'Conversaciones'           => 'SELECT COUNT(*) FROM conversations cv JOIN social_accounts sa ON sa.id = cv.social_account_id WHERE sa.client_id = ?',
                'Contactos'                => 'SELECT COUNT(*) FROM contacts WHERE client_id = ?',
                'Flujos'                   => 'SELECT COUNT(*) FROM flows WHERE client_id = ?',
                'Cuentas de Facebook/IG'   => 'SELECT COUNT(*) FROM social_accounts WHERE client_id = ?',
                'Leads de formularios'     => 'SELECT COUNT(*) FROM ad_leads WHERE client_id = ?',
                'Leads orgánicos'          => 'SELECT COUNT(*) FROM organic_leads WHERE client_id = ?',
                'Tandas de aprobación'     => 'SELECT COUNT(*) FROM content_batches WHERE client_id = ?',
                'Revisiones de Telegram'   => 'SELECT COUNT(*) FROM design_reviews WHERE client_id = ?',
                'Rendiciones trimestrales' => 'SELECT COUNT(*) FROM rendicion_forms WHERE client_id = ?',
                'Encuestas al cliente'     => 'SELECT COUNT(*) FROM client_surveys WHERE client_id = ?',
                'Briefs'                   => 'SELECT COUNT(*) FROM client_briefs WHERE client_id = ? AND (token_hash IS NOT NULL OR status = "filled")',
            ];
            foreach ($queries as $label => $sql) {
                $stmt = $pdo->prepare($sql);
                $stmt->execute([$clientId]);
                $n = (int)$stmt->fetchColumn();
                if ($n > 0) {
                    $counts[] = ['label' => $label, 'count' => $n];
                }
            }
            $stmt = $pdo->prepare('SELECT id, name FROM pauta_clients WHERE organic_client_id = ? LIMIT 1');
            $stmt->execute([$clientId]);
            json_response(['counts' => $counts, 'pauta' => $stmt->fetch() ?: null]);
        }

        // ---- Verificaciones en vivo (consultan servicios externos; por eso van aparte del checklist)
        if ($check !== '') {
            $service = setup_service_email();
            $shareHint = $service ? " Compártelo con {$service}." : '';

            if ($check === 'sheet') {
                if (!$client['sheet_id']) {
                    json_response(['ok' => false, 'message' => 'Aún no hay Google Sheet guardado.']);
                }
                $monthIdx = (int)date('n') - 1;
                $month = SETUP_MONTHS[$monthIdx];
                $tab = google_sheets_find_tab($client['sheet_id'], $month);
                if ($tab === null) {
                    $err = (string)google_sheets_last_error();
                    if (str_contains($err, 'Ninguna pestaña')) {
                        json_response(['ok' => false, 'message' => "El Sheet se puede leer, pero no tiene la pestaña del mes ({$month}). Crea una pestaña por mes con el nombre del mes."]);
                    }
                    json_response(['ok' => false, 'message' => "No se puede leer el Sheet.{$shareHint} Como Lector es suficiente.", 'detail' => $err]);
                }
                $rows = google_sheets_get_values($client['sheet_id'], google_sheets_quote_tab($tab) . '!A1:F80') ?? [];
                $posts = count(array_filter($rows, fn($r) => preg_match('/^\s*#?\s*\d+\s*$/', (string)($r[0] ?? '')) === 1));
                if ($posts === 0) {
                    json_response(['ok' => false, 'message' => "La pestaña «{$tab}» no tiene posts numerados en la columna A (A=post, C=día, D=indicaciones, E=mensaje de arte, F=copy)."]);
                }
                $msg = "Sheet legible — «{$tab}» con {$posts} post(s).";
                // Cerca de fin de mes ya se trabaja la parrilla siguiente (el revisor la usa para días menores a hoy).
                if ((int)date('j') >= 20) {
                    $next = SETUP_MONTHS[($monthIdx + 1) % 12];
                    if (google_sheets_find_tab($client['sheet_id'], $next) === null) {
                        json_response(['ok' => true, 'message' => $msg . " Aún no existe la pestaña de {$next}: créala antes de que empiece el mes."]);
                    }
                }
                json_response(['ok' => true, 'message' => $msg]);
            }

            if ($check === 'approval_folder' || $check === 'artes_folder') {
                $folderId = $check === 'approval_folder'
                    ? trim((string)$client['drive_approval_folder_id'])
                    : trim((string)(setup_project($pdo, $client['trello_board_id'] ?: null)['drive_folder_id'] ?? ''));
                if ($folderId === '') {
                    json_response(['ok' => false, 'message' => 'Aún no hay carpeta guardada.']);
                }
                // Mover/crear contenido exige Editor: se verifica canEdit, no solo lectura.
                $data = google_drive_request('GET', 'https://www.googleapis.com/drive/v3/files/' . rawurlencode($folderId) . '?fields=' . rawurlencode('name,mimeType,trashed,capabilities(canEdit)') . '&supportsAllDrives=true');
                if ($data === null) {
                    json_response(['ok' => false, 'message' => "No se puede abrir la carpeta.{$shareHint} Debe ser como Editor.", 'detail' => (string)google_drive_last_error()]);
                }
                if (($data['mimeType'] ?? '') !== 'application/vnd.google-apps.folder') {
                    json_response(['ok' => false, 'message' => 'Ese link no es de una carpeta (¿pegaste el de un archivo?).']);
                }
                if (!empty($data['trashed'])) {
                    json_response(['ok' => false, 'message' => 'La carpeta está en la papelera de Drive.']);
                }
                if (empty($data['capabilities']['canEdit'])) {
                    json_response(['ok' => false, 'message' => "La carpeta se puede ver pero no editar.{$shareHint} Cambia el permiso a Editor."]);
                }
                json_response(['ok' => true, 'message' => 'Carpeta «' . ($data['name'] ?? '') . '» accesible como Editor.']);
            }

            if ($check === 'trello_lists' || $check === 'trello_members') {
                if (!$client['trello_board_id']) {
                    json_response(['ok' => false, 'message' => 'Aún no hay tablero de Trello vinculado.']);
                }
                $info = setup_trello_lists($pdo, (string)$client['trello_board_id']);
                if ($info === null) {
                    json_response(['ok' => false, 'message' => 'No se pudo leer el tablero en Trello: revisa las credenciales en Configuración y que el tablero exista.']);
                }
                if ($check === 'trello_lists') {
                    $req = array_values(array_intersect($info['missing'], SETUP_TRELLO_REQUIRED));
                    $rec = array_values(array_intersect($info['missing'], SETUP_TRELLO_RECOMMENDED));
                    if ($req) {
                        json_response(['ok' => false, 'can_create' => true,
                            'message' => 'Faltan listas del protocolo: ' . implode(', ', $req) . '. Sin ellas no se calculan horas ni funciona la tanda automática.']);
                    }
                    json_response(['ok' => true, 'can_create' => (bool)$rec,
                        'message' => 'Listas del protocolo completas.' . ($rec ? ' Recomendadas que faltan: ' . implode(', ', $rec) . '.' : '')]);
                }
                // trello_members: miembros sin tarifa por hora → su costo por tarjeta sale en $0.
                try {
                    $members = trello_sync_request('GET', '/boards/' . rawurlencode((string)$client['trello_board_id']) . '/members', $info['creds'], ['fields' => 'id,fullName,username']);
                } catch (RuntimeException $e) {
                    json_response(['ok' => false, 'message' => 'No se pudieron leer los miembros del tablero.']);
                }
                if (!$members) {
                    json_response(['ok' => false, 'message' => 'El tablero no tiene miembros: agrega al equipo que trabaja la marca.']);
                }
                $rates = $pdo->query('SELECT member_id, hourly_rate FROM member_settings')->fetchAll(PDO::FETCH_KEY_PAIR);
                $noRate = [];
                foreach ($members as $m) {
                    if ((float)($rates[$m['id']] ?? 0) <= 0) {
                        $noRate[] = $m['fullName'] ?: $m['username'];
                    }
                }
                json_response($noRate
                    ? ['ok' => false, 'message' => 'Sin tarifa por hora (su costo sale en $0): ' . implode(', ', $noRate) . '.']
                    : ['ok' => true, 'message' => count($members) . ' miembro(s), todos con tarifa.']);
            }

            if ($check === 'telegram') {
                $me = telegram_call('getMe', [], 10);
                if (!is_array($me)) {
                    json_response(['ok' => false, 'message' => 'El bot de Telegram no está configurado en el servidor (TELEGRAM_BOT_TOKEN).']);
                }
                $bot = '@' . ($me['username'] ?? '');
                $stmt = $pdo->prepare('SELECT chat_id, title FROM telegram_groups WHERE client_id = ? LIMIT 1');
                $stmt->execute([(int)$client['id']]);
                $group = $stmt->fetch();
                if (!$group) {
                    json_response(['ok' => true, 'bot' => $bot, 'message' => "Bot listo: {$bot}. El bot aún no registra el grupo de esta marca."]);
                }
                $member = telegram_call('getChatMember', ['chat_id' => (int)$group['chat_id'], 'user_id' => (int)$me['id']], 10);
                $status = is_array($member) ? (string)($member['status'] ?? '') : '';
                if ($status !== 'administrator') {
                    json_response(['ok' => false, 'bot' => $bot, 'message' => "{$bot} ya no es administrador del grupo «{$group['title']}»" . ($status === 'left' || $status === 'kicked' ? ' (lo sacaron del grupo)' : '') . '. Vuelve a agregarlo como administrador.']);
                }
                json_response(['ok' => true, 'bot' => $bot, 'message' => "{$bot} es administrador del grupo «{$group['title']}»."]);
            }

            json_error('Verificación desconocida', 400);
        }

        // ---- Checklist de la marca
        $data = setup_checklist($pdo, $client);
        $rules = $data['rules'];
        $roleTexts = fn(string $role, bool $global) => array_values(array_map(fn($r) => $r['match_text'],
            array_filter($rules, fn($r) => $r['role'] === $role && (($r['client_id'] === null) === $global))));

        // Clientes de Pauta sin vincular, para no crear duplicados: se sugiere el de nombre igual.
        $candidates = [];
        $suggested = null;
        if (!$data['pauta']) {
            $mySlug = setup_slug($client['name']);
            foreach ($pdo->query('SELECT id, name, platforms FROM pauta_clients WHERE organic_client_id IS NULL ORDER BY name')->fetchAll() as $p) {
                $candidates[] = ['id' => $p['id'], 'name' => $p['name'], 'platforms' => json_decode($p['platforms'], true) ?: []];
                $pSlug = setup_slug($p['name']);
                if ($suggested === null && $pSlug !== '' && ($pSlug === $mySlug || str_contains($pSlug, $mySlug) || str_contains($mySlug, $pSlug))) {
                    $suggested = $p['id'];
                }
            }
        }

        $project = $data['project'];
        json_response([
            'client'        => $client,
            'items'         => $data['items'],
            'service_email' => setup_service_email(),
            'roles'         => [
                'cm' => $roleTexts('cm', false), 'pm' => $roleTexts('pm', false),
                'global_cm' => $roleTexts('cm', true), 'global_pm' => $roleTexts('pm', true),
            ],
            'telegram_group_linked' => (bool)$data['group'],
            'lead_emails'   => $data['lead_emails'],
            'pauta'         => $data['pauta'],
            'pauta_candidates' => $candidates,
            'pauta_suggested'  => $suggested,
            'can_manage'    => $canManage,
            'can_delete'    => in_array($operator['role'], ['superadmin', 'admin'], true),
            'project'       => $project ? [
                'alias' => $project['alias'], 'category' => $project['category'], 'project_type' => $project['project_type'],
                'budget' => (float)$project['budget'], 'revenue' => (float)$project['revenue'],
                'hours_estimated' => (float)$project['hours_estimated'], 'currency' => $project['currency'],
            ] : null,
            'artes_folder_id' => $data['artes'],
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
        $slug = setup_slug($name) ?: bin2hex(random_bytes(4));
        // Mismo nombre (sin importar mayúsculas/acentos/espacios) = misma marca: no se duplica.
        foreach ($pdo->query('SELECT id, name FROM clients')->fetchAll() as $c) {
            if (setup_slug($c['name']) === $slug) {
                json_error("Ya existe la marca «{$c['name']}». Selecciónala en la lista en vez de crearla de nuevo.", 409);
            }
        }
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
        $sets = [];
        $vals = [];
        $boardId = array_key_exists('trello_board_id', $input) ? trim((string)$input['trello_board_id']) : (string)$client['trello_board_id'];

        if (array_key_exists('trello_board_id', $input) && $boardId !== '') {
            $stmt = $pdo->prepare('SELECT name FROM clients WHERE trello_board_id = ? AND id <> ? LIMIT 1');
            $stmt->execute([$boardId, $clientId]);
            if ($other = $stmt->fetchColumn()) {
                json_error("Ese tablero ya está vinculado a la marca «{$other}». Cada marca debe tener su propio tablero.", 409);
            }
        }

        $sheetId = array_key_exists('sheet_id', $input) ? setup_extract_id((string)$input['sheet_id'], 'sheet') : null;
        $approvalId = array_key_exists('drive_approval_folder_id', $input) ? setup_extract_id((string)$input['drive_approval_folder_id'], 'folder') : null;
        $artesId = array_key_exists('artes_folder_id', $input) ? setup_extract_id((string)$input['artes_folder_id'], 'folder') : null;

        // Error frecuente: pegar la misma carpeta en los dos campos.
        $approvalFinal = $approvalId ?? (string)$client['drive_approval_folder_id'];
        $artesFinal = $artesId ?? trim((string)(setup_project($pdo, $boardId ?: null)['drive_folder_id'] ?? ''));
        if ($approvalFinal !== '' && $approvalFinal === $artesFinal) {
            json_error('La carpeta «Para aprobación» y la carpeta ARTES no pueden ser la misma.', 400);
        }

        if ($sheetId !== null) { $sets[] = 'sheet_id = ?'; $vals[] = $sheetId ?: null; }
        if ($approvalId !== null) { $sets[] = 'drive_approval_folder_id = ?'; $vals[] = $approvalId ?: null; }
        if (array_key_exists('trello_board_id', $input)) { $sets[] = 'trello_board_id = ?'; $vals[] = $boardId ?: null; }
        if (array_key_exists('ai_context', $input)) { $sets[] = 'ai_context = ?'; $vals[] = (string)$input['ai_context']; }
        if (array_key_exists('telegram_setup_done', $input)) { $sets[] = 'telegram_setup_done = ?'; $vals[] = !empty($input['telegram_setup_done']) ? 1 : 0; }

        if (!$sets && $artesId === null) {
            json_error('Nada para actualizar', 400);
        }
        if ($sets) {
            $vals[] = $clientId;
            $pdo->prepare('UPDATE clients SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($vals);
        }
        // Carpeta ARTES: vive por tablero en project_settings.
        if ($artesId !== null) {
            if ($boardId === '') {
                json_error('Primero vincula el tablero de Trello', 400);
            }
            $pdo->prepare('INSERT INTO project_settings (board_id, drive_folder_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE drive_folder_id = VALUES(drive_folder_id)')
                ->execute([$boardId, $artesId]);
        }
        json_response(['ok' => true]);
    }

    if ($action === 'save_roles') {
        // Reemplaza las reglas propias de esta marca (las globales no se tocan).
        $clean = function ($list): array {
            $out = [];
            foreach ((array)$list as $t) {
                $t = ltrim(trim((string)$t), '@');
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

    if ($action === 'save_lead_emails') {
        $emails = [];
        $invalid = [];
        foreach ((array)($input['emails'] ?? []) as $e) {
            $e = strtolower(trim((string)$e));
            if ($e === '') {
                continue;
            }
            if (filter_var($e, FILTER_VALIDATE_EMAIL)) {
                $emails[$e] = $e;
            } else {
                $invalid[] = $e;
            }
        }
        if ($invalid) {
            json_error('Correo(s) no válido(s): ' . implode(', ', $invalid), 400);
        }
        $pdo->beginTransaction();
        $pdo->prepare('DELETE FROM organic_lead_notify_emails WHERE client_id = ?')->execute([$clientId]);
        $ins = $pdo->prepare('INSERT INTO organic_lead_notify_emails (client_id, email) VALUES (?, ?)');
        foreach ($emails as $e) {
            $ins->execute([$clientId, $e]);
        }
        $pdo->commit();
        json_response(['ok' => true, 'count' => count($emails)]);
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
            json_error('Trello rechazó la creación' . ($created ? ' (alcanzó a crear: ' . implode(', ', $created) . ')' : '') . ': ' . $e->getMessage(), 502);
        }
        json_response(['ok' => true, 'created' => $created]);
    }

    if ($action === 'save_project') {
        if (!$canManage) {
            json_error('Solo la PM o un administrador pueden modificar presupuesto e ingreso', 403);
        }
        if (!$client['trello_board_id']) {
            json_error('Primero vincula el tablero de Trello', 400);
        }
        $type = in_array($input['project_type'] ?? '', ['retencion', 'unico'], true) ? $input['project_type'] : 'retencion';
        $pdo->prepare('INSERT INTO project_settings (board_id, alias, category, project_type, budget, revenue, hours_estimated, currency)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                       ON DUPLICATE KEY UPDATE alias = VALUES(alias), category = VALUES(category), project_type = VALUES(project_type),
                           budget = VALUES(budget), revenue = VALUES(revenue), hours_estimated = VALUES(hours_estimated), currency = VALUES(currency)')
            ->execute([
                $client['trello_board_id'],
                mb_substr(trim((string)($input['alias'] ?? '')), 0, 190),
                mb_substr(trim((string)($input['category'] ?? '')), 0, 190),
                $type,
                max(0, (float)($input['budget'] ?? 0)),
                max(0, (float)($input['revenue'] ?? 0)),
                max(0, (float)($input['hours_estimated'] ?? 0)),
                strtoupper(mb_substr(trim((string)($input['currency'] ?? '')), 0, 8)) ?: 'COP',
            ]);
        json_response(['ok' => true]);
    }

    if ($action === 'save_pauta') {
        if (!$canManage) {
            json_error('Solo la PM o un administrador pueden configurar la cuenta publicitaria', 403);
        }
        // Cliente de Pauta: el ya vinculado, uno existente elegido (pauta_id) o uno nuevo.
        $stmt = $pdo->prepare('SELECT id, platforms FROM pauta_clients WHERE organic_client_id = ? LIMIT 1');
        $stmt->execute([$clientId]);
        $row = $stmt->fetch() ?: null;
        $pickId = trim((string)($input['pauta_id'] ?? ''));
        if (!$row && $pickId !== '' && $pickId !== 'new') {
            $stmt = $pdo->prepare('SELECT id, platforms, organic_client_id FROM pauta_clients WHERE id = ?');
            $stmt->execute([$pickId]);
            $row = $stmt->fetch() ?: null;
            if (!$row) {
                json_error('Ese cliente de Pauta ya no existe', 404);
            }
            if ($row['organic_client_id'] !== null && (int)$row['organic_client_id'] !== $clientId) {
                json_error('Ese cliente de Pauta ya está vinculado a otra marca', 409);
            }
        }
        $existingPlatforms = $row ? (json_decode($row['platforms'], true) ?: []) : [];

        $incoming = (array)($input['platforms'] ?? []);
        $platforms = [];
        foreach (['meta' => 'account_id', 'google' => 'customer_id', 'tiktok' => 'advertiser_id'] as $key => $idField) {
            $prev = current(array_filter($existingPlatforms, fn($p) => ($p['platform'] ?? '') === $key)) ?: [];
            $account = trim((string)($incoming[$key] ?? ''));
            if ($key === 'meta' && $account !== '') {
                // Meta exige el prefijo act_ (se tolera que lo peguen sin él).
                $account = implode(', ', array_map(fn($a) => str_starts_with($a, 'act_') ? $a : 'act_' . $a, array_filter(array_map('trim', explode(',', $account)))));
            }
            $platforms[] = array_merge($prev, [
                'platform' => $key,
                'enabled'  => $account !== '',
                $idField   => $account,
                'budgets'  => $prev['budgets'] ?? (object)[],
            ]);
        }
        $json = json_encode($platforms, JSON_UNESCAPED_UNICODE);
        if ($row) {
            $pdo->prepare('UPDATE pauta_clients SET platforms = ?, organic_client_id = ? WHERE id = ?')->execute([$json, $clientId, $row['id']]);
            $id = $row['id'];
        } else {
            $id = 'c' . bin2hex(random_bytes(6));
            $pdo->prepare('INSERT INTO pauta_clients (id, name, budgets, platforms, organic_client_id) VALUES (?, ?, ?, ?, ?)')
                ->execute([$id, $client['name'], '{}', $json, $clientId]);
        }
        json_response(['ok' => true, 'pauta_id' => $id]);
    }

    if ($action === 'set_status') {
        // Archivar es reversible: la marca sale del resumen y de /vincular, sin perder nada.
        if (!$canManage) {
            json_error('Solo la PM o un administrador pueden archivar una marca', 403);
        }
        $status = (string)($input['status'] ?? '');
        if (!in_array($status, ['active', 'archived'], true)) {
            json_error('Estado inválido', 400);
        }
        $pdo->prepare('UPDATE clients SET status = ? WHERE id = ?')->execute([$status, $clientId]);
        json_response(['ok' => true, 'status' => $status]);
    }

    if ($action === 'delete_client') {
        // Único lugar del sistema donde se elimina una marca (clients.php ya no lo permite):
        // borra en cascada conversaciones, leads, rendiciones, revisiones, etc.
        if (!in_array($operator['role'], ['superadmin', 'admin'], true)) {
            json_error('Solo un administrador puede eliminar una marca', 403);
        }
        if (mb_strtolower(trim((string)($input['confirm_name'] ?? ''))) !== mb_strtolower(trim((string)$client['name']))) {
            json_error('El nombre escrito no coincide con el de la marca', 400);
        }
        $pdo->beginTransaction();
        if (!empty($input['delete_pauta'])) {
            // Presupuestos, leads de pauta y links de reporte se van con el cliente de Pauta (FK en cascada).
            $pdo->prepare('DELETE FROM pauta_clients WHERE organic_client_id = ?')->execute([$clientId]);
        } else {
            $pdo->prepare('UPDATE pauta_clients SET organic_client_id = NULL WHERE organic_client_id = ?')->execute([$clientId]);
        }
        $pdo->prepare('DELETE FROM clients WHERE id = ?')->execute([$clientId]);
        $pdo->commit();

        // Logo subido desde el sistema (los links externos pegados a mano no se tocan).
        $logo = (string)($client['logo_url'] ?? '');
        if (str_contains($logo, 'backend/public/uploads/client_logos/')) {
            $file = __DIR__ . '/../public/uploads/client_logos/' . basename($logo);
            if (is_file($file)) {
                @unlink($file);
            }
        }
        error_log('[client_setup] Marca eliminada: #' . $clientId . ' «' . $client['name'] . '» por operador #' . $operator['id']);
        json_response(['ok' => true]);
    }

    json_error('Acción desconocida', 400);
} catch (PDOException $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    // Columna inexistente = falta correr una migración: se dice cuál en vez de un 500 en blanco.
    $msg = $e->getMessage();
    if (str_contains($msg, 'telegram_setup_done')) {
        json_error('Falta correr backend/sql/migration_026_client_setup.sql en la base de datos.', 500);
    }
    if (str_contains($msg, 'organic_client_id')) {
        json_error('Falta correr backend/sql/migration_025_pauta_organic_link.sql en la base de datos.', 500);
    }
    json_error('Error de base de datos en client_setup: ' . $msg, 500);
}
