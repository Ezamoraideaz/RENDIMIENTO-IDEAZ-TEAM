<?php
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');

$config = __DIR__ . '/config.php';
if (!file_exists($config)) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'config.php no encontrado. Copia backend/config.example.php a backend/config.php y completa las credenciales.']);
    exit;
}
require_once $config;

require_once __DIR__ . '/includes/db.php';
require_once __DIR__ . '/includes/crypto.php';
require_once __DIR__ . '/includes/response.php';
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/password_reset.php';

// Techo de infraestructura, no el mecanismo de expiración: la sesión debe
// sobrevivir inactividad y navegación entre módulos durante el mismo día de
// trabajo. La expiración real ocurre en current_operator() (includes/auth.php)
// al cruzar medianoche America/Bogota. 25h de margen evita que un login tardío
// (ej. 23:59) pierda la cookie/archivo de sesión antes de ese corte.
const SESSION_LIFETIME_SECONDS = 90000;

ini_set('session.gc_maxlifetime', (string)SESSION_LIFETIME_SECONDS);

session_name(SESSION_COOKIE_NAME);
session_set_cookie_params([
    'lifetime' => SESSION_LIFETIME_SECONDS,
    'path'     => '/',
    'secure'   => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();
