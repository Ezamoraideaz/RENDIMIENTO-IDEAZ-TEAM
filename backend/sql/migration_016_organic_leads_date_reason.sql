-- Migración 016 — Fecha y motivo del lead en Leads Orgánicos
-- Ejecutar una sola vez, DESPUÉS de migration_015_organic_leads.sql

-- lead_date: fecha propia del lead (cuándo llegó, según el archivo importado),
-- distinta de created_at (cuándo se importó a este sistema).
-- reason: motivo/servicio de interés del lead — texto libre, puede ser largo.
ALTER TABLE organic_leads
    ADD COLUMN lead_date DATE NULL AFTER phone,
    ADD COLUMN reason TEXT NULL AFTER extra;
