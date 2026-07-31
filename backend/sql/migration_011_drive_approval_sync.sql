-- Migración 011 — Mover automáticamente el contenido aprobado de "Para
-- aprobación" (carpeta externa por marca) hacia ARTES/año/mes/POST # al
-- momento en que el cliente aprueba en el portal público, sin que el
-- diseñador tenga que buscarlo y moverlo a mano en Drive.
-- Ejecutar una sola vez (phpMyAdmin o mysql CLI), DESPUÉS de migration_010_pauta_clients.sql

ALTER TABLE clients ADD COLUMN drive_approval_folder_id VARCHAR(128) NULL AFTER sheet_id;

ALTER TABLE content_items ADD COLUMN post_number SMALLINT UNSIGNED NULL AFTER type;
ALTER TABLE content_items ADD COLUMN drive_move_status ENUM('pending','moved','error','skipped') NOT NULL DEFAULT 'pending' AFTER decided_at;
ALTER TABLE content_items ADD COLUMN drive_move_error TEXT NULL AFTER drive_move_status;
