<?php
declare(strict_types=1);

// Funciones compartidas de los recordatorios de Rendición Trimestral — las
// usa tanto backend/cron/rendicion_reminders.php (el cron diario real, CLI)
// como backend/api/rendicion_reminders_test.php (botón "Probar correo" en
// rendicion-dashboard.html, para quienes no tienen Terminal/SSH en su
// hosting y no pueden correr el script por línea de comandos).

function rendicion_reminders_today(): DateTime
{
    $today = new DateTime('now', new DateTimeZone('America/Bogota'));
    $today->setTime(0, 0, 0); // normaliza a medianoche para que el diff en días sea exacto sin importar a qué hora corre
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

function rendicion_reminders_kickoff(string $quarter, DateTime $quarterEnd): array
{
    return [
        "Rendición Trimestral {$quarter} — ya puedes empezar",
        [
            'Hola {{nombre}},',
            '',
            "En una semana cierra el trimestre {$quarter} (" . $quarterEnd->format('d/m/Y') . ").",
            'Ya puedes empezar a diligenciar la Rendición Trimestral de Gestión de cada cuenta que tengas asignada — toma unos 10-15 minutos por cliente.',
            '',
            'Entra acá: ' . APP_BASE_URL . '/rendicion.html',
        ],
    ];
}

function rendicion_reminders_meeting(string $quarter, DateTime $quarterEnd): array
{
    return [
        "Mañana cierra el trimestre {$quarter} — agenda la socialización",
        [
            'Hola {{nombre}},',
            '',
            "Mañana (" . $quarterEnd->format('d/m/Y') . ") cierra el trimestre {$quarter}.",
            'Si todavía no la tienen agendada, coordinen la reunión de socialización presencial para revisar los resultados en equipo.',
            '',
            'Rendiciones: ' . APP_BASE_URL . '/rendicion.html',
        ],
    ];
}
