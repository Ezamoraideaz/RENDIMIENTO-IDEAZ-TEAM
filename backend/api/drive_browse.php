<?php
require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/google_drive.php';

// Lectura/escritura de Drive para el buscador de carpetas ARTES (agenda.js),
// el creador de estructura (configuracion.html) y la tanda automática de
// aprobaciones (aprobaciones.js) — todo vía la cuenta de servicio compartida
// (google_drive.php), no OAuth por usuario. Antes cada CM/PM tenía que
// conectar su propia cuenta de Google desde el navegador y reconectarla cada
// hora (el flujo OAuth implícito de Google nunca entrega refresh_token); con
// esto nadie ve una pantalla de conexión de Google — el backend pide los
// tokens él solo, siempre que la carpeta esté compartida con el
// client_email de la cuenta de servicio (ver CLAUDE.md, sección Puesta en
// marcha, paso 8).
require_role(['superadmin', 'admin', 'cm', 'agenda_full', 'agenda_member']);

$method = $_SERVER['REQUEST_METHOD'];

switch ($method) {
    case 'GET':
        $action = $_GET['action'] ?? '';

        if ($action === 'list_subfolders') {
            $parentId = trim((string)($_GET['parent_id'] ?? ''));
            if ($parentId === '') {
                json_error('parent_id es requerido', 400);
            }
            $files = google_drive_list_subfolders($parentId);
            if ($files === null) {
                $detail = google_drive_last_error();
                json_error('No se pudo leer Drive' . ($detail ? " — {$detail}" : ' — revisa que la carpeta esté compartida con la cuenta de servicio'), 502);
            }
            json_response(['files' => $files]);
            break;
        }

        if ($action === 'list_files') {
            $folderId = trim((string)($_GET['folder_id'] ?? ''));
            if ($folderId === '') {
                json_error('folder_id es requerido', 400);
            }
            $files = google_drive_list_files($folderId);
            if ($files === null) {
                $detail = google_drive_last_error();
                json_error('No se pudo leer Drive' . ($detail ? " — {$detail}" : ' — revisa que la carpeta esté compartida con la cuenta de servicio'), 502);
            }
            json_response(['files' => $files]);
            break;
        }

        json_error('action inválida', 400);
        break;

    case 'POST':
        require_state_changing_request();
        $input = json_body();
        $action = $input['action'] ?? '';

        if ($action === 'create_folder') {
            $name = trim((string)($input['name'] ?? ''));
            $parentId = trim((string)($input['parent_id'] ?? ''));
            if ($name === '' || $parentId === '') {
                json_error('name y parent_id son requeridos', 400);
            }
            $id = google_drive_create_folder($name, $parentId);
            if ($id === null) {
                $detail = google_drive_last_error();
                json_error('No se pudo crear la carpeta en Drive' . ($detail ? " — {$detail}" : ' — revisa que la carpeta padre esté compartida como Editor con la cuenta de servicio'), 502);
            }
            json_response(['folder' => ['id' => $id, 'name' => $name]]);
            break;
        }

        json_error('action inválida', 400);
        break;

    default:
        json_error('Método no permitido', 405);
}
