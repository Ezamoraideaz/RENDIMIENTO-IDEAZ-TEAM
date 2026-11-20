-- Módulo Reuniones: una sola grabación por reunión aunque varios asistentes
-- tengan la extensión. Requiere migration_029_meetings.sql.
-- Correr una sola vez (también incluida al final de schema.sql para instalaciones nuevas).
--
-- Cómo funciona (backend/api/meeting_ingest.php):
--   · La primera extensión que llega a una llamada (mismo código de Meet) graba.
--   · Las demás quedan "en espera": no guardan nada y su usuario queda como
--     asistente (meeting_viewers) para ver la reunión en su módulo Reuniones.
--   · Si quien graba deja de enviar señal ~2 min (salió, cerró la pestaña), una
--     extensión en espera toma el relevo en la MISMA reunión.

-- Sesión que está grabando ahora y última vez que el servidor supo de ella
-- (hora del servidor, no del navegador).
ALTER TABLE meetings
    ADD COLUMN active_session_id VARCHAR(64) NULL AFTER caption_language,
    ADD COLUMN active_seen_at DATETIME NULL AFTER active_session_id,
    ADD KEY idx_meetings_code_seen (meeting_code, active_seen_at);

-- Cada extensión (sesión) que participó en una reunión, grabando o en espera.
-- accept_from: si tomó el relevo, solo se guardan sus fragmentos desde ese
-- momento (lo anterior ya lo había guardado quien grababa).
CREATE TABLE IF NOT EXISTS meeting_sessions (
    client_session_id VARCHAR(64) NOT NULL PRIMARY KEY,
    meeting_id INT UNSIGNED NOT NULL,
    operator_id INT UNSIGNED NOT NULL,
    accept_from DATETIME(3) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_meeting_sessions_meeting (meeting_id),
    CONSTRAINT fk_meeting_sessions_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Usuarios del dashboard que estuvieron en la reunión con la extensión pero no
-- la grabaron: pueden verla (no editarla ni borrarla).
CREATE TABLE IF NOT EXISTS meeting_viewers (
    meeting_id INT UNSIGNED NOT NULL,
    operator_id INT UNSIGNED NOT NULL,
    added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (meeting_id, operator_id),
    KEY idx_meeting_viewers_operator (operator_id),
    CONSTRAINT fk_meeting_viewers_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reuniones grabadas antes de esta migración: su sesión original.
INSERT IGNORE INTO meeting_sessions (client_session_id, meeting_id, operator_id)
SELECT client_session_id, id, operator_id FROM meetings;
