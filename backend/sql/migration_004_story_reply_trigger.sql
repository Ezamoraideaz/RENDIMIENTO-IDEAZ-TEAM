-- Migración 004 — Nuevo disparador "Respuesta a historia de Instagram"
-- Ejecutar una sola vez, DESPUÉS de migration_003_password_resets.sql

ALTER TABLE flow_triggers
    MODIFY COLUMN trigger_type ENUM('keyword','comment_on_post','new_conversation','story_reply') NOT NULL;
