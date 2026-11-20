-- Migración 017 — Fuente del lead en Leads Orgánicos
-- Ejecutar una sola vez, DESPUÉS de migration_016_organic_leads_date_reason.sql

-- source: plataforma/origen del lead (Facebook, Instagram, WhatsApp, Referido,
-- Sitio web, etc.) — texto libre, no enum, porque varía mucho por cliente.
ALTER TABLE organic_leads
    ADD COLUMN source VARCHAR(100) NULL AFTER phone;
