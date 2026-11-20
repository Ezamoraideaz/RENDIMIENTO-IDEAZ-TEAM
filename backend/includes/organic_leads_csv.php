<?php
declare(strict_types=1);

// Export CSV compartido entre el endpoint autenticado (api/organic_leads.php)
// y el portal público sin sesión (public/organic_leads_public.php). Agrega BOM
// UTF-8 al inicio para que Excel muestre bien tildes/ñ al abrir el archivo
// directamente (sin esto, Excel asume Latin-1 y las rompe).
function organic_leads_stream_csv(array $leads, string $clientName): void
{
    $filename = 'leads-' . (preg_replace('/[^a-z0-9]+/i', '-', $clientName) ?: 'cliente') . '.csv';
    header('Content-Type: text/csv; charset=UTF-8');
    header('Content-Disposition: attachment; filename="' . $filename . '"');

    // Columnas "extra" variables según lo que traiga cada archivo importado —
    // se arma la unión de todas las que aparezcan en los leads exportados.
    $extraKeys = [];
    foreach ($leads as $lead) {
        $extra = json_decode($lead['extra'] ?? '', true) ?: [];
        foreach (array_keys($extra) as $k) {
            if (!in_array($k, $extraKeys, true)) {
                $extraKeys[] = $k;
            }
        }
    }

    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");
    fputcsv($out, array_merge(['Fecha', 'Nombre', 'Correo', 'Teléfono', 'Fuente', 'Motivo', 'Importado'], $extraKeys));
    foreach ($leads as $lead) {
        $extra = json_decode($lead['extra'] ?? '', true) ?: [];
        $row = [$lead['lead_date'] ?? '', $lead['name'], $lead['email'], $lead['phone'], $lead['source'] ?? '', $lead['reason'] ?? '', $lead['created_at']];
        foreach ($extraKeys as $k) {
            $row[] = $extra[$k] ?? '';
        }
        fputcsv($out, $row);
    }
    fclose($out);
    exit;
}
