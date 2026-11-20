-- Links privados del reporte de pauta para el cliente final (pauta.html → pestaña "Reporte cliente").
-- Ejecutar una sola vez. Varios links por cliente de pauta (ej. uno en tiempo real y varios de períodos cerrados).
-- El token crudo nunca se guarda, solo su hash (mismo patrón que organic_lead_share_links / content_batches).
--   mode = 'range' → período fijo (date_from..date_to). mode = 'live' → siempre el período en curso, en tiempo real.
CREATE TABLE IF NOT EXISTS pauta_report_links (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    pauta_client_id VARCHAR(32) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    mode ENUM('range','live') NOT NULL DEFAULT 'live',
    date_from DATE NULL,
    date_to DATE NULL,
    title VARCHAR(190) NOT NULL DEFAULT '',
    message TEXT NULL,
    lead_goal INT UNSIGNED NULL,
    created_by INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pauta_report_token (token_hash),
    KEY idx_pauta_report_client (pauta_client_id),
    CONSTRAINT fk_pauta_report_client FOREIGN KEY (pauta_client_id) REFERENCES pauta_clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_pauta_report_operator FOREIGN KEY (created_by) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
