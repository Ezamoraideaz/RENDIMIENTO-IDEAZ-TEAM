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

$stmt = db()->prepare('SELECT id, email, password_hash, role FROM operators WHERE email = ?');
$stmt->execute([$email]);
$operator = $stmt->fetch();

if (!$operator || !password_verify($password, $operator['password_hash'])) {
    json_error('Credenciales inválidas', 401);
}

session_regenerate_id(true);
$_SESSION['operator_id'] = $operator['id'];

json_response([
    'operator'   => ['id' => $operator['id'], 'email' => $operator['email'], 'role' => $operator['role']],
    'csrf_token' => csrf_token(),
]);
