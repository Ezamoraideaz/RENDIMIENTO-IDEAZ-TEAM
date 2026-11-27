-- Módulo Accesos (bóveda de credenciales). Correr una sola vez en phpMyAdmin.
-- Las fechas se guardan en UTC. Usuario, contraseña y notas van cifrados en `payload`.

CREATE TABLE IF NOT EXISTS vault_items (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uid CHAR(32) NOT NULL,                  -- ata el cifrado a esta fila
    brand_name VARCHAR(150) NOT NULL,
    category VARCHAR(20) NOT NULL,
    title VARCHAR(190) NOT NULL,
    url VARCHAR(500) NOT NULL DEFAULT '',
    owner VARCHAR(150) NOT NULL DEFAULT '',
    payload TEXT NOT NULL,                  -- datos cifrados con la clave propia del registro
    wrapped_key VARCHAR(255) NOT NULL,      -- esa clave, cifrada con la clave maestra
    created_by INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    deleted_at DATETIME NULL,               -- papelera de 30 días
    UNIQUE KEY uq_vault_items_uid (uid),
    KEY ix_vault_items_brand (brand_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Autenticador de cada superadmin
CREATE TABLE IF NOT EXISTS vault_totp (
    operator_id INT UNSIGNED PRIMARY KEY,
    secret VARCHAR(255) NULL,               -- cifrado; NULL hasta confirmar
    pending_secret VARCHAR(255) NULL,       -- cifrado; mientras se activa
    last_step BIGINT UNSIGNED NOT NULL DEFAULT 0,  -- impide reutilizar un código
    recovery_hashes TEXT NULL,
    confirmed_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Registro de actividad (la aplicación solo inserta, nunca edita ni borra)
CREATE TABLE IF NOT EXISTS vault_audit (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    operator_id INT UNSIGNED NOT NULL,
    operator_name VARCHAR(190) NOT NULL,
    action VARCHAR(30) NOT NULL,
    item_id INT UNSIGNED NULL,
    item_label VARCHAR(350) NOT NULL DEFAULT '',
    reason VARCHAR(300) NOT NULL DEFAULT '',
    approver_name VARCHAR(190) NOT NULL DEFAULT '',  -- superadmin dueño del código usado
    ip VARCHAR(45) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL,
    KEY ix_vault_audit_fail (action, created_at),
    KEY ix_vault_audit_operator (operator_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
