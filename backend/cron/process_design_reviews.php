<?php
// Job de cPanel (Cron Jobs): ejecutar cada minuto, ej.
//   php /home/USUARIO/public_html/dashboard/backend/cron/process_design_reviews.php
// Toma las piezas que los diseñadores enviaron a los grupos de Telegram (cola
// design_reviews), las cruza con el cronograma y las revisa con Gemini, y publica
// el reporte en el grupo. Aparte del cron de process_scheduled.php.

declare(strict_types=1);

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Este script solo puede ejecutarse desde cron/línea de comandos.');
}

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/google_sheets.php';
require_once __DIR__ . '/../includes/design_review.php';
require_once __DIR__ . '/../includes/telegram_poll.php';

// Evita corridas solapadas (una revisión de video puede tardar más de un minuto).
$lockFile = __DIR__ . '/../storage/design_reviews.lock';
@mkdir(dirname($lockFile), 0700, true);
$lock = fopen($lockFile, 'c');
if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
    echo "Otra corrida sigue en curso.\n";
    exit;
}

$pdo = db();

// 1) Recibir mensajes nuevos de los grupos por polling (getUpdates). Dura hasta
//    TELEGRAM_POLL_SECONDS (45 por defecto; 0 = una sola consulta rápida) para que el
//    bot responda en segundos aunque el cron corra solo una vez por minuto.
$pollSeconds = defined('TELEGRAM_POLL_SECONDS') ? (int)TELEGRAM_POLL_SECONDS : 45;
$received = telegram_poll_run($pdo, $pollSeconds);

// 2) Revisar las piezas en cola.
$reviews = design_review_claim($pdo, 3); // pocas por corrida: respeta los límites del plan gratuito

$done = 0;
foreach ($reviews as $review) {
    try {
        design_review_process($pdo, $review);
        $done++;
    } catch (Throwable $e) {
        error_log('[design_reviews] #' . $review['id'] . ' ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        design_review_fail($pdo, $review, 'Error interno al revisar la pieza.', true);
    }
}

// Limpieza de seguridad: carpetas temporales con más de 24 h.
foreach (glob(__DIR__ . '/../storage/review_tmp/*', GLOB_ONLYDIR) ?: [] as $dir) {
    if (filemtime($dir) < time() - 86400) {
        tg_rrmdir($dir);
    }
}

echo "Revisiones procesadas: {$done}\n";
flock($lock, LOCK_UN);
