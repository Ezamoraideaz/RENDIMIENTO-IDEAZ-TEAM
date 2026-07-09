<?php
require_once __DIR__ . '/../bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_body();
$email = trim($input['email'] ?? '');
$password = (string)($input['password'] ?? '');

if ($email === '' || $password === '') {
    json_error('Email y contraseña son requeridos', 400);
}

$stmt = db()->prepare('SELECT id, email, name, password_hash, role, trello_member_id, active FROM operators WHERE email = ?');
$stmt->execute([$email]);
$operator = $stmt->fetch();

if (!$operator || !password_verify($password, $operator['password_hash'])) {
    json_error('Credenciales inválidas', 401);
}
if ((int)$operator['active'] !== 1) {
    json_error('Usuario desactivado. Contacta al administrador.', 403);
}

session_regenerate_id(true);
$_SESSION['operator_id'] = $operator['id'];
$_SESSION['login_day'] = bogota_today();

json_response([
    'operator' => [
        'id'               => $operator['id'],
        'email'            => $operator['email'],
        'name'             => $operator['name'],
        'role'             => $operator['role'],
        'trello_member_id' => $operator['trello_member_id'],
    ],
    'csrf_token' => csrf_token(),
]);
