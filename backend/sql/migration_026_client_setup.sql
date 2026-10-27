-- Migración 026 — Asistente "Configurar cliente" (configurar-cliente.html).
-- Casilla manual "ya vinculé el grupo de Telegram": el bot solo conoce el grupo
-- cuando alguien escribe /vincular allí, así que el asistente deja que el CM/PM
-- lo marque como hecho. Ejecutar una sola vez (también agregado a schema.sql).
ALTER TABLE clients ADD COLUMN telegram_setup_done TINYINT(1) NOT NULL DEFAULT 0 AFTER trello_board_id;
