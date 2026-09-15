<?php
// Job de cPanel (Cron Jobs): ejecutar UNA VEZ AL DÍA (ej. todos los días a
// las 8:00am), ej.
//   php /home/USUARIO/public_html/dashboard/backend/cron/rendicion_reminders.php
// A diferencia de process_scheduled.php (cada minuto), este cron es aparte
// porque solo necesita distinguir el DÍA, no el minuto — hay que crear un
// Cron Job nuevo en cPanel para este archivo.
//
// Envía dos correos automáticos a CM + PM (agenda_full) + superadmin/admin
// sobre la Rendición Trimestral:
//  - 7 días antes de que cierre el trimestre en curso: avisa que ya se puede
//    empezar a diligenciar el Formulario 1 de cada cuenta.
//  - 1 día antes de que cierre: avisa que hay que agendar la reunión de
//    socialización presencial.
//
// No hay una tabla de "CM asignado a este cliente" en el proyecto, así que
// el aviso es general para todo el equipo de gestión — no identifica a quién
// le falta diligenciar qué cuenta.

declare(strict_types=1);

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Este script solo puede ejecutarse desde cron/línea de comandos.');
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';

function rendicion_reminders_today(): DateTime
{
    $today = new DateTime('now', new DateTimeZone('America/Bogota'));
    $today->setTime(0, 0, 0); // normaliza a medianoche para que el diff en días sea exacto sin importar a qué hora corre el cron
    return $today;
}

// Trimestre calendario que contiene $today, y su último día (a medianoche).
function rendicion_reminders_current_quarter(DateTime $today): array
{
    $month = (int)$today->format('n');
    $year = (int)$today->format('Y');
    $q = intdiv($month - 1, 3) + 1;
    $endMonth = $q * 3;
    $end = new DateTime("{$year}-{$endMonth}-01", $today->getTimezone());
    $end->modify('last day of this month');
    $end->setTime(0, 0, 0);
    return ["{$year}-Q{$q}", $end];
}

function rendicion_reminders_recipients(PDO $pdo): array
{
    $stmt = $pdo->query("SELECT email, name FROM operators WHERE role IN ('cm','agenda_full','superadmin','admin') AND active = 1");
    return $stmt->fetchAll();
}

function rendicion_reminders_send(array $recipients, string $subject, array $lines): void
{
    $headers = 'From: no-reply@' . (parse_url(APP_BASE_URL, PHP_URL_HOST) ?: 'localhost') . "\r\n"
             . "Content-Type: text/plain; charset=UTF-8\r\n";
    $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
    $body = implode("\n", $lines);
    foreach ($recipients as $r) {
        $personalized = str_replace('{{nombre}}', $r['name'] ?: 'equipo', $body);
        @mail($r['email'], $encodedSubject, $personalized, $headers);
    }
}

// INSERT IGNORE por la PK (quarter, reminder_type) — si ya se marcó como
// enviado (rowCount 0), no se manda de nuevo aunque el cron corra otra vez
// el mismo día.
function rendicion_reminders_mark_sent(PDO $pdo, string $quarter, string $type): bool
{
    $stmt = $pdo->prepare('INSERT IGNORE INTO rendicion_reminders_sent (quarter, reminder_type) VALUES (?, ?)');
    $stmt->execute([$quarter, $type]);
    return $stmt->rowCount() > 0;
}

$pdo = db();
$today = rendicion_reminders_today();
[$quarter, $quarterEnd] = rendicion_reminders_current_quarter($today);
$daysUntilEnd = (int)$today->diff($quarterEnd)->format('%r%a');

$sent = 0;

if ($daysUntilEnd === 7 && rendicion_reminders_mark_sent($pdo, $quarter, 'kickoff')) {
    rendicion_reminders_send(rendicion_reminders_recipients($pdo),
        "Rendición Trimestral {$quarter} — ya puedes empezar",
        [
            'Hola {{nombre}},',
            '',
            "En una semana cierra el trimestre {$quarter} (" . $quarterEnd->format('d/m/Y') . ").",
            'Ya puedes empezar a diligenciar la Rendición Trimestral de Gestión de cada cuenta que tengas asignada — toma unos 10-15 minutos por cliente.',
            '',
            'Entra acá: ' . APP_BASE_URL . '/rendicion.html',
        ]
    );
    $sent++;
}

if ($daysUntilEnd === 1 && rendicion_reminders_mark_sent($pdo, $quarter, 'meeting')) {
    rendicion_reminders_send(rendicion_reminders_recipients($pdo),
        "Mañana cierra el trimestre {$quarter} — agenda la socialización",
        [
            'Hola {{nombre}},',
            '',
            "Mañana (" . $quarterEnd->format('d/m/Y') . ") cierra el trimestre {$quarter}.",
            'Si todavía no la tienen agendada, coordinen la reunión de socialización presencial para revisar los resultados en equipo.',
            '',
            'Rendiciones: ' . APP_BASE_URL . '/rendicion.html',
        ]
    );
    $sent++;
}

echo "Recordatorios enviados: {$sent}\n";
