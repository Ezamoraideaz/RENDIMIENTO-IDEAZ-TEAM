<?php
declare(strict_types=1);

// Recuperación de contraseña por correo. Usado por el flujo self-service
// (backend/auth/forgot_password.php) y por el reenvío desde configuración
// (backend/api/user_password_reset.php) — ambos comparten esta misma lógica
// para no duplicar el manejo de tokens/throttle/email.

const RESET_TOKEN_TTL_SECONDS = 3600; // 1 hora
const RESET_THROTTLE_SECONDS = 120;   // evita reenvíos en ráfaga

// Genera un token, lo guarda (hasheado) y envía el correo. $requestedBy indica
// si lo disparó el propio usuario ('self') o un admin desde configuración ('admin').
function issue_password_reset(PDO $pdo, array $operator, string $requestedBy, ?string $ip): array
{
    $now = new DateTime('now', new DateTimeZone('UTC'));

    $stmt = $pdo->prepare('SELECT created_at FROM password_resets WHERE operator_id = ? ORDER BY created_at DESC LIMIT 1');
    $stmt->execute([$operator['id']]);
    $lastCreatedAt = $stmt->fetchColumn();
    if ($lastCreatedAt !== false) {
        $last = new DateTime($lastCreatedAt, new DateTimeZone('UTC'));
        if (($now->getTimestamp() - $last->getTimestamp()) < RESET_THROTTLE_SECONDS) {
            return ['sent' => false, 'reason' => 'throttled'];
        }
    }

    $rawToken = bin2hex(random_bytes(32));
    $tokenHash = hash('sha256', $rawToken);
    $expiresAt = (clone $now)->modify('+' . RESET_TOKEN_TTL_SECONDS . ' seconds')->format('Y-m-d H:i:s');

    $stmt = $pdo->prepare('INSERT INTO password_resets (operator_id, token_hash, expires_at, requested_by, requested_ip) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$operator['id'], $tokenHash, $expiresAt, $requestedBy, $ip]);

    $mailResult = send_password_reset_email($operator['email'], $operator['name'], $rawToken);

    return ['sent' => true, 'mail_result' => $mailResult];
}

function send_password_reset_email(string $toEmail, string $toName, string $rawToken): bool
{
    $resetUrl = APP_BASE_URL . '/reset-password.html?token=' . $rawToken;
    $subject = 'Restablece tu contraseña — Monitor Ideaz';
    $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';

    $headers = 'From: no-reply@' . (parse_url(APP_BASE_URL, PHP_URL_HOST) ?: 'localhost') . "\r\n"
             . "MIME-Version: 1.0\r\n"
             . "Content-Type: text/html; charset=UTF-8\r\n";

    $html = password_reset_email_html($toName, $resetUrl);

    return @mail($toEmail, $encodedSubject, $html, $headers);
}

function password_reset_email_html(string $name, string $url): string
{
    $safeName = htmlspecialchars($name !== '' ? $name : 'equipo', ENT_QUOTES, 'UTF-8');
    $safeUrl = htmlspecialchars($url, ENT_QUOTES, 'UTF-8');

    return <<<HTML
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0f172a;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f172a;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#1e293b;border-radius:16px;">
          <tr>
            <td style="padding:32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:40px;height:40px;background-color:#4f46e5;border-radius:10px;text-align:center;vertical-align:middle;">
                    <span style="color:#ffffff;font-weight:900;font-size:18px;">I</span>
                  </td>
                  <td style="padding-left:12px;color:#f1f5f9;font-weight:800;font-size:16px;">Monitor Ideaz</td>
                </tr>
              </table>

              <h1 style="color:#f1f5f9;font-size:18px;margin:28px 0 12px;">Restablece tu contraseña</h1>
              <p style="color:#cbd5e1;font-size:14px;line-height:1.6;margin:0 0 24px;">
                Hola {$safeName}, recibimos una solicitud para restablecer tu contraseña de Monitor Ideaz.
                Si no fuiste tú, puedes ignorar este correo.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background-color:#4f46e5;border-radius:8px;">
                    <a href="{$safeUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none;">Restablecer contraseña</a>
                  </td>
                </tr>
              </table>

              <p style="color:#94a3b8;font-size:12px;line-height:1.6;margin:24px 0 0;word-break:break-all;">
                Si el botón no funciona, copia y pega este enlace en tu navegador:<br>
                {$safeUrl}
              </p>

              <p style="color:#94a3b8;font-size:12px;margin:16px 0 0;">
                Este enlace expira en 1 hora y solo puede usarse una vez.
              </p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;border-top:1px solid #334155;">
                <tr>
                  <td style="padding-top:16px;color:#64748b;font-size:11px;">
                    Monitor Ideaz — equipo Ideaz
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
HTML;
}

// Busca un token válido (no usado, no expirado). Retorna la fila o null.
function find_valid_reset_token(PDO $pdo, string $rawToken): ?array
{
    $tokenHash = hash('sha256', $rawToken);
    $now = (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');

    $stmt = $pdo->prepare('SELECT id, operator_id, expires_at FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?');
    $stmt->execute([$tokenHash, $now]);
    $row = $stmt->fetch();
    return $row ?: null;
}

// Aplica la nueva contraseña e invalida todos los tokens pendientes del operador
// (incluye el recién usado y cualquier otro emitido antes, sin usar).
function consume_reset_token(PDO $pdo, int $operatorId, string $newPasswordHash): void
{
    $now = (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');

    $pdo->beginTransaction();
    try {
        $pdo->prepare('UPDATE operators SET password_hash = ? WHERE id = ?')->execute([$newPasswordHash, $operatorId]);
        $pdo->prepare('UPDATE password_resets SET used_at = ? WHERE operator_id = ? AND used_at IS NULL')->execute([$now, $operatorId]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}
