<?php
// Script de diagnóstico temporal — BORRAR del servidor después de usarlo.
// Muestra en pantalla la causa exacta de un error 500 en el backend (config.php,
// conexión a MySQL, extensiones de PHP faltantes), que bootstrap.php oculta a
// propósito en producción.

ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');
error_reporting(E_ALL);

header('Content-Type: text/plain; charset=utf-8');

echo "PHP version: " . PHP_VERSION . "\n";
echo "Extensión PDO: " . (extension_loaded('pdo') ? 'OK' : 'FALTA') . "\n";
echo "Extensión pdo_mysql: " . (extension_loaded('pdo_mysql') ? 'OK' : 'FALTA') . "\n";
echo "Extensión openssl: " . (extension_loaded('openssl') ? 'OK' : 'FALTA') . "\n";
echo "Extensión curl: " . (extension_loaded('curl') ? 'OK' : 'FALTA') . "\n";
echo "Extensión mbstring: " . (extension_loaded('mbstring') ? 'OK' : 'FALTA') . "\n";
echo "\n";

echo "--- Paso 1: cargar config.php ---\n";
try {
    require_once __DIR__ . '/../config.php';
    echo "OK: config.php cargado.\n";
    echo "DB_HOST definido: " . (defined('DB_HOST') ? DB_HOST : 'NO DEFINIDO') . "\n";
    echo "DB_NAME definido: " . (defined('DB_NAME') ? DB_NAME : 'NO DEFINIDO') . "\n";
    echo "DB_USER definido: " . (defined('DB_USER') ? DB_USER : 'NO DEFINIDO') . "\n";
    echo "ENCRYPTION_KEY definida: " . (defined('ENCRYPTION_KEY') && ENCRYPTION_KEY !== '' ? 'sí (' . strlen(base64_decode(ENCRYPTION_KEY, true) ?: '') . ' bytes tras decodificar)' : 'NO / VACÍA') . "\n";
    echo "SETUP_TOKEN definido: " . (defined('SETUP_TOKEN') && SETUP_TOKEN !== '' ? 'sí' : 'NO / VACÍO') . "\n";
} catch (Throwable $e) {
    echo "ERROR cargando config.php: " . $e->getMessage() . "\n";
    exit;
}

echo "\n--- Paso 2: conectar a MySQL ---\n";
try {
    require_once __DIR__ . '/../includes/db.php';
    $pdo = db();
    echo "OK: conexión PDO establecida.\n";
    $stmt = $pdo->query('SHOW TABLES');
    $tables = $stmt->fetchAll(PDO::FETCH_COLUMN);
    echo "Tablas encontradas (" . count($tables) . "): " . implode(', ', $tables) . "\n";
} catch (Throwable $e) {
    echo "ERROR conectando a MySQL: " . $e->getMessage() . "\n";
    exit;
}

echo "\nTodo OK. Si aun así bootstrap_operator.php da 500, el problema es .htaccess (revisa el siguiente paso).\n";
