-- Módulo Reuniones: unificar el nombre de una persona.
-- Requiere migration_029_meetings.sql. Correr una sola vez (también incluida al
-- final de schema.sql para instalaciones nuevas).
--
-- Meet rotula los subtítulos con el nombre de la cuenta de Google (ej. «CM IDeaz»),
-- pero en la extensión cada usuario configura su nombre (ej. «ZHARICK CEPEDA»).
-- Cada extensión informa el nombre de su cuenta de Google y el nombre configurado;
-- al mostrar las reuniones (también las ya grabadas, por quien sea) el alias se
-- reemplaza por el nombre configurado.
CREATE TABLE IF NOT EXISTS meeting_name_aliases (
    alias_key VARCHAR(160) NOT NULL PRIMARY KEY,   -- alias en minúsculas
    alias VARCHAR(160) NOT NULL,                   -- como aparece en Meet
    display_name VARCHAR(160) NOT NULL,            -- nombre configurado en la extensión
    operator_id INT UNSIGNED NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_meeting_name_aliases_operator (operator_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
