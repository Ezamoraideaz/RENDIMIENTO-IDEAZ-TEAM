<?php
declare(strict_types=1);

// Notificación al equipo comercial cada vez que se importa un archivo de
// leads orgánicos para un cliente. Mismo patrón que send_ad_lead_notification()
// (includes/ad_leads.php) — mail() nativo de PHP, no hay SMTP configurado en
// el proyecto.

function send_organic_lead_import_notification(PDO $pdo, array $client, string $filename, int $rowCount): void
{
    $stmt = $pdo->prepare('SELECT email FROM organic_lead_notify_emails WHERE client_id = ? ORDER BY id ASC');
    $stmt->execute([$client['id']]);
    $emails = $stmt->fetchAll(PDO::FETCH_COLUMN);
    if (!$emails) {
        return; // el import se guarda igual, solo no hay a quién avisar
    }

    $shareStmt = $pdo->prepare('SELECT 1 FROM organic_lead_share_links WHERE client_id = ?');
    $shareStmt->execute([$client['id']]);
    $hasShareLink = (bool)$shareStmt->fetchColumn();

    $lines = [
        'Se importó una nueva base de leads orgánicos:',
        '',
        'Cliente: ' . $client['name'],
        'Archivo: ' . $filename,
        'Registros importados: ' . $rowCount,
        '',
        $hasShareLink
            ? 'Si ya tienes el link público de este cliente, ahí puedes ver y exportar los registros sin iniciar sesión.'
            : 'Pide a quien administra Atención al Cliente que te comparta el link de acceso a los registros, o revísalos en: ' . APP_BASE_URL . '/atencion-cliente.html',
    ];

    $subject = 'Nuevos leads orgánicos — ' . $client['name'];
    $headers = 'From: no-reply@' . (parse_url(APP_BASE_URL, PHP_URL_HOST) ?: 'localhost') . "\r\n"
             . "Content-Type: text/plain; charset=UTF-8\r\n";

    foreach ($emails as $to) {
        @mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', implode("\n", $lines), $headers);
    }
}
