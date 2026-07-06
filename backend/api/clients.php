<?php
require_once __DIR__ . '/../bootstrap.php';

require_login();

$method = $_SERVER['REQUEST_METHOD'];
$pdo = db();

function slugify(string $name): string
{
    $slug = strtolower(trim($name));
    $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
    return trim($slug, '-') ?: bin2hex(random_bytes(4));
}

switch ($method) {
    case 'GET':
        $stmt = $pdo->query('
            SELECT c.id, c.name, c.slug, c.logo_url, c.timezone, c.status, c.created_at,
                   (SELECT COUNT(*) FROM social_accounts sa WHERE sa.client_id = c.id AND sa.status = "active") AS connected_accounts
            FROM clients c
            ORDER BY c.name ASC
        ');
        json_response(['clients' => $stmt->fetchAll()]);
        break;

    case 'POST':
        require_state_changing_request();
        $input = json_body();
        $name = trim($input['name'] ?? '');
        if ($name === '') {
            json_error('El nombre del cliente es requerido', 400);
        }
        $timezone = trim($input['timezone'] ?? '') ?: 'America/Mexico_City';
        $slug = slugify($name);

        $stmt = $pdo->prepare('INSERT INTO clients (name, slug, timezone) VALUES (?, ?, ?)');
        try {
            $stmt->execute([$name, $slug, $timezone]);
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                $slug .= '-' . bin2hex(random_bytes(2));
                $stmt->execute([$name, $slug, $timezone]);
            } else {
                throw $e;
            }
        }
        json_response(['id' => (int)$pdo->lastInsertId(), 'name' => $name, 'slug' => $slug], 201);
        break;

    case 'PUT':
        require_state_changing_request();
        $input = json_body();
        $id = (int)($input['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $fields = [];
        $values = [];
        foreach (['name', 'logo_url', 'timezone', 'status'] as $field) {
            if (array_key_exists($field, $input)) {
                $fields[] = "{$field} = ?";
                $values[] = $input[$field];
            }
        }
        if (!$fields) {
            json_error('Nada para actualizar', 400);
        }
        $values[] = $id;
        $stmt = $pdo->prepare('UPDATE clients SET ' . implode(', ', $fields) . ' WHERE id = ?');
        $stmt->execute($values);
        json_response(['ok' => true]);
        break;

    case 'DELETE':
        require_state_changing_request();
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            json_error('id requerido', 400);
        }
        $stmt = $pdo->prepare('DELETE FROM clients WHERE id = ?');
        $stmt->execute([$id]);
        json_response(['ok' => true]);
        break;

    default:
        json_error('Método no permitido', 405);
}
