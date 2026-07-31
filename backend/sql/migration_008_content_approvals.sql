-- Migración 008 — Portal de Aprobación de Contenido (módulo aprobaciones)
-- Ejecutar una sola vez (phpMyAdmin o mysql CLI), DESPUÉS de migration_007_ai_context.sql

ALTER TABLE clients ADD COLUMN sheet_id VARCHAR(100) NULL AFTER ai_context;

-- Una "tanda" de contenido para revisión (1 pieza puntual o varias). El token
-- crudo nunca se guarda, solo su hash (mismo patrón que password_resets). El
-- token/vencimiento quedan NULL mientras la tanda es un borrador (piezas
-- cargándose) — se completan recién cuando el equipo pulsa "Generar link".
CREATE TABLE IF NOT EXISTS content_batches (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    label VARCHAR(190) NOT NULL,
    token_hash CHAR(64) NULL,
    expires_at DATETIME NULL,
    created_by INT UNSIGNED NOT NULL,
    opened_at DATETIME NULL,
    completed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_content_batches_token_hash (token_hash),
    KEY idx_content_batches_client (client_id, created_at),
    CONSTRAINT fk_content_batches_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_content_batches_operator FOREIGN KEY (created_by) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS content_items (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    batch_id INT UNSIGNED NOT NULL,
    trello_card_id VARCHAR(64) NULL,
    type ENUM('feed','story','reel','carousel') NOT NULL,
    caption TEXT NULL,
    scheduled_at DATETIME NULL,
    media JSON NOT NULL,          -- [{ "url": "...", "order": 0 }, ...]
    position INT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('pending','approved','changes_requested') NOT NULL DEFAULT 'pending',
    decided_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_content_items_batch (batch_id, position),
    CONSTRAINT fk_content_items_batch FOREIGN KEY (batch_id) REFERENCES content_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Registro de cada decisión, separado del estado actual de la pieza, para que
-- una pieza rechazada → corregida → vuelta a revisar conserve el historial completo.
CREATE TABLE IF NOT EXISTS content_reviews (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    content_item_id INT UNSIGNED NOT NULL,
    decision ENUM('approved','changes_requested') NOT NULL,
    comment TEXT NULL,
    reason_tags JSON NULL,        -- ["Cambiar el copy", "Ortografía", ...] — solo si decision = changes_requested
    reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewer_ip VARCHAR(45) NULL,
    KEY idx_content_reviews_item (content_item_id),
    CONSTRAINT fk_content_reviews_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
