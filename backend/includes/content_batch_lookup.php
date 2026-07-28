<?php
declare(strict_types=1);

// Compartido entre backend/public/review.php y backend/public/stream_media.php
// (ambos endpoints públicos, sin sesión — el cliente se autentica solo con el
// token del link, igual que password_resets).
function content_review_find_batch(PDO $pdo, string $rawToken): ?array
{
    $tokenHash = hash('sha256', $rawToken);
    $stmt = $pdo->prepare('
        SELECT b.id, b.client_id, b.label, b.expires_at, b.opened_at, b.completed_at,
               c.name AS client_name, c.logo_url AS client_logo_url, c.timezone AS client_timezone
        FROM content_batches b
        JOIN clients c ON c.id = b.client_id
        WHERE b.token_hash = ?
    ');
    $stmt->execute([$tokenHash]);
    $batch = $stmt->fetch();
    return $batch ?: null;
}
