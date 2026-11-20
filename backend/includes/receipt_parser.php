<?php
declare(strict_types=1);

// Interpreta el texto plano que devuelve Cloud Vision (google_vision.php)
// sobre una captura de comprobante de transferencia — pensado para los
// formatos de Bancolombia y Nequi, pero con heurísticas genéricas que
// también agarran otros bancos con suerte. Es "mejor esfuerzo": cualquier
// campo que no se pueda inferir queda en null y el usuario lo completa a
// mano en el formulario — nunca se bloquea la carga por esto.

const RECEIPT_SPANISH_MONTHS = [
    'enero' => 1, 'febrero' => 2, 'marzo' => 3, 'abril' => 4, 'mayo' => 5, 'junio' => 6,
    'julio' => 7, 'agosto' => 8, 'septiembre' => 9, 'octubre' => 10, 'noviembre' => 11, 'diciembre' => 12,
];
const RECEIPT_SPANISH_MONTHS_SHORT = [
    'ene' => 1, 'feb' => 2, 'mar' => 3, 'abr' => 4, 'may' => 5, 'jun' => 6,
    'jul' => 7, 'ago' => 8, 'sep' => 9, 'oct' => 10, 'nov' => 11, 'dic' => 12,
];

// "$ 150.000" / "$150.000,50" / "COP 150.000" → 150000.0 / 150000.5.
// Colombia usa "." como separador de miles y "," como decimal.
function receipt_parse_amount(string $text): ?float
{
    if (preg_match('/(?:\$|COP)\s*([\d]{1,3}(?:\.\d{3})*(?:,\d{1,2})?)/u', $text, $m)) {
        $normalized = str_replace('.', '', $m[1]);
        $normalized = str_replace(',', '.', $normalized);
        $value = (float)$normalized;
        return $value > 0 ? $value : null;
    }
    return null;
}

function receipt_parse_date(string $text): ?string
{
    // "15 de marzo de 2026"
    if (preg_match('/(\d{1,2})\s+de\s+(' . implode('|', array_keys(RECEIPT_SPANISH_MONTHS)) . ')\s+de\s+(\d{4})/ui', $text, $m)) {
        $month = RECEIPT_SPANISH_MONTHS[mb_strtolower($m[2])] ?? null;
        if ($month) {
            return receipt_format_date((int)$m[3], $month, (int)$m[1]);
        }
    }
    // "15 mar 2026" / "15 mar. 2026" (estilo Nequi)
    if (preg_match('/(\d{1,2})\s+(' . implode('|', array_keys(RECEIPT_SPANISH_MONTHS_SHORT)) . ')\.?\s+(\d{4})/ui', $text, $m)) {
        $month = RECEIPT_SPANISH_MONTHS_SHORT[mb_strtolower($m[2])] ?? null;
        if ($month) {
            return receipt_format_date((int)$m[3], $month, (int)$m[1]);
        }
    }
    // ISO "2026-03-15"
    if (preg_match('/(\d{4})-(\d{2})-(\d{2})/', $text, $m)) {
        return receipt_format_date((int)$m[1], (int)$m[2], (int)$m[3]);
    }
    // "15/03/2026" o "15-03-2026" (día/mes/año, convención colombiana)
    if (preg_match('#(\d{1,2})[/-](\d{1,2})[/-](\d{4})#', $text, $m)) {
        return receipt_format_date((int)$m[3], (int)$m[2], (int)$m[1]);
    }
    return null;
}

function receipt_format_date(int $year, int $month, int $day): ?string
{
    if (!checkdate($month, $day, $year)) {
        return null;
    }
    return sprintf('%04d-%02d-%02d', $year, $month, $day);
}

// Solo reconoce "Bancolombia" — es la única de las 3 cuentas fijas del
// módulo (Nu Bank/Bancolombia/PayPal) que puede aparecer mencionada en un
// comprobante. Un comprobante de Nequi no mapea a ninguna cuenta de la
// agencia (Nequi no es una de las 3), así que se deja sin seleccionar.
function receipt_parse_account(string $text): ?string
{
    return stripos($text, 'bancolombia') !== false ? 'Bancolombia' : null;
}

// Busca a quién se le transfirió, para prellenar el concepto. Reconoce
// líneas típicas "Para: NOMBRE", "A: NOMBRE", "Destinatario NOMBRE".
function receipt_parse_recipient(string $text): ?string
{
    $lines = preg_split('/\r?\n/', $text) ?: [];
    foreach ($lines as $i => $line) {
        if (preg_match('/^\s*(para|a|destinatario|beneficiario)\s*:?\s*(.+)$/ui', trim($line), $m)) {
            $name = trim($m[2]);
            if ($name !== '' && mb_strlen($name) <= 60) {
                return $name;
            }
            // El nombre a veces queda en la línea siguiente en vez de en la misma.
            if (isset($lines[$i + 1]) && trim($lines[$i + 1]) !== '') {
                return trim($lines[$i + 1]);
            }
        }
    }
    return null;
}

// Número de referencia/aprobación — se ofrece como nota, no como campo propio.
function receipt_parse_reference(string $text): ?string
{
    if (preg_match('/(?:n[uú]mero de referencia|n[uú]mero de aprobaci[oó]n|referencia)\s*:?\s*([A-Za-z0-9\-]{4,20})/ui', $text, $m)) {
        return $m[1];
    }
    return null;
}

// Combina todo lo anterior en la forma que espera expense_ocr.php.
function receipt_parse_text(string $text): array
{
    $recipient = receipt_parse_recipient($text);
    $reference = receipt_parse_reference($text);
    return [
        'amount' => receipt_parse_amount($text),
        'expense_date' => receipt_parse_date($text),
        'account' => receipt_parse_account($text),
        'concept' => $recipient ? "Transferencia a {$recipient}" : null,
        'notes' => $reference ? "Comprobante — referencia {$reference}" : null,
    ];
}
