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
//
// PROBAR ANTES DE AGENDAR EL CRON (si tienes Terminal/SSH; si no, usa el
// botón "Probar correo" de rendicion-dashboard.html — ver
// backend/api/rendicion_reminders_test.php):
//   php backend/cron/rendicion_reminders.php --test=tu-correo@dominio.com
// Manda los dos correos (kickoff + reunión) SOLO a esa dirección, con el
// trimestre/fecha reales de hoy, y NO toca rendicion_reminders_sent — se
// puede correr las veces que haga falta sin arriesgar que el envío real
// (a todo el equipo) se salte por creerse ya enviado.

declare(strict_types=1);

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Este script solo puede ejecutarse desde cron/línea de comandos.');
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/rendicion_reminders.php';

$pdo = db();
$today = rendicion_reminders_today();
[$quarter, $quarterEnd] = rendicion_reminders_current_quarter($today);

// Modo prueba: --test=correo@dominio.com — manda ambos correos solo a esa
// dirección, sin tocar rendicion_reminders_sent ni al resto del equipo.
$testEmail = null;
foreach ($argv ?? [] as $arg) {
    if (str_starts_with($arg, '--test=')) {
        $testEmail = trim(substr($arg, 7));
    }
}

if ($testEmail !== null) {
    if (!filter_var($testEmail, FILTER_VALIDATE_EMAIL)) {
        fwrite(STDERR, "Correo inválido: {$testEmail}\n");
        exit(1);
    }
    $recipients = [['email' => $testEmail, 'name' => 'prueba']];
    [$subject1, $lines1] = rendicion_reminders_kickoff($quarter, $quarterEnd);
    rendicion_reminders_send($recipients, '[PRUEBA] ' . $subject1, $lines1);
    [$subject2, $lines2] = rendicion_reminders_meeting($quarter, $quarterEnd);
    rendicion_reminders_send($recipients, '[PRUEBA] ' . $subject2, $lines2);
    echo "Modo prueba: 2 correos enviados a {$testEmail} (trimestre detectado: {$quarter}, cierra " . $quarterEnd->format('d/m/Y') . "). No se marcó nada como enviado.\n";
    exit(0);
}

$daysUntilEnd = (int)$today->diff($quarterEnd)->format('%r%a');
$sent = 0;

if ($daysUntilEnd === 7 && rendicion_reminders_mark_sent($pdo, $quarter, 'kickoff')) {
    [$subject, $lines] = rendicion_reminders_kickoff($quarter, $quarterEnd);
    rendicion_reminders_send(rendicion_reminders_recipients($pdo), $subject, $lines);
    $sent++;
}

if ($daysUntilEnd === 1 && rendicion_reminders_mark_sent($pdo, $quarter, 'meeting')) {
    [$subject, $lines] = rendicion_reminders_meeting($quarter, $quarterEnd);
    rendicion_reminders_send(rendicion_reminders_recipients($pdo), $subject, $lines);
    $sent++;
}

echo "Recordatorios enviados: {$sent}\n";
