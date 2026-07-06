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

session_name(SESSION_COOKIE_NAME);
session_set_cookie_params([
    'lifetime' => 0,
    'path'     => '/',
    'secure'   => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();
