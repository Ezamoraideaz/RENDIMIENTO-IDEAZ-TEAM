-- Migración 003 — Recuperación de contraseña por correo
-- Ejecutar una sola vez (phpMyAdmin o mysql CLI), DESPUÉS de migration_002_site_auth.sql

-- Tokens de recuperación de contraseña. El token crudo (enviado por correo) nunca
-- se guarda: solo su hash sha256. Expira a la hora y es de un solo uso.
CREATE TABLE IF NOT EXISTS password_resets (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    operator_id INT UNSIGNED NOT NULL,
    token_hash CHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    requested_by ENUM('self','admin') NOT NULL DEFAULT 'self',
    requested_ip VARCHAR(45) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_password_resets_token_hash (token_hash),
    KEY idx_password_resets_operator_created (operator_id, created_at),
    CONSTRAINT fk_password_resets_operator FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
