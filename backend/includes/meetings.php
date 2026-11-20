<?php
declare(strict_types=1);

// Módulo Reuniones — lógica compartida entre:
//   backend/api/meeting_ingest.php  (la extensión de Chrome envía la transcripción)
//   backend/api/meetings.php        (reuniones.html consulta/edita)
//   backend/api/meeting_tokens.php  (llaves personales de la extensión)
// Requiere backend/sql/migration_029_meetings.sql.

const MEETINGS_ADMIN_ROLES = ['superadmin', 'admin'];
// Roles que pueden usar el módulo (ven sus propias grabaciones; admin/superadmin ven todas).
// Debe coincidir con ACCESS de js/session.js para la página 'reuniones'.
const MEETINGS_ROLES = ['superadmin', 'admin', 'cm', 'agenda_full', 'agenda_member'];

// Nombres con que Meet rotula los subtítulos propios según el idioma de la interfaz.
const MEETINGS_SELF_LABELS = ['tú', 'tu', 'you', 'vous', 'você', 'du', 'tu (presentando)', 'you (presenting)'];

function require_meetings_access(): array
{
    return require_role(MEETINGS_ROLES);
}

function meetings_is_admin(array $operator): bool
{
    return in_array($operator['role'] ?? '', MEETINGS_ADMIN_ROLES, true);
}

// ── Llaves de la extensión ─────────────────────────────────────────────────

function meetings_hash_token(string $token): string
{
    return hash('sha256', $token);
}

// La extensión manda la llave en X-Ideaz-Token (no en Authorization: varios
// hostings compartidos con Apache/CGI descartan ese encabezado).
function require_extension_operator(): array
{
    $token = trim((string)($_SERVER['HTTP_X_IDEAZ_TOKEN'] ?? ''));
    if ($token === '' || strlen($token) > 200) {
        json_error('Falta la llave de la extensión. Genérala en Reuniones → Conectar extensión.', 401);
    }
    $stmt = db()->prepare('
        SELECT t.id AS token_id, o.id, o.email, o.name, o.role
        FROM meeting_extension_tokens t
        JOIN operators o ON o.id = t.operator_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND o.active = 1
    ');
    $stmt->execute([meetings_hash_token($token)]);
    $row = $stmt->fetch();
    if (!$row) {
        json_error('Llave inválida o revocada. Genera una nueva en Reuniones → Conectar extensión.', 401);
    }
    if (!in_array($row['role'], MEETINGS_ROLES, true)) {
        json_error('Tu usuario no tiene acceso al módulo Reuniones.', 403);
    }
    db()->prepare('UPDATE meeting_extension_tokens SET last_used_at = UTC_TIMESTAMP() WHERE id = ?')
        ->execute([$row['token_id']]);
    return $row;
}

// ── Fechas ─────────────────────────────────────────────────────────────────

// Epoch en milisegundos (como lo manda la extensión) → 'Y-m-d H:i:s.v' en UTC.
function meetings_ms_to_utc($ms, bool $withMillis = true): ?string
{
    if (!is_numeric($ms)) {
        return null;
    }
    $ms = (int)$ms;
    // Rango razonable: 2024-01-01 .. 2100-01-01
    if ($ms < 1704067200000 || $ms > 4102444800000) {
        return null;
    }
    $dt = DateTime::createFromFormat('U.u', sprintf('%d.%03d000', intdiv($ms, 1000), $ms % 1000), new DateTimeZone('UTC'));
    if (!$dt) {
        return null;
    }
    return $dt->format($withMillis ? 'Y-m-d H:i:s.v' : 'Y-m-d H:i:s');
}

// 'Y-m-d H:i:s[.v]' guardado en UTC → ISO-8601 con Z (el navegador lo pasa a hora local).
function meetings_iso(?string $utc): ?string
{
    if ($utc === null || $utc === '') {
        return null;
    }
    return str_replace(' ', 'T', $utc) . 'Z';
}

// Día local de Bogotá (Y-m-d) → límite UTC para filtrar started_at.
function meetings_bogota_day_to_utc(string $day, bool $endOfDay): ?string
{
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $day)) {
        return null;
    }
    $dt = new DateTime($day . ($endOfDay ? ' 23:59:59' : ' 00:00:00'), new DateTimeZone('America/Bogota'));
    $dt->setTimezone(new DateTimeZone('UTC'));
    return $dt->format('Y-m-d H:i:s');
}

// ── Participación ──────────────────────────────────────────────────────────

function meetings_clean_name(string $name): string
{
    $name = trim(preg_replace('/\s+/u', ' ', $name) ?? '');
    return mb_substr($name, 0, 160);
}

// Tiempo de habla de un fragmento. Los subtítulos aparecen cuando la persona
// empieza a hablar y se actualizan hasta que termina, así que fin − inicio es
// una buena aproximación; si el bloque llegó de golpe (duración ~0) se estima
// por palabras (~2,5 palabras por segundo).
function meetings_utc_seconds(string $utc): float
{
    $tz = new DateTimeZone('UTC');
    $dt = DateTime::createFromFormat('Y-m-d H:i:s.v', $utc, $tz) ?: DateTime::createFromFormat('Y-m-d H:i:s', $utc, $tz);
    return $dt ? (float)$dt->format('U.v') : 0.0;
}

function meetings_segment_seconds(array $seg): float
{
    $byClock = max(0.0, meetings_utc_seconds((string)$seg['ended_at']) - meetings_utc_seconds((string)$seg['started_at']));
    $byWords = ((int)($seg['word_count'] ?? 0)) / 2.5;
    return max($byClock, $byWords, 1.0);
}

// Devuelve [['name','seconds','words','segments','percent'], ...] ordenado de mayor a menor,
// incluidas las personas que estuvieron en la llamada sin hablar (0 %).
function meetings_participation(array $segments, array $participantNames): array
{
    $by = [];
    foreach ($segments as $seg) {
        $name = $seg['speaker'] !== '' ? $seg['speaker'] : 'Sin identificar';
        if (!isset($by[$name])) {
            $by[$name] = ['name' => $name, 'seconds' => 0.0, 'words' => 0, 'segments' => 0];
        }
        $by[$name]['seconds'] += meetings_segment_seconds($seg);
        $by[$name]['words'] += (int)$seg['word_count'];
        $by[$name]['segments']++;
    }
    foreach ($participantNames as $name) {
        if ($name !== '' && !isset($by[$name])) {
            $by[$name] = ['name' => $name, 'seconds' => 0.0, 'words' => 0, 'segments' => 0];
        }
    }
    $total = array_sum(array_column($by, 'seconds'));
    $out = [];
    foreach ($by as $row) {
        $row['seconds'] = round($row['seconds'], 1);
        $row['percent'] = $total > 0 ? round($row['seconds'] * 100 / $total, 1) : 0.0;
        $out[] = $row;
    }
    usort($out, fn($a, $b) => $b['seconds'] <=> $a['seconds'] ?: strcmp($a['name'], $b['name']));
    return $out;
}

function meetings_word_count(string $text): int
{
    $parts = preg_split('/\s+/u', trim($text), -1, PREG_SPLIT_NO_EMPTY);
    return $parts ? count($parts) : 0;
}
