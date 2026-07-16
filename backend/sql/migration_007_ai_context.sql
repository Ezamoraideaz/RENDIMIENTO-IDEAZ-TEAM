-- Migración 007 — Contexto de negocio por cliente para el nodo/widget de IA
-- Ejecutar una sola vez, DESPUÉS de migration_006_ad_message_trigger.sql

ALTER TABLE clients ADD COLUMN ai_context TEXT NULL AFTER timezone;
