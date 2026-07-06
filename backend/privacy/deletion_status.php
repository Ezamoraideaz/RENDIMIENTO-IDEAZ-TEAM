<?php
declare(strict_types=1);

// Página de estado de una solicitud de eliminación de datos. Meta muestra esta URL a la
// persona (con ?code=...) para que confirme que su borrado se procesó. No indexable.
require_once __DIR__ . '/../bootstrap.php';

header('X-Robots-Tag: noindex, nofollow', true);

$code = trim($_GET['code'] ?? '');
$record = null;
if ($code !== '') {
    $stmt = db()->prepare('SELECT * FROM deletion_requests WHERE confirmation_code = ? LIMIT 1');
    $stmt->execute([$code]);
    $record = $stmt->fetch() ?: null;
}

header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Estado de eliminación de datos — IDEAZ</title>
    <style>
        body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0f172a; color:#e2e8f0; margin:0; display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
        .card { background:#1e293b; border:1px solid #334155; border-radius:16px; padding:32px; max-width:520px; width:100%; }
        h1 { font-size:1.25rem; margin:0 0 16px; }
        .badge { display:inline-block; padding:4px 12px; border-radius:999px; font-size:.8rem; font-weight:600; }
        .ok { background:#065f46; color:#d1fae5; }
        .warn { background:#78350f; color:#fed7aa; }
        .muted { color:#94a3b8; font-size:.9rem; line-height:1.6; }
        code { background:#0f172a; padding:2px 6px; border-radius:6px; color:#c7d2fe; }
        dl { display:grid; grid-template-columns:auto 1fr; gap:8px 16px; margin:20px 0; font-size:.9rem; }
        dt { color:#94a3b8; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Solicitud de eliminación de datos</h1>
        <?php if ($record): ?>
            <p>
                <span class="badge ok">Procesada</span>
            </p>
            <dl>
                <dt>Código de confirmación</dt>
                <dd><code><?= htmlspecialchars($record['confirmation_code'], ENT_QUOTES) ?></code></dd>
                <dt>Fecha</dt>
                <dd><?= htmlspecialchars((string)$record['requested_at'], ENT_QUOTES) ?></dd>
                <dt>Estado</dt>
                <dd><?= htmlspecialchars((string)$record['status'], ENT_QUOTES) ?></dd>
            </dl>
            <p class="muted">
                Tus datos de conversación (identificador, mensajes e historial asociados a esta
                cuenta) fueron eliminados de nuestros sistemas. Si tienes dudas, contáctanos en
                <a href="mailto:web@marketingdigitalideaz.com" style="color:#c7d2fe;">web@marketingdigitalideaz.com</a>.
            </p>
        <?php else: ?>
            <p><span class="badge warn">No encontrada</span></p>
            <p class="muted">
                No encontramos una solicitud de eliminación con ese código de confirmación.
                Si crees que es un error, escríbenos a
                <a href="mailto:web@marketingdigitalideaz.com" style="color:#c7d2fe;">web@marketingdigitalideaz.com</a>
                indicando tu código.
            </p>
        <?php endif; ?>
    </div>
</body>
</html>
