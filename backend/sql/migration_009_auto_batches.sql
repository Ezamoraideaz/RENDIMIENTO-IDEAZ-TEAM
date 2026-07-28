-- Migración 009 — Vínculo cliente↔tablero de Trello para la tanda automática
-- Ejecutar una sola vez (phpMyAdmin o mysql CLI), DESPUÉS de migration_008_content_approvals.sql

ALTER TABLE clients ADD COLUMN trello_board_id VARCHAR(64) NULL AFTER sheet_id;
