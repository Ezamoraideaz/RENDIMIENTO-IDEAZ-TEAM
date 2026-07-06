<?php
// Copiar este archivo como config.php y completar con credenciales reales
// NUNCA commitear config.php al repositorio

// Base de datos MySQL (crear la BD y correr backend/sql/schema.sql una sola vez)
define('DB_HOST', 'localhost');
define('DB_NAME', 'ideaz_atencion_cliente');
define('DB_USER', '');
define('DB_PASS', '');

// Clave de cifrado de tokens (32 bytes en base64). Generar con:
// php -r "echo base64_encode(random_bytes(32)), PHP_EOL;"
define('ENCRYPTION_KEY', '');

// App de Meta (developers.facebook.com) — tipo Business
define('META_APP_ID', '');
define('META_APP_SECRET', '');

// String aleatorio propio; se configura igual en el producto Webhooks de la App de Meta
// Generar con: php -r "echo bin2hex(random_bytes(16)), PHP_EOL;"
define('WEBHOOK_VERIFY_TOKEN', '');

// URL pública donde vive el dashboard, SIN slash final
define('APP_BASE_URL', 'https://marketingdigitalideaz.com/dashboard');
define('OAUTH_REDIRECT_URI', APP_BASE_URL . '/backend/oauth/facebook_callback.php');

define('SESSION_COOKIE_NAME', 'ideaz_ac_session');

// Token temporal solo para backend/setup/bootstrap_operator.php (crear el primer
// operador sin acceso a Terminal/SSH). Generar un valor propio aleatorio, usarlo una
// vez, y luego borrar backend/setup/bootstrap_operator.php del servidor.
define('SETUP_TOKEN', '');
