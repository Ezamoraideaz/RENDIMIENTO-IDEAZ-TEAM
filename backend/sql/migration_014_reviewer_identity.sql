-- Migración 014 — Identificación de revisores del portal de aprobación (sin
-- login, solo nombre + cargo declarado una vez por dispositivo) + bitácora
-- de actividad como material probatorio.
-- Ejecutar una sola vez, DESPUÉS de migration_013_video_time_notes.sql

ALTER TABLE content_reviews
    ADD COLUMN reviewer_name VARCHAR(190) NULL AFTER reviewer_ip,
    ADD COLUMN reviewer_role VARCHAR(190) NULL AFTER reviewer_name,
    ADD COLUMN reviewer_device_id VARCHAR(64) NULL AFTER reviewer_role,
    ADD COLUMN user_agent VARCHAR(400) NULL AFTER reviewer_device_id;

CREATE TABLE IF NOT EXISTS content_review_activity (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    batch_id INT UNSIGNED NOT NULL,
    content_item_id INT UNSIGNED NULL,
    event_type ENUM('opened','identified','decision') NOT NULL,
    reviewer_name VARCHAR(190) NULL,
    reviewer_role VARCHAR(190) NULL,
    reviewer_device_id VARCHAR(64) NULL,
    ip VARCHAR(45) NULL,
    user_agent VARCHAR(400) NULL,
    metadata JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_content_review_activity_batch (batch_id, created_at),
    CONSTRAINT fk_content_review_activity_batch FOREIGN KEY (batch_id) REFERENCES content_batches(id) ON DELETE CASCADE,
    CONSTRAINT fk_content_review_activity_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
