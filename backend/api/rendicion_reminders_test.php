<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/rendicion_reminders.php';

// Botón "Probar correo" de rendicion-dashboard.html — para quienes no tienen
// Terminal/SSH en su hosting y no pueden correr
// backend/cron/rendicion_reminders.php --test=... por línea de comandos.
// Manda los dos correos (kickoff + reunión) SOLO a la dirección indicada, con
// el trimestre/fecha reales de hoy, y NO toca rendicion_reminders_sent — no
// hay riesgo de que esto haga que el envío real (al equipo completo) se
// salte por creerse ya enviado. Solo superadmin/admin.

require_rendicion_admin_access();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

require_state_changing_request();
$input = json_body();
$email = trim((string)($input['email'] ?? ''));
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    json_error('Correo inválido', 400);
}

$today = rendicion_reminders_today();
[$quarter, $quarterEnd] = rendicion_reminders_current_quarter($today);

$recipients = [['email' => $email, 'name' => 'prueba']];
[$subject1, $lines1] = rendicion_reminders_kickoff($quarter, $quarterEnd);
rendicion_reminders_send($recipients, '[PRUEBA] ' . $subject1, $lines1);
[$subject2, $lines2] = rendicion_reminders_meeting($quarter, $quarterEnd);
rendicion_reminders_send($recipients, '[PRUEBA] ' . $subject2, $lines2);

json_response([
    'ok' => true,
    'quarter' => $quarter,
    'quarter_end' => $quarterEnd->format('Y-m-d'),
]);
