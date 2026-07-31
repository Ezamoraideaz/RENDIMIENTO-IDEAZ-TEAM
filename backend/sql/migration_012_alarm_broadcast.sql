-- Migración 012 — Alarma manual: un admin/superadmin dispara un aviso a
-- todos los usuarios logueados en ese momento, además del recordatorio
-- automático de las 5pm que ya corre solo, por reloj, en cada navegador.
-- Ejecutar una sola vez (phpMyAdmin o mysql CLI), DESPUÉS de migration_011_drive_approval_sync.sql

CREATE TABLE IF NOT EXISTS alarm_broadcasts (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    created_by INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_alarm_broadcasts_operator FOREIGN KEY (created_by) REFERENCES operators(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
