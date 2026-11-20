-- Módulo Reuniones: transcripción en vivo de Google Meet capturada por la
-- extensión de Chrome (carpeta chrome-extension/) y consultada en reuniones.html.
-- Correr una sola vez (también incluida al final de schema.sql para instalaciones nuevas).

-- Llaves personales de la extensión: el usuario la genera en reuniones.html y la
-- pega en la extensión. Solo se guarda el hash SHA-256, nunca la llave en claro.
CREATE TABLE IF NOT EXISTS meeting_extension_tokens (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    operator_id INT UNSIGNED NOT NULL,
    label VARCHAR(120) NOT NULL DEFAULT '',
    token_hash CHAR(64) NOT NULL,
    token_hint VARCHAR(12) NOT NULL DEFAULT '',
    last_used_at DATETIME NULL,
    revoked_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_meeting_token_hash (token_hash),
    KEY idx_meeting_token_operator (operator_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Una fila por grabación (una persona con la extensión en una llamada).
-- Las horas se guardan en UTC; el frontend las muestra en hora local.
CREATE TABLE IF NOT EXISTS meetings (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_session_id VARCHAR(64) NOT NULL,
    operator_id INT UNSIGNED NOT NULL,
    meeting_code VARCHAR(32) NOT NULL DEFAULT '',
    title VARCHAR(255) NOT NULL DEFAULT '',
    notes TEXT NULL,
    started_at DATETIME NOT NULL,
    ended_at DATETIME NULL,
    last_activity_at DATETIME NULL,
    caption_language VARCHAR(16) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_meeting_session (client_session_id),
    KEY idx_meetings_started (started_at),
    KEY idx_meetings_operator (operator_id),
    KEY idx_meetings_code (meeting_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fragmentos de subtítulos (un bloque de habla continua de una persona).
-- La extensión reenvía el mismo client_segment_id mientras el texto crece,
-- por eso es upsert.
CREATE TABLE IF NOT EXISTS meeting_segments (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    meeting_id INT UNSIGNED NOT NULL,
    client_segment_id VARCHAR(64) NOT NULL,
    speaker VARCHAR(160) NOT NULL DEFAULT '',
    text MEDIUMTEXT NOT NULL,
    started_at DATETIME(3) NOT NULL,
    ended_at DATETIME(3) NOT NULL,
    word_count INT UNSIGNED NOT NULL DEFAULT 0,
    UNIQUE KEY uq_segment (meeting_id, client_segment_id),
    KEY idx_segments_meeting_time (meeting_id, started_at),
    CONSTRAINT fk_segments_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Personas vistas en la llamada (aunque no hablen: quedan con 0 %).
CREATE TABLE IF NOT EXISTS meeting_participants (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    meeting_id INT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    first_seen_at DATETIME NOT NULL,
    last_seen_at DATETIME NOT NULL,
    UNIQUE KEY uq_participant (meeting_id, name),
    CONSTRAINT fk_participants_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
