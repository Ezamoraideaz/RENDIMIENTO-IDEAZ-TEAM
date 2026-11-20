-- Migración 013 — Notas ancladas a un segundo exacto del video, para piezas
-- en formato video del portal de aprobación (revisar.html). Se guardan junto
-- a la decisión, igual que comment/reason_tags.
-- Ejecutar una sola vez, DESPUÉS de migration_012_alarm_broadcast.sql

ALTER TABLE content_reviews
    ADD COLUMN time_notes JSON NULL AFTER reason_tags; -- [{"t": 4, "text": "El logo se ve muy chico"}, ...]
