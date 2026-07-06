-- Esquema de base de datos para el módulo "Atención al Cliente"
-- Ejecutar una sola vez (phpMyAdmin o mysql CLI) en la base de datos configurada en backend/config.php

CREATE TABLE IF NOT EXISTS operators (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin','agent') NOT NULL DEFAULT 'admin',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_operators_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS clients (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(160) NOT NULL,
    logo_url VARCHAR(500) NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'America/Mexico_City',
    status ENUM('active','paused','archived') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_clients_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS social_accounts (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    platform ENUM('facebook_page','instagram_business') NOT NULL,
    page_id VARCHAR(64) NOT NULL,
    page_name VARCHAR(190) NULL,
    ig_business_id VARCHAR(64) NULL,
    ig_username VARCHAR(190) NULL,
    page_access_token_encrypted TEXT NOT NULL,
    page_token_iv VARCHAR(64) NOT NULL,
    user_access_token_encrypted TEXT NULL,
    user_token_iv VARCHAR(64) NULL,
    token_obtained_at DATETIME NULL,
    last_verified_at DATETIME NULL,
    webhook_subscribed_fields JSON NULL,
    status ENUM('active','token_expired','revoked') NOT NULL DEFAULT 'active',
    connected_by INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_social_account (platform, page_id),
    KEY idx_social_accounts_client (client_id),
    CONSTRAINT fk_social_accounts_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_social_accounts_operator FOREIGN KEY (connected_by) REFERENCES operators(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS flows (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    social_account_id INT UNSIGNED NULL,
    name VARCHAR(150) NOT NULL,
    status ENUM('draft','active','paused') NOT NULL DEFAULT 'draft',
    version INT UNSIGNED NOT NULL DEFAULT 1,
    graph_json LONGTEXT NOT NULL,
    created_by INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_flows_client (client_id),
    KEY idx_flows_account (social_account_id),
    CONSTRAINT fk_flows_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_flows_account FOREIGN KEY (social_account_id) REFERENCES social_accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_flows_operator FOREIGN KEY (created_by) REFERENCES operators(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS flow_triggers (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    flow_id INT UNSIGNED NOT NULL,
    platform_scope ENUM('messenger','instagram','both') NOT NULL DEFAULT 'both',
    trigger_type ENUM('keyword','comment_on_post','new_conversation') NOT NULL,
    match_config JSON NOT NULL,
    node_id VARCHAR(64) NOT NULL,
    priority INT NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    KEY idx_flow_triggers_flow (flow_id),
    CONSTRAINT fk_flow_triggers_flow FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS contacts (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    social_account_id INT UNSIGNED NOT NULL,
    platform ENUM('messenger','instagram') NOT NULL,
    psid VARCHAR(64) NOT NULL,
    name VARCHAR(190) NULL,
    email VARCHAR(190) NULL,
    phone VARCHAR(64) NULL,
    profile_pic_url VARCHAR(500) NULL,
    first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_contact (social_account_id, psid),
    KEY idx_contacts_client (client_id),
    CONSTRAINT fk_contacts_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_contacts_account FOREIGN KEY (social_account_id) REFERENCES social_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS conversations (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    contact_id INT UNSIGNED NOT NULL,
    social_account_id INT UNSIGNED NOT NULL,
    active_flow_id INT UNSIGNED NULL,
    current_node_id VARCHAR(64) NULL,
    status ENUM('open','closed','handed_off') NOT NULL DEFAULT 'open',
    last_inbound_at DATETIME NULL,
    window_expires_at DATETIME NULL,
    human_agent_tag_until DATETIME NULL,
    state_vars JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_conversations_contact (contact_id),
    KEY idx_conversations_account (social_account_id),
    KEY idx_conversations_window (window_expires_at),
    CONSTRAINT fk_conversations_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    CONSTRAINT fk_conversations_account FOREIGN KEY (social_account_id) REFERENCES social_accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_conversations_flow FOREIGN KEY (active_flow_id) REFERENCES flows(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT UNSIGNED NOT NULL,
    direction ENUM('in','out') NOT NULL,
    platform_message_id VARCHAR(190) NULL,
    message_type ENUM('text','quick_reply','comment_reply','private_reply','postback') NOT NULL DEFAULT 'text',
    content TEXT NULL,
    payload_json LONGTEXT NULL,
    tag ENUM('NONE','HUMAN_AGENT') NOT NULL DEFAULT 'NONE',
    sent_by ENUM('flow','manual','system') NOT NULL DEFAULT 'system',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_messages_conversation (conversation_id, created_at),
    CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS webhook_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    social_account_id INT UNSIGNED NULL,
    platform ENUM('messenger','instagram') NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    raw_payload LONGTEXT NOT NULL,
    signature_valid TINYINT(1) NOT NULL DEFAULT 0,
    processed TINYINT(1) NOT NULL DEFAULT 0,
    processed_at DATETIME NULL,
    error TEXT NULL,
    received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_webhook_events_processed (processed),
    CONSTRAINT fk_webhook_events_account FOREIGN KEY (social_account_id) REFERENCES social_accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS deletion_requests (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    confirmation_code VARCHAR(64) NOT NULL,
    external_user_id VARCHAR(64) NULL,
    contacts_deleted INT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('completed','partial','error') NOT NULL DEFAULT 'completed',
    requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_deletion_code (confirmation_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scheduled_actions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT UNSIGNED NOT NULL,
    flow_id INT UNSIGNED NOT NULL,
    node_id VARCHAR(64) NOT NULL,
    run_at DATETIME NOT NULL,
    status ENUM('pending','sent','needs_manual_followup','failed','cancelled') NOT NULL DEFAULT 'pending',
    payload_json LONGTEXT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    claimed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_scheduled_actions_run (run_at, status),
    CONSTRAINT fk_scheduled_actions_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_scheduled_actions_flow FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
