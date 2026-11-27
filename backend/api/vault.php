<?php
// Módulo Accesos. Roles: superadmin, admin y cm.
//   crear                       los tres
//   ver usuario/contraseña      los tres, con un código de superadmin (uno por acceso)
//   editar y borrar             superadmin y admin, con código
//   papelera, registro          solo superadmin
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/vault.php';

header('Cache-Control: no-store');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');

set_exception_handler(function (Throwable $e): void {
    error_log('vault: ' . $e->getMessage());
    json_error('Error en la bóveda. Revisa que se haya corrido migration_032_vault.sql y el log del servidor.', 500);
});

const VAULT_CATEGORIES = ['social', 'web', 'hosting', 'dominio', 'correo', 'plataforma', 'otro'];
const VAULT_GRANT_SECONDS = 330; // para guardar una edición autorizada (la pantalla da 5 min)

$operator = require_role(['superadmin', 'admin', 'cm']);
$isSuper  = $operator['role'] === 'superadmin';
$canEdit  = $isSuper || $operator['role'] === 'admin';
$pdo      = db();

function vault_find(int $id, bool $deleted = false): array
{
    $stmt = db()->prepare('SELECT * FROM vault_items WHERE id = ? AND deleted_at IS ' . ($deleted ? 'NOT NULL' : 'NULL'));
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) {
        json_error('El acceso no existe', 404);
    }
    return $row;
}

// Valida el formulario y separa los datos visibles de los secretos
function vault_read_form(array $in): array
{
    $text = fn(string $k, int $max) => mb_substr(trim((string)($in[$k] ?? '')), 0, $max);
    $meta = [
        'brand_name' => $text('brand_name', 150),
        'category'   => $text('category', 20),
        'title'      => $text('title', 190),
        'url'        => $text('url', 500),
        'owner'      => $text('owner', 150),
    ];
    if ($meta['brand_name'] === '' || $meta['title'] === '') {
        json_error('La marca y el nombre de la plataforma son obligatorios', 400);
    }
    if (!in_array($meta['category'], VAULT_CATEGORIES, true)) {
        json_error('Tipo de acceso inválido', 400);
    }
    if ($meta['url'] !== '' && !preg_match('#^https?://#i', $meta['url'])) {
        $meta['url'] = 'https://' . $meta['url'];
    }
    $secrets = [
        'username' => $text('username', 300),
        'password' => mb_substr((string)($in['password'] ?? ''), 0, 500),
        'notes'    => $text('notes', 3000),
    ];
    return [$meta, $secrets];
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $view = $_GET['view'] ?? 'list';

    if ($view === 'audit') {
        require_role(['superadmin']);
        $rows = $pdo->query('SELECT operator_name, action, item_label, reason, approver_name, ip, created_at
                             FROM vault_audit ORDER BY id DESC LIMIT 500')->fetchAll();
        json_response(['audit' => $rows]);
    }

    $trash = $view === 'trash';
    if ($trash) {
        require_role(['superadmin']);
    }
    $pdo->exec('DELETE FROM vault_items WHERE deleted_at < UTC_TIMESTAMP() - INTERVAL 30 DAY');
    // Nunca se envían payload ni wrapped_key en el listado
    $items = $pdo->query('SELECT id, brand_name, category, title, url, owner, updated_at, deleted_at FROM vault_items
                          WHERE deleted_at IS ' . ($trash ? 'NOT NULL' : 'NULL') . ' ORDER BY brand_name, title')->fetchAll();
    $brands = $pdo->query("SELECT name FROM clients WHERE status <> 'archived'
                           UNION SELECT brand_name FROM vault_items WHERE deleted_at IS NULL ORDER BY 1")->fetchAll(PDO::FETCH_COLUMN);
    $stmt = $pdo->prepare('SELECT secret IS NOT NULL FROM vault_totp WHERE operator_id = ?');
    $stmt->execute([$operator['id']]);
    json_response([
        'items'    => $items,
        'brands'   => $brands,
        'enrolled' => (bool)$stmt->fetchColumn(),
        'failures' => $isSuper ? vault_recent_failures() : 0,
    ]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}
verify_csrf();
$in     = json_body();
$action = (string)($in['action'] ?? '');
$id     = (int)($in['id'] ?? 0);
$code   = (string)($in['code'] ?? '');
$reason = trim((string)($in['reason'] ?? ''));

// admin y cm deben decir para qué piden el código
function vault_require_reason(bool $isSuper, string $reason): void
{
    if (!$isSuper && mb_strlen($reason) < 5) {
        json_error('Escribe el motivo de la consulta', 400);
    }
}

switch ($action) {
    case 'create':
        [$meta, $secrets] = vault_read_form($in);
        $uid = bin2hex(random_bytes(16));
        $enc = vault_encrypt_item($secrets, $uid);
        $stmt = $pdo->prepare('INSERT INTO vault_items (uid, brand_name, category, title, url, owner, payload, wrapped_key, created_by, created_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())');
        $stmt->execute([$uid, ...array_values($meta), $enc['payload'], $enc['wrapped_key'], $operator['id']]);
        vault_log($operator, 'create', $meta + ['id' => (int)$pdo->lastInsertId()]);
        json_response(['ok' => true], 201);

    case 'reveal':
        $purpose = ($in['purpose'] ?? '') === 'edit' ? 'edit' : 'view';
        if ($purpose === 'edit' && !$canEdit) {
            json_error('Tu rol no puede editar accesos', 403);
        }
        vault_require_reason($isSuper, $reason);
        $item = vault_find($id);
        $approver = vault_consume_code($operator, $code, $item);
        $secrets = vault_decrypt_item($item);
        vault_log($operator, $purpose === 'edit' ? 'open_edit' : 'view', $item, $reason, $approver);
        if ($purpose === 'edit') {
            $_SESSION['vault_grant'][$id] = time() + VAULT_GRANT_SECONDS;
        }
        json_response(['secrets' => $secrets]);

    case 'update':
        if (!$canEdit || ($_SESSION['vault_grant'][$id] ?? 0) < time()) {
            json_error('La autorización para editar venció. Pide un código nuevo.', 403);
        }
        $item = vault_find($id);
        [$meta, $secrets] = vault_read_form($in);
        $enc = vault_encrypt_item($secrets, $item['uid']);
        $stmt = $pdo->prepare('UPDATE vault_items SET brand_name = ?, category = ?, title = ?, url = ?, owner = ?,
                               payload = ?, wrapped_key = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?');
        $stmt->execute([...array_values($meta), $enc['payload'], $enc['wrapped_key'], $id]);
        unset($_SESSION['vault_grant'][$id]);
        vault_log($operator, 'update', $meta + ['id' => $id]);
        json_response(['ok' => true]);

    case 'delete':
        if (!$canEdit) {
            json_error('Tu rol no puede borrar accesos', 403);
        }
        vault_require_reason($isSuper, $reason);
        $item = vault_find($id);
        $approver = vault_consume_code($operator, $code, $item);
        $pdo->prepare('UPDATE vault_items SET deleted_at = UTC_TIMESTAMP() WHERE id = ?')->execute([$id]);
        vault_log($operator, 'delete', $item, $reason, $approver);
        json_response(['ok' => true]);

    case 'restore':
        require_role(['superadmin']);
        $item = vault_find($id, true);
        $pdo->prepare('UPDATE vault_items SET deleted_at = NULL WHERE id = ?')->execute([$id]);
        vault_log($operator, 'restore', $item);
        json_response(['ok' => true]);

    case 'enroll_start':
    case 'enroll_confirm':
        require_role(['superadmin']);
        $key = vault_master_key();
        $stmt = $pdo->prepare('SELECT * FROM vault_totp WHERE operator_id = ?');
        $stmt->execute([$operator['id']]);
        $totp = $stmt->fetch();

        if ($action === 'enroll_start') {
            // La contraseña impide que una sesión abandonada registre otro teléfono
            $stmt = $pdo->prepare('SELECT password_hash FROM operators WHERE id = ?');
            $stmt->execute([$operator['id']]);
            vault_check_lockout($operator);
            if (!password_verify((string)($in['password'] ?? ''), (string)$stmt->fetchColumn())) {
                vault_log($operator, 'code_fail');
                json_error('Contraseña incorrecta', 403);
            }
            // Cambiar de teléfono exige además un código del actual o de recuperación
            if ($totp && $totp['secret'] !== null) {
                vault_consume_code($operator, $code);
            }
            $secret = random_bytes(20);
            $sealed = vault_seal($secret, $key, 'totp:' . $operator['id']);
            $pdo->prepare('INSERT INTO vault_totp (operator_id, pending_secret) VALUES (?, ?)
                           ON DUPLICATE KEY UPDATE pending_secret = VALUES(pending_secret)')
                ->execute([$operator['id'], $sealed]);
            $b32 = vault_base32_encode($secret);
            $label = rawurlencode('IDEAZ Accesos:' . $operator['email']);
            json_response(['secret' => $b32, 'uri' => "otpauth://totp/$label?secret=$b32&issuer=" . rawurlencode('IDEAZ Accesos')]);
        }

        if (!$totp || $totp['pending_secret'] === null) {
            json_error('Inicia de nuevo la activación', 409);
        }
        vault_check_lockout($operator);
        $secret = vault_open($totp['pending_secret'], $key, 'totp:' . $operator['id']);
        $step = vault_totp_match($secret, (string)preg_replace('/\s/', '', $code), 0);
        if ($step === null) {
            vault_log($operator, 'code_fail');
            json_error('El código no coincide. Revisa la hora del teléfono e intenta con el siguiente.', 403);
        }
        $recovery = [];
        for ($i = 0; $i < 8; $i++) {
            $recovery[] = implode('-', str_split(strtoupper(bin2hex(random_bytes(6))), 4));
        }
        $hashes = array_map(fn($c) => hash('sha256', str_replace('-', '', $c)), $recovery);
        $pdo->prepare('UPDATE vault_totp SET secret = pending_secret, pending_secret = NULL, last_step = ?, recovery_hashes = ?, confirmed_at = UTC_TIMESTAMP()
                       WHERE operator_id = ?')->execute([$step, json_encode($hashes), $operator['id']]);
        vault_log($operator, 'enroll');
        json_response(['recovery' => $recovery]);

    default:
        json_error('Acción no válida', 400);
}
