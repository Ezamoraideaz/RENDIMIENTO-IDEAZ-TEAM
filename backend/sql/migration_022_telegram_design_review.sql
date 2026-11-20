-- Migración 022 — Revisión de piezas con IA vía bot de Telegram
-- (backend/webhook/telegram.php + backend/cron/process_design_reviews.php).
-- Ejecutar una sola vez en instalaciones existentes (también agregado a schema.sql).

-- Grupo de Telegram <-> cliente (se vincula con el comando /vincular <slug> dentro del grupo)
CREATE TABLE IF NOT EXISTS telegram_groups (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    client_id INT UNSIGNED NOT NULL,
    title VARCHAR(190) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_telegram_groups_chat (chat_id),
    CONSTRAINT fk_telegram_groups_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Quién es CM o PM: se compara match_text (sin mayúsculas) contra el @usuario + nombre + apellido
-- de Telegram de quien escribe. client_id NULL = aplica a todas las marcas.
-- Quien no coincida con ninguna regla se trata como diseñador.
CREATE TABLE IF NOT EXISTS telegram_role_rules (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    role ENUM('cm','pm') NOT NULL,
    match_text VARCHAR(100) NOT NULL,
    client_id INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_telegram_role_rules_client (client_id),
    CONSTRAINT fk_telegram_role_rules_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO telegram_role_rules (role, match_text, client_id)
SELECT 'cm', 'brenda', NULL FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM telegram_role_rules WHERE role='cm' AND match_text='brenda' AND client_id IS NULL);
INSERT INTO telegram_role_rules (role, match_text, client_id)
SELECT 'cm', 'zharick', NULL FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM telegram_role_rules WHERE role='cm' AND match_text='zharick' AND client_id IS NULL);
INSERT INTO telegram_role_rules (role, match_text, client_id)
SELECT 'pm', 'andrea', NULL FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM telegram_role_rules WHERE role='pm' AND match_text='andrea' AND client_id IS NULL);

-- Una revisión = un envío del diseñador (1 mensaje o 1 álbum) = 1 post del cronograma.
-- status: collecting (álbum sin # todavía) | pending | processing | done | failed | ignored
CREATE TABLE IF NOT EXISTS design_reviews (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    chat_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    media_group_id VARCHAR(64) NULL,
    from_user_id BIGINT NOT NULL,
    from_name VARCHAR(190) NOT NULL DEFAULT '',
    post_number INT UNSIGNED NULL,
    pub_day TINYINT UNSIGNED NULL,
    caption TEXT NULL,
    version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    status ENUM('collecting','pending','processing','done','failed','ignored') NOT NULL DEFAULT 'pending',
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    sheet_tab VARCHAR(100) NULL,
    score TINYINT UNSIGNED NULL,
    report_json MEDIUMTEXT NULL,
    error TEXT NULL,
    report_message_id BIGINT NULL,
    claimed_at DATETIME NULL,
    last_file_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME NULL,
    KEY idx_design_reviews_status (status, last_file_at),
    KEY idx_design_reviews_group (chat_id, media_group_id),
    KEY idx_design_reviews_post (client_id, post_number),
    CONSTRAINT fk_design_reviews_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS design_review_files (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    review_id INT UNSIGNED NOT NULL,
    tg_file_id VARCHAR(255) NOT NULL,
    kind ENUM('image','video') NOT NULL,
    mime VARCHAR(100) NULL,
    size_bytes BIGINT UNSIGNED NULL,
    file_name VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_design_review_files_review (review_id),
    CONSTRAINT fk_design_review_files_review FOREIGN KEY (review_id) REFERENCES design_reviews(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Auditoría de los botones de CM/PM (solo comunicación; no dispara acciones en Trello ni en el sistema)
CREATE TABLE IF NOT EXISTS design_review_events (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    review_id INT UNSIGNED NOT NULL,
    telegram_user_id BIGINT NOT NULL,
    user_name VARCHAR(190) NOT NULL DEFAULT '',
    role ENUM('cm','pm') NOT NULL,
    action ENUM('approve','adjust','comment') NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_design_review_events_review (review_id),
    CONSTRAINT fk_design_review_events_review FOREIGN KEY (review_id) REFERENCES design_reviews(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
