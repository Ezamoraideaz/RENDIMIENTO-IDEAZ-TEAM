<?php
require_once __DIR__ . '/../bootstrap.php';

// Credenciales de integraciones compartidas de la agencia (un solo juego),
// cifradas en BD con AES-256-GCM. Solo el superadmin puede escribirlas;
// cualquier usuario logueado las recibe descifradas según lo que su rol necesita.

$operator = require_login();
$pdo = db();

// Claves permitidas y qué roles pueden LEER cada una (escritura: solo superadmin)
$SETTING_READERS = [
    'trello_key'      => ['superadmin', 'admin', 'agent', 'agenda_full', 'agenda_member', 'cm'],
    'trello_token'    => ['superadmin', 'admin', 'agent', 'agenda_full', 'agenda_member', 'cm'],
    'drive_client_id' => ['superadmin', 'admin', 'cm'],
];

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $stmt = $pdo->query('SELECT setting_key, value_encrypted, iv FROM app_settings');
        $settings = [];
        foreach ($stmt->fetchAll() as $row) {
            $key = $row['setting_key'];
            if (!isset($SETTING_READERS[$key]) || !in_array($operator['role'], $SETTING_READERS[$key], true)) {
                continue;
            }
            try {
                $settings[$key] = decrypt_token($row['value_encrypted'], $row['iv']);
            } catch (RuntimeException $e) {
                // Valor ilegible (¿cambió ENCRYPTION_KEY?) — se omite en vez de romper el login
            }
        }
        json_response(['settings' => $settings]);
        break;

    case 'POST':
        require_state_changing_request();
        if ($operator['role'] !== 'superadmin') {
            json_error('Solo el superadministrador puede modificar las credenciales', 403);
        }
        $input = json_body();
        $incoming = $input['settings'] ?? null;
        if (!is_array($incoming) || $incoming === []) {
            json_error('Se requiere el objeto settings con al menos una clave', 400);
        }

        $stmt = $pdo->prepare(
            'INSERT INTO app_settings (setting_key, value_encrypted, iv, updated_by) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE value_encrypted = VALUES(value_encrypted), iv = VALUES(iv), updated_by = VALUES(updated_by)'
        );
        $del = $pdo->prepare('DELETE FROM app_settings WHERE setting_key = ?');
        $saved = [];
        foreach ($incoming as $key => $value) {
            if (!isset($SETTING_READERS[$key])) {
                json_error("Clave de configuración no permitida: {$key}", 400);
            }
            $value = trim((string)$value);
            if ($value === '') {
                $del->execute([$key]);
            } else {
                $enc = encrypt_token($value);
                $stmt->execute([$key, $enc['ciphertext'], $enc['iv'], $operator['id']]);
            }
            $saved[] = $key;
        }
        json_response(['saved' => $saved]);
        break;

    default:
        json_error('Método no permitido', 405);
}
