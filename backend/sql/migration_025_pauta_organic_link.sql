-- Migración 025 — Precalificación de leads de pauta contra la base de Leads Orgánicos
-- Ejecutar una sola vez, DESPUÉS de migration_024_pauta_report_links_token.sql (ya incluida en schema.sql para instalaciones nuevas).

-- Vincula cada cliente de Pauta (pauta_clients, id texto) con su cliente de Atención al Cliente
-- (clients, id numérico), que es donde viven sus Leads Orgánicos (organic_leads) y los leads de
-- formularios de Meta (ad_leads). Sin esta columna la precalificación funciona igual, solo que
-- hay que elegir la base orgánica cada vez.
ALTER TABLE pauta_clients
    ADD COLUMN organic_client_id INT UNSIGNED NULL AFTER platforms;
