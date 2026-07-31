-- Migración 010 — Configuración compartida del Monitor de Pauta (pauta.html)
-- Antes vivía en localStorage del navegador (cada usuario veía sus propios
-- clientes/presupuestos); esta migración la mueve a MySQL para que todos los
-- usuarios con acceso al módulo (superadmin/admin) vean la misma información.
-- Ejecutar una sola vez (phpMyAdmin o mysql CLI), DESPUÉS de migration_009_auto_batches.sql

CREATE TABLE IF NOT EXISTS pauta_clients (
    id VARCHAR(32) NOT NULL PRIMARY KEY,
    name VARCHAR(190) NOT NULL,
    budgets JSON NOT NULL,     -- { "2026-07": 500000, ... } presupuesto global por mes
    platforms JSON NOT NULL,   -- [{ platform, enabled, account_id/customer_id/advertiser_id, budgets:{...} }, ...]
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pauta_leads (
    client_id VARCHAR(32) NOT NULL,
    month_key VARCHAR(7) NOT NULL,   -- 'YYYY-MM'
    total INT UNSIGNED NOT NULL DEFAULT 0,
    qualified INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (client_id, month_key),
    CONSTRAINT fk_pauta_leads_client FOREIGN KEY (client_id) REFERENCES pauta_clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
