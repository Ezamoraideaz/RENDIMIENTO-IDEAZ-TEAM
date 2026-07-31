<?php
require_once __DIR__ . '/../bootstrap.php';

// Alarma manual: un admin/superadmin dispara un aviso a todos los usuarios
// logueados en ese momento (además del recordatorio automático de las 5pm
// que ya corre solo, por reloj, en cada navegador — ver js/alarm.js).
// GET: cualquier usuario logueado consulta el último disparo (polling desde
// Alarm.init()). POST: solo admin/superadmin puede disparar uno nuevo.

$operator = require_login();
$pdo = db();

switch ($_SERVER['REQUEST_METHOD']) {
    case 'GET':
        $stmt = $pdo->query('SELECT id, created_at FROM alarm_broadcasts ORDER BY id DESC LIMIT 1');
        $row = $stmt->fetch();
        json_response(['latest' => $row ?: null]);
        break;

    case 'POST':
        require_state_changing_request();
        if (!in_array($operator['role'], ['admin', 'superadmin'], true)) {
            json_error('Solo un administrador puede enviar la alarma', 403);
        }
        $stmt = $pdo->prepare('INSERT INTO alarm_broadcasts (created_by) VALUES (?)');
        $stmt->execute([$operator['id']]);
        json_response(['id' => (int)$pdo->lastInsertId()]);
        break;

    default:
        json_error('Método no permitido', 405);
}
