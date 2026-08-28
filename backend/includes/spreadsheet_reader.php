<?php
declare(strict_types=1);

// Lector de Excel (.xlsx) y CSV para la importación de leads orgánicos, sin
// dependencias externas (no hay Composer en backend/). Un .xlsx es un zip con
// XML adentro (xl/sharedStrings.xml + xl/worksheets/sheetN.xml) — se lee con
// las extensiones estándar de PHP (ZipArchive + SimpleXML). Devuelve siempre
// filas como arrays de strings, alineadas por índice de columna (A=0, B=1…)
// para no desalinear datos cuando el archivo omite celdas vacías.

function read_spreadsheet_rows(string $tmpPath, string $originalName): array
{
    $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
    if ($ext === 'csv') {
        return read_csv_rows($tmpPath);
    }
    if ($ext === 'xlsx') {
        return read_xlsx_rows($tmpPath);
    }
    throw new RuntimeException('Formato no soportado. Sube un archivo .xlsx o .csv');
}

function read_csv_rows(string $path): array
{
    $sample = file_get_contents($path, false, null, 0, 4096) ?: '';
    $delimiter = substr_count($sample, ';') > substr_count($sample, ',') ? ';' : ',';

    $handle = fopen($path, 'r');
    if (!$handle) {
        throw new RuntimeException('No se pudo leer el archivo CSV');
    }
    // BOM UTF-8 al inicio (común en exports de Excel) rompe el primer
    // encabezado si no se descarta antes de leer la primera fila.
    $bom = fread($handle, 3);
    if ($bom !== "\xEF\xBB\xBF") {
        rewind($handle);
    }

    $rows = [];
    while (($row = fgetcsv($handle, 0, $delimiter)) !== false) {
        $rows[] = array_map(static fn($v) => trim((string)$v), $row);
    }
    fclose($handle);
    return $rows;
}

function read_xlsx_rows(string $path): array
{
    if (!class_exists('ZipArchive')) {
        throw new RuntimeException('El servidor no tiene la extensión ZipArchive de PHP habilitada, necesaria para leer archivos .xlsx');
    }
    $zip = new ZipArchive();
    if ($zip->open($path) !== true) {
        throw new RuntimeException('No se pudo abrir el archivo .xlsx (¿está corrupto?)');
    }

    $sharedStrings = xlsx_read_shared_strings($zip);
    $sheetName = xlsx_first_sheet_name($zip);
    if ($sheetName === null) {
        $zip->close();
        throw new RuntimeException('El archivo .xlsx no tiene ninguna hoja');
    }
    $xml = $zip->getFromName($sheetName);
    $zip->close();
    if ($xml === false) {
        throw new RuntimeException('No se pudo leer la hoja del archivo .xlsx');
    }

    $prevErr = libxml_use_internal_errors(true);
    $sheet = simplexml_load_string($xml);
    libxml_use_internal_errors($prevErr);
    if ($sheet === false || !isset($sheet->sheetData)) {
        throw new RuntimeException('El archivo .xlsx tiene un formato XML inválido');
    }

    $rows = [];
    foreach ($sheet->sheetData->row as $rowEl) {
        $rowIndex = [];
        $maxCol = -1;
        foreach ($rowEl->c as $cellEl) {
            $ref = (string)$cellEl['r'];
            $col = $ref !== '' ? xlsx_col_index($ref) : count($rowIndex);
            $type = (string)$cellEl['t'];
            if ($type === 's') {
                $value = $sharedStrings[(int)$cellEl->v] ?? '';
            } elseif ($type === 'inlineStr') {
                $value = (string)($cellEl->is->t ?? '');
            } else {
                $value = (string)$cellEl->v;
            }
            $rowIndex[$col] = trim($value);
            $maxCol = max($maxCol, $col);
        }
        $row = [];
        for ($i = 0; $i <= $maxCol; $i++) {
            $row[] = $rowIndex[$i] ?? '';
        }
        $rows[] = $row;
    }
    return $rows;
}

function xlsx_read_shared_strings(ZipArchive $zip): array
{
    $xml = $zip->getFromName('xl/sharedStrings.xml');
    if ($xml === false) {
        return []; // archivos sin texto compartido (todo numérico) no lo incluyen
    }
    $prevErr = libxml_use_internal_errors(true);
    $doc = simplexml_load_string($xml);
    libxml_use_internal_errors($prevErr);
    if ($doc === false) {
        return [];
    }
    $strings = [];
    foreach ($doc->si as $si) {
        // Concatena todo texto <t>, sea directo (<si><t>) o en runs de formato
        // (<si><r><t>...) — ambos casos son "todos los <t> descendientes".
        $texts = $si->xpath('.//*[local-name()="t"]');
        $strings[] = implode('', array_map('strval', $texts ?: []));
    }
    return $strings;
}

function xlsx_first_sheet_name(ZipArchive $zip): ?string
{
    $best = null;
    $bestNum = PHP_INT_MAX;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = $zip->getNameIndex($i);
        if ($name !== false && preg_match('#^xl/worksheets/sheet(\d+)\.xml$#', $name, $m)) {
            $num = (int)$m[1];
            if ($num < $bestNum) {
                $bestNum = $num;
                $best = $name;
            }
        }
    }
    return $best;
}

// Convierte una referencia de celda tipo "C5" al índice de columna base-0 (C -> 2)
function xlsx_col_index(string $cellRef): int
{
    preg_match('/^([A-Z]+)/', $cellRef, $m);
    $letters = $m[1] ?? 'A';
    $index = 0;
    foreach (str_split($letters) as $ch) {
        $index = $index * 26 + (ord($ch) - ord('A') + 1);
    }
    return $index - 1;
}

// Detecta qué columna del encabezado es nombre/correo/teléfono por sinónimos
// comunes (mismo criterio que flatten_ad_lead_fields() en includes/ad_leads.php).
function map_lead_columns(array $headers): array
{
    $normalized = array_map('organic_lead_normalize_header', $headers);
    $map = ['name' => null, 'email' => null, 'phone' => null];
    $synonyms = [
        'name'  => ['nombre', 'nombre completo', 'name', 'full name', 'cliente', 'contacto'],
        'email' => ['correo', 'correo electronico', 'email', 'e-mail', 'mail'],
        'phone' => ['telefono', 'celular', 'whatsapp', 'phone', 'phone number', 'numero', 'numero de telefono'],
    ];
    foreach ($synonyms as $field => $candidates) {
        foreach ($normalized as $i => $h) {
            if (in_array($h, $candidates, true)) {
                $map[$field] = $i;
                break;
            }
        }
    }
    return $map;
}

function organic_lead_normalize_header(string $s): string
{
    $s = mb_strtolower(trim($s));
    return strtr($s, ['á' => 'a', 'é' => 'e', 'í' => 'i', 'ó' => 'o', 'ú' => 'u', 'ñ' => 'n', 'ü' => 'u']);
}
