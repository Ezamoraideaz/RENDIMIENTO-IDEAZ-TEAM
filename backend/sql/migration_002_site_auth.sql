-- Migración 002 — Login global del sitio + configuración centralizada
-- Ejecutar una sola vez en la misma BD del módulo Atención al Cliente
-- (phpMyAdmin o mysql CLI), DESPUÉS de haber corrido schema.sql.

-- 1) La tabla operators pasa a ser la tabla de usuarios de todo el sitio.
--    Roles nuevos: superadmin (dueño), admin (todo menos gestión de usuarios),
--    agenda_full, agenda_member (bloqueado a su miembro de Trello), cm.
--    Se conserva 'agent' (rol histórico del módulo Atención al Cliente).
ALTER TABLE operators
    ADD COLUMN name VARCHAR(150) NOT NULL DEFAULT '' AFTER email,
    ADD COLUMN trello_member_id VARCHAR(64) NULL AFTER role,
    ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1 AFTER trello_member_id,
    MODIFY COLUMN role ENUM('superadmin','admin','agent','agenda_full','agenda_member','cm') NOT NULL DEFAULT 'agenda_full';

-- 2) Credenciales de integraciones (Trello, Google Drive) cifradas con AES-256-GCM
--    (backend/includes/crypto.php). Un solo juego compartido para toda la agencia.
CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(100) NOT NULL PRIMARY KEY,
    value_encrypted TEXT NOT NULL,
    iv VARCHAR(64) NOT NULL,
    updated_by INT UNSIGNED NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_app_settings_operator FOREIGN KEY (updated_by) REFERENCES operators(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3) Configuración por tablero de Trello (antes localStorage.ideaz_projects + ideaz_drive_folders)
CREATE TABLE IF NOT EXISTS project_settings (
    board_id VARCHAR(64) NOT NULL PRIMARY KEY,
    budget DECIMAL(14,2) NOT NULL DEFAULT 0,
    revenue DECIMAL(14,2) NOT NULL DEFAULT 0,
    currency VARCHAR(8) NOT NULL DEFAULT 'COP',
    hours_estimated DECIMAL(8,2) NOT NULL DEFAULT 0,
    alias VARCHAR(190) NOT NULL DEFAULT '',
    category VARCHAR(190) NOT NULL DEFAULT '',
    period VARCHAR(16) NOT NULL DEFAULT '',
    project_type VARCHAR(64) NOT NULL DEFAULT '',
    drive_folder_id VARCHAR(128) NOT NULL DEFAULT '',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4) Configuración por miembro del equipo (antes ideaz_rates + ideaz_members + ideaz_roles)
CREATE TABLE IF NOT EXISTS member_settings (
    member_id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(190) NOT NULL DEFAULT '',
    member_role VARCHAR(32) NOT NULL DEFAULT '',
    hourly_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
