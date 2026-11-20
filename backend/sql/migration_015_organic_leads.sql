-- Migración 015 — Leads orgánicos (pestaña "Leads Orgánicos" en Atención al Cliente)
-- Ejecutar una sola vez, DESPUÉS de migration_014_reviewer_identity.sql

-- Historial de importaciones de Excel/CSV por cliente.
CREATE TABLE IF NOT EXISTS organic_lead_imports (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    filename VARCHAR(255) NOT NULL,
    row_count INT UNSIGNED NOT NULL DEFAULT 0,
    imported_by INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_organic_lead_imports_client (client_id, created_at),
    CONSTRAINT fk_organic_lead_imports_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_organic_lead_imports_operator FOREIGN KEY (imported_by) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Base propia de leads orgánicos por cliente. "extra" guarda el resto de
-- columnas del archivo tal cual venían en el encabezado (no solo
-- nombre/correo/teléfono, que se detectan aparte para poder buscar/exportar).
CREATE TABLE IF NOT EXISTS organic_leads (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    import_id INT UNSIGNED NOT NULL,
    name VARCHAR(190) NULL,
    email VARCHAR(190) NULL,
    phone VARCHAR(64) NULL,
    extra JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_organic_leads_client (client_id, created_at),
    KEY idx_organic_leads_import (import_id),
    CONSTRAINT fk_organic_leads_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_organic_leads_import FOREIGN KEY (import_id) REFERENCES organic_lead_imports(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Correos del equipo comercial a notificar cada vez que se importa un archivo
-- para este cliente (no son operators — no tienen login en el sistema).
CREATE TABLE IF NOT EXISTS organic_lead_notify_emails (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    email VARCHAR(190) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_organic_lead_notify (client_id, email),
    CONSTRAINT fk_organic_lead_notify_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Un solo link público "vivo" por cliente (PK = client_id): siempre refleja el
-- total acumulado de leads, no una tanda puntual. El token crudo nunca se
-- guarda, solo su hash (mismo patrón que content_batches/password_resets).
-- Regenerar pisa el hash anterior (invalida el link viejo); revocar borra la fila.
CREATE TABLE IF NOT EXISTS organic_lead_share_links (
    client_id INT UNSIGNED NOT NULL PRIMARY KEY,
    token_hash CHAR(64) NOT NULL,
    created_by INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_organic_lead_share_token (token_hash),
    CONSTRAINT fk_organic_lead_share_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_organic_lead_share_operator FOREIGN KEY (created_by) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
