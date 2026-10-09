<?php
declare(strict_types=1);

// Reglas de negocio de la revisión de piezas por Telegram — funciones puras
// (sin BD ni red) para el mensaje del diseñador y la fila del cronograma.
//
// Mensaje del diseñador:  "#5 - 18 REEL FEED ..."
//   #5  -> ID del post (número en la columna A del cronograma: "#5", "Post 5")
//   18  -> día de publicación; el mes se deduce porque la publicación es siempre futura
//
// Cronograma (una pestaña por mes): A=post, B=formato, C=día, D=tema/referencia/
// indicaciones para el diseñador, E=mensaje de arte (textos DENTRO de la pieza),
// F=copy del post (con gancho y CTA), G=hashtags.

// Devuelve ['post' => ?int, 'day' => ?int, 'hint' => string]. post=null si no hay "#número".
function review_parse_caption(string $caption): array
{
    $out = ['post' => null, 'day' => null, 'hint' => ''];
    if (!preg_match('/#\s*(\d{1,4})\b(?:\s*[-–—:.,]?\s*(\d{1,2})\b)?/u', $caption, $m, PREG_OFFSET_CAPTURE)) {
        return $out;
    }
    $out['post'] = (int)$m[1][0];
    if (isset($m[2][0]) && $m[2][0] !== '') {
        $day = (int)$m[2][0];
        $out['day'] = ($day >= 1 && $day <= 31) ? $day : null;
    }
    $end = $m[0][1] + strlen($m[0][0]);
    $out['hint'] = trim((string)preg_replace('/^[\s\-–—:.,]+/u', '', substr($caption, $end)));
    return $out;
}

// Mes (primer día) al que pertenece un día de publicación, sabiendo que la fecha
// es siempre futura: si el día es >= al de hoy es este mes; si ya pasó, el siguiente.
// Si ese mes no tiene ese día (ej. 31 en un mes de 30), avanza al próximo que sí.
function review_resolve_month(int $day, DateTimeImmutable $now): DateTimeImmutable
{
    $first = $now->modify('first day of this month')->setTime(0, 0);
    if ($day < (int)$now->format('j')) {
        $first = $first->modify('first day of next month');
    }
    for ($i = 0; $i < 3; $i++) {
        if ($day <= (int)$first->format('t')) {
            return $first;
        }
        $first = $first->modify('first day of next month');
    }
    return $first;
}

function review_month_name_es(int $month): string
{
    static $names = [1 => 'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
    return $names[$month] ?? '';
}

// Número de post a partir de la columna A: "#1", "Post 1", "POST #12" o solo "7".
// Devuelve null para encabezados y separadores ("PRIMERA SEMANA", vacíos).
function review_sheet_post_number(string $colA): ?int
{
    $colA = trim($colA);
    if (preg_match('/(?:post|#)\s*#?\s*(\d+)/i', $colA, $m)) {
        return (int)$m[1];
    }
    if (preg_match('/^\d+$/', $colA)) {
        return (int)$colA;
    }
    return null;
}

// Día (1-31) dentro de la celda de la columna C ("18", "Viernes 18", "18/07").
function review_sheet_day(string $colC): ?int
{
    if (preg_match('/\b(\d{1,2})\b/', $colC, $m)) {
        $d = (int)$m[1];
        return ($d >= 1 && $d <= 31) ? $d : null;
    }
    return null;
}

// Busca la fila del post en las filas crudas de la pestaña. Si el número aparece
// más de una vez (p. ej. la numeración reinicia por semana), prefiere la fila cuyo
// día (columna C) coincide con el del mensaje. Devuelve null si no existe.
function review_find_row(array $values, int $post, ?int $day): ?array
{
    $matches = [];
    foreach ($values as $i => $row) {
        $n = review_sheet_post_number((string)($row[0] ?? ''));
        if ($n !== $post) {
            continue;
        }
        $matches[] = [
            'row_number' => $i + 1,
            'label'      => trim((string)($row[0] ?? '')),
            'format'     => trim((string)($row[1] ?? '')),
            'day_raw'    => trim((string)($row[2] ?? '')),
            'day'        => review_sheet_day((string)($row[2] ?? '')),
            'topic'      => trim((string)($row[3] ?? '')), // D
            'art_text'   => trim((string)($row[4] ?? '')), // E
            'copy'       => trim((string)($row[5] ?? '')), // F
            'hashtags'   => trim((string)($row[6] ?? '')), // G
        ];
    }
    if (!$matches) {
        return null;
    }
    if ($day !== null) {
        foreach ($matches as $m) {
            if ($m['day'] === $day) {
                return $m + ['duplicates' => count($matches)];
            }
        }
    }
    return $matches[0] + ['duplicates' => count($matches)];
}

// Semáforo del score: >=85 verde, 60-84 amarillo, <60 rojo.
function review_semaphore(int $score): array
{
    if ($score >= 85) {
        return ['🟢', 'Aprobable'];
    }
    if ($score >= 60) {
        return ['🟡', 'Con ajustes'];
    }
    return ['🔴', 'Requiere cambios'];
}
