<?php
declare(strict_types=1);

// Lógica de la bóveda de Accesos que toca la base de datos.
require_once __DIR__ . '/vault_crypto.php';

// Límites de códigos errados. Con 3 códigos válidos por superadmin (6 en total) cada
// intento tiene ~6 en un millón de acertar: el tope diario es lo que vuelve inviable
// adivinar a ciegas, y los fallos quedan a la vista del superadmin.
const VAULT_LIMITS = [
    // [minutos, máx. por usuario, máx. entre todos]
    [15, 5, 15],
    [1440, 10, 30],
];

// La clave maestra vive en un archivo FUERA de la carpeta pública del hosting.
function vault_master_key(): string
{
    static $key = null;
    if ($key !== null) {
        return $key;
    }
    if (!defined('VAULT_KEY_FILE') || VAULT_KEY_FILE === '' || !is_readable(VAULT_KEY_FILE)) {
        json_error('La bóveda no está configurada: falta el archivo de clave maestra (VAULT_KEY_FILE en config.php).', 503);
    }
    // Ni dentro del dashboard ni en ninguna parte de public_html (DOCUMENT_ROOT)
    $keyPath = (string)realpath(VAULT_KEY_FILE);
    foreach ([dirname(__DIR__, 2), $_SERVER['DOCUMENT_ROOT'] ?? ''] as $root) {
        $root = $root !== '' ? realpath($root) : false;
        if ($root !== false && strpos($keyPath, rtrim($root, '/\\') . DIRECTORY_SEPARATOR) === 0) {
            json_error('La clave maestra no puede estar dentro de public_html: muévela a la carpeta de tu usuario.', 503);
        }
    }
    $raw = base64_decode(trim((string)file_get_contents(VAULT_KEY_FILE)), true);
    if ($raw === false || strlen($raw) !== 32) {
        json_error('La clave maestra es inválida: debe ser 32 bytes en base64.', 503);
    }
    return $key = $raw;
}

function vault_encrypt_item(array $secrets, string $uid): array
{
    $dataKey = random_bytes(32);
    return [
        'payload'     => vault_seal(json_encode($secrets, JSON_THROW_ON_ERROR), $dataKey, "item:$uid"),
        'wrapped_key' => vault_seal($dataKey, vault_master_key(), "key:$uid"),
    ];
}

function vault_decrypt_item(array $row): array
{
    $dataKey = vault_open($row['wrapped_key'], vault_master_key(), 'key:' . $row['uid']);
    return json_decode(vault_open($row['payload'], $dataKey, 'item:' . $row['uid']), true, 8, JSON_THROW_ON_ERROR);
}

function vault_log(array $operator, string $action, ?array $item = null, string $reason = '', string $approver = ''): void
{
    $stmt = db()->prepare('INSERT INTO vault_audit (operator_id, operator_name, action, item_id, item_label, reason, approver_name, ip, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())');
    $stmt->execute([
        $operator['id'],
        $operator['name'] ?: $operator['email'],
        $action,
        $item['id'] ?? null,
        $item ? mb_substr($item['brand_name'] . ' · ' . $item['title'], 0, 350) : '',
        mb_substr($reason, 0, 300),
        $approver,
        substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45),
    ]);
}

function vault_check_lockout(array $operator): void
{
    foreach (VAULT_LIMITS as [$minutes, $maxUser, $maxAll]) {
        $stmt = db()->prepare("SELECT COUNT(*) AS total, COALESCE(SUM(operator_id = ?), 0) AS mine FROM vault_audit
                               WHERE action = 'code_fail' AND created_at > UTC_TIMESTAMP() - INTERVAL $minutes MINUTE");
        $stmt->execute([$operator['id']]);
        $fails = $stmt->fetch();
        if ((int)$fails['mine'] >= $maxUser || (int)$fails['total'] >= $maxAll) {
            $wait = $minutes >= 60 ? intdiv($minutes, 60) . ' horas' : "$minutes minutos";
            json_error("Demasiados códigos errados. La bóveda queda bloqueada hasta $wait después del último error.", 429);
        }
    }
}

// Códigos errados de las últimas 24 h, para avisar al superadmin
function vault_recent_failures(): int
{
    return (int)db()->query("SELECT COUNT(*) FROM vault_audit WHERE action = 'code_fail'
                             AND created_at > UTC_TIMESTAMP() - INTERVAL 1 DAY")->fetchColumn();
}

// Valida un código del autenticador (o de recuperación) y lo consume. Un superadmin
// usa el suyo; admin y cm usan el que les dicte cualquier superadmin.
// Devuelve el nombre del superadmin dueño del código.
function vault_consume_code(array $operator, string $code, ?array $item = null): string
{
    $pdo = db();
    // Un intento a la vez: evita saltarse el límite con peticiones en paralelo
    if ((int)$pdo->query("SELECT GET_LOCK('ideaz_vault_code', 5)")->fetchColumn() !== 1) {
        json_error('Intenta de nuevo en unos segundos.', 429);
    }
    try {
        vault_check_lockout($operator);
        $isSuper = $operator['role'] === 'superadmin';
        $sql = "SELECT t.operator_id, t.secret, t.last_step, t.recovery_hashes, o.name, o.email
                FROM vault_totp t JOIN operators o ON o.id = t.operator_id
                WHERE t.secret IS NOT NULL AND o.active = 1 AND o.role = 'superadmin'" . ($isSuper ? ' AND o.id = ?' : '');
        $stmt = $pdo->prepare($sql);
        $stmt->execute($isSuper ? [$operator['id']] : []);
        $rows = $stmt->fetchAll();
        if (!$rows) {
            json_error($isSuper ? 'Primero activa tu autenticador.' : 'Ningún superadmin ha activado su autenticador todavía.', 409);
        }

        $clean = strtoupper((string)preg_replace('/[\s-]/', '', $code));
        foreach ($rows as $row) {
            $owner = $row['name'] ?: $row['email'];
            if (preg_match('/^\d{6}$/', $clean)) {
                $secret = vault_open($row['secret'], vault_master_key(), 'totp:' . $row['operator_id']);
                $step = vault_totp_match($secret, $clean, (int)$row['last_step']);
                if ($step !== null) {
                    $pdo->prepare('UPDATE vault_totp SET last_step = ? WHERE operator_id = ?')->execute([$step, $row['operator_id']]);
                    return $owner;
                }
            } elseif ($isSuper) { // códigos de recuperación: solo su propio dueño
                $hashes = json_decode($row['recovery_hashes'] ?? '[]', true) ?: [];
                $found = array_search(hash('sha256', $clean), $hashes, true);
                if ($found !== false) {
                    array_splice($hashes, (int)$found, 1);
                    $pdo->prepare('UPDATE vault_totp SET recovery_hashes = ? WHERE operator_id = ?')
                        ->execute([json_encode($hashes), $row['operator_id']]);
                    return $owner . ' (código de recuperación)';
                }
            }
        }
        vault_log($operator, 'code_fail', $item);
        json_error('Código incorrecto, vencido o ya usado.', 403);
    } finally {
        // json_error() hace exit y no pasa por aquí: en ese caso MySQL suelta el
        // bloqueo al cerrarse la conexión, al terminar la petición.
        $pdo->query("SELECT RELEASE_LOCK('ideaz_vault_code')");
    }
}
