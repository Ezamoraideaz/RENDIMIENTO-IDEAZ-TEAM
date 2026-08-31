<?php
declare(strict_types=1);

require_once __DIR__ . '/../bootstrap.php';
require_once __DIR__ . '/../includes/google_vision.php';
require_once __DIR__ . '/../includes/receipt_parser.php';

// Lee un comprobante de transferencia (foto/captura de Bancolombia o Nequi)
// con Cloud Vision y devuelve los campos que se pudieron reconocer, para que
// el formulario de "Registrar egreso" (js/egresos.js) se prellene solo. No
// guarda nada — es una utilidad de solo lectura sobre la imagen que manda el
// usuario, el resultado siempre queda editable antes de enviar el egreso.

require_expenses_access();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

require_state_changing_request();

const EXPENSE_OCR_ALLOWED_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const EXPENSE_OCR_MAX_BYTES = 15 * 1024 * 1024;

if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    json_error('Archivo requerido', 400);
}
$file = $_FILES['file'];
if ($file['size'] <= 0 || $file['size'] > EXPENSE_OCR_MAX_BYTES) {
    json_error('El archivo pesa demasiado', 400);
}
$ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
if (!in_array($ext, EXPENSE_OCR_ALLOWED_EXT, true)) {
    json_error('Formato no soportado — usa PNG, JPG o WEBP', 400);
}
if (!is_uploaded_file($file['tmp_name'])) {
    json_error('Archivo inválido', 400);
}

$bytes = file_get_contents($file['tmp_name']);
if ($bytes === false) {
    json_error('No se pudo leer el archivo', 500);
}

$text = google_vision_extract_text($bytes);
if ($text === null) {
    json_error('No se pudo leer la imagen: ' . (google_vision_last_error() ?? 'error desconocido de Vision API'), 502);
}

$fields = receipt_parse_text($text);
json_response(['fields' => $fields, 'raw_text' => mb_substr($text, 0, 2000)]);
