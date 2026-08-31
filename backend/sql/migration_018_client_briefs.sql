-- Migración 018 — módulo "Briefs" (pestaña dentro de Atención al Cliente).
-- Una fila por (cliente, tipo de brief): Sitio web / Mercadeo digital / Branding.
-- Mismo patrón de link público que organic_lead_share_links (token_hash, el
-- crudo nunca se guarda) pero con las respuestas del formulario en JSON.
-- Ejecutar una sola vez en instalaciones existentes (ya cubierto en schema.sql
-- para instalaciones nuevas).

CREATE TABLE IF NOT EXISTS client_briefs (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    brief_type ENUM('sitio_web','marketing_digital','branding') NOT NULL,
    token_hash CHAR(64) NULL,
    status ENUM('pending','filled') NOT NULL DEFAULT 'pending',
    answers JSON NULL,
    filled_by_name VARCHAR(190) NULL,
    filled_by_email VARCHAR(190) NULL,
    filled_at DATETIME NULL,
    created_by INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_client_briefs_token (token_hash),
    UNIQUE KEY uq_client_briefs_type (client_id, brief_type),
    CONSTRAINT fk_client_briefs_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_client_briefs_operator FOREIGN KEY (created_by) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
