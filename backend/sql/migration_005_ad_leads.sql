-- Migración 005 — Leads de formularios de Meta Ads (Instant Forms)
-- Ejecutar una sola vez, DESPUÉS de migration_004_story_reply_trigger.sql

-- Leads capturados desde formularios de Meta Ads. Sirve como respaldo propio:
-- Meta solo conserva los leads de Instant Forms ~90 días en su plataforma.
CREATE TABLE IF NOT EXISTS ad_leads (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    social_account_id INT UNSIGNED NOT NULL,
    leadgen_id VARCHAR(64) NOT NULL,
    form_id VARCHAR(64) NULL,
    form_name VARCHAR(190) NULL,
    campaign_id VARCHAR(64) NULL,
    campaign_name VARCHAR(190) NULL,
    ad_id VARCHAR(64) NULL,
    ad_name VARCHAR(190) NULL,
    name VARCHAR(190) NULL,
    email VARCHAR(190) NULL,
    phone VARCHAR(64) NULL,
    field_data JSON NULL,
    tag VARCHAR(100) NULL,
    notified_at DATETIME NULL,
    lead_created_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ad_leads_leadgen_id (leadgen_id),
    KEY idx_ad_leads_client (client_id, created_at),
    KEY idx_ad_leads_form (social_account_id, form_id),
    CONSTRAINT fk_ad_leads_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_ad_leads_account FOREIGN KEY (social_account_id) REFERENCES social_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reglas de "disparador por campaña/formulario": a qué correo notificar y qué
-- etiqueta aplicar. NULL en campaign_name/form_id = comodín (aplica a cualquiera).
CREATE TABLE IF NOT EXISTS ad_lead_rules (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    social_account_id INT UNSIGNED NOT NULL,
    campaign_name VARCHAR(190) NULL,
    form_id VARCHAR(64) NULL,
    tag VARCHAR(100) NULL,
    notify_email VARCHAR(190) NULL,
    priority INT NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_ad_lead_rules_account (social_account_id, active),
    CONSTRAINT fk_ad_lead_rules_account FOREIGN KEY (social_account_id) REFERENCES social_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
