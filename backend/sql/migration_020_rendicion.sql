-- Migración 020 — módulo "Rendición Trimestral" (evaluación interna de CMs +
-- encuesta de satisfacción al cliente). Ejecutar una sola vez en instalaciones
-- existentes (ya cubierto en schema.sql para instalaciones nuevas).

-- Formulario 1: una fila por (cliente, trimestre, CM). Columnas reales para lo
-- que el dashboard filtra/promedia; answers JSON para el resto (mismo patrón
-- que client_briefs.answers).
CREATE TABLE IF NOT EXISTS rendicion_forms (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    operator_id INT UNSIGNED NOT NULL,
    quarter VARCHAR(7) NOT NULL,
    status ENUM('draft','submitted') NOT NULL DEFAULT 'draft',
    activity_level ENUM('baja','media','alta') NULL,
    contracted_services JSON NULL,

    meetings_total SMALLINT UNSIGNED NULL,
    meetings_planning SMALLINT UNSIGNED NULL,
    meetings_client_requested SMALLINT UNSIGNED NULL,
    meetings_cm_initiated SMALLINT UNSIGNED NULL,
    followups_count SMALLINT UNSIGNED NULL,
    avg_response_time VARCHAR(32) NULL,
    proactivity_self_score TINYINT UNSIGNED NULL,

    pieces_generated SMALLINT UNSIGNED NULL,
    pieces_delivered SMALLINT UNSIGNED NULL,
    pieces_approved SMALLINT UNSIGNED NULL,
    pieces_rework SMALLINT UNSIGNED NULL,
    creation_sessions SMALLINT UNSIGNED NULL,
    client_visits SMALLINT UNSIGNED NULL,

    incidents_count SMALLINT UNSIGNED NULL,

    account_health ENUM('verde','amarillo','rojo') NULL,
    has_risk BOOLEAN NULL,

    answers JSON NULL,

    submitted_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rendicion_forms (client_id, quarter, operator_id),
    KEY idx_rendicion_forms_quarter (quarter),
    KEY idx_rendicion_forms_operator (operator_id, quarter),
    CONSTRAINT fk_rendicion_forms_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_rendicion_forms_operator FOREIGN KEY (operator_id) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Oportunidades comerciales reportadas en un formulario — filas hijas, permite
-- el embudo detectada→reportada→cotizada→vendida a través de trimestres.
CREATE TABLE IF NOT EXISTS rendicion_opportunities (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    rendicion_form_id INT UNSIGNED NOT NULL,
    client_id INT UNSIGNED NOT NULL,
    needs JSON NULL,
    services JSON NULL,
    stage ENUM('detectada','reportada','presentada','cotizada','en_negociacion','aprobada','vendida','perdida','pendiente') NOT NULL DEFAULT 'detectada',
    estimated_value DECIMAL(14,2) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_rendicion_opportunities_form (rendicion_form_id),
    KEY idx_rendicion_opportunities_client (client_id, stage),
    CONSTRAINT fk_rendicion_opportunities_form FOREIGN KEY (rendicion_form_id) REFERENCES rendicion_forms(id) ON DELETE CASCADE,
    CONSTRAINT fk_rendicion_opportunities_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Formulario 2: encuesta de satisfacción enviada directamente al cliente, una
-- fila por (cliente, trimestre). Mismo patrón de link público con token
-- hasheado que client_briefs (el token crudo nunca se guarda).
CREATE TABLE IF NOT EXISTS client_surveys (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id INT UNSIGNED NOT NULL,
    quarter VARCHAR(7) NOT NULL,
    token_hash CHAR(64) NULL,
    status ENUM('pending','filled') NOT NULL DEFAULT 'pending',

    rating_ideaz TINYINT UNSIGNED NULL,
    rating_cm TINYINT UNSIGNED NULL,
    rating_response_time TINYINT UNSIGNED NULL,
    rating_quality TINYINT UNSIGNED NULL,
    rating_creativity TINYINT UNSIGNED NULL,
    rating_commitment TINYINT UNSIGNED NULL,
    rating_communication TINYINT UNSIGNED NULL,
    rating_understands_business TINYINT UNSIGNED NULL,
    rating_overall TINYINT UNSIGNED NULL,
    nps TINYINT UNSIGNED NULL,

    value_most VARCHAR(300) NULL,
    improve_what VARCHAR(300) NULL,
    wish_feature VARCHAR(300) NULL,

    filled_by_name VARCHAR(190) NULL,
    filled_by_email VARCHAR(190) NULL,
    filled_at DATETIME NULL,
    created_by INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_client_surveys_token (token_hash),
    UNIQUE KEY uq_client_surveys_period (client_id, quarter),
    CONSTRAINT fk_client_surveys_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_client_surveys_operator FOREIGN KEY (created_by) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
