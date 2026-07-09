-- Migración 006 — Nuevo disparador "Anuncio de Messenger" (Click-to-Messenger)
-- Ejecutar una sola vez, DESPUÉS de migration_005_ad_leads.sql

ALTER TABLE flow_triggers
    MODIFY COLUMN trigger_type ENUM('keyword','comment_on_post','new_conversation','story_reply','ad_message') NOT NULL;
