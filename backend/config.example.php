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

// Groq (console.groq.com → API Keys) — capa gratuita, usada por el nodo de IA y la
// respuesta con IA a comentarios en el constructor de flujos
define('GROQ_API_KEY', '');

// Cuenta de servicio de Google (console.cloud.google.com → IAM y administración →
// Cuentas de servicio → crear una → Claves → agregar clave → JSON). Se usa para
// leer en vivo, solo lectura, la parrilla de contenido (Google Sheets) de cada
// cliente en la tanda automática de aprobaciones — sin pedirle login a nadie.
// Comparte cada Sheet de cliente con el "client_email" que aparece en ese JSON,
// como Lector.
//
// Opción A (recomendada en hosting compartido sin acceso fácil para subir
// archivos): pega aquí el contenido completo del .json descargado, tal cual,
// entre comillas simples.
define('GOOGLE_SERVICE_ACCOUNT_JSON', '');

// Opción B: si prefieres subir el archivo .json en vez de pegarlo arriba, súbelo
// a backend/storage/ (ya está en .gitignore) y descomenta esta línea — solo se
// usa si GOOGLE_SERVICE_ACCOUNT_JSON está vacío.
// define('GOOGLE_SERVICE_ACCOUNT_KEY_FILE', __DIR__ . '/storage/google-service-account.json');

// URL pública donde vive el dashboard, SIN slash final
define('APP_BASE_URL', 'https://marketingdigitalideaz.com/dashboard');
define('OAUTH_REDIRECT_URI', APP_BASE_URL . '/backend/oauth/facebook_callback.php');

define('SESSION_COOKIE_NAME', 'ideaz_ac_session');

// Token temporal solo para backend/setup/bootstrap_operator.php (crear el primer
// operador sin acceso a Terminal/SSH). Generar un valor propio aleatorio, usarlo una
// vez, y luego borrar backend/setup/bootstrap_operator.php del servidor.
define('SETUP_TOKEN', '');

// Revisión de piezas con IA vía Telegram (backend/webhook/telegram.php).
// Bot: hablar con @BotFather → /newbot. Luego hacerlo ADMINISTRADOR de cada grupo de marca
// (así recibe todos los mensajes, aunque el modo privacidad esté activo).
define('TELEGRAM_BOT_TOKEN', '');
// String aleatorio propio; Telegram lo reenvía en cada petición al webhook (cabecera
// X-Telegram-Bot-Api-Secret-Token) y el webhook rechaza lo que no lo traiga.
// Generar con: php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"
define('TELEGRAM_WEBHOOK_SECRET', '');
// Gemini (aistudio.google.com → Get API key) — capa gratuita. Analiza imágenes y video.
define('GEMINI_API_KEY', '');
// Modelo de Gemini; verificar en AI Studio cuál está vigente en la capa gratuita.
define('GEMINI_MODEL', 'gemini-2.5-flash');
// Segundos que el cron escucha mensajes nuevos de Telegram en cada corrida (polling, para
// hostings que bloquean el webhook). 45 con un cron por minuto; 0 = una sola consulta.
define('TELEGRAM_POLL_SECONDS', 45);
