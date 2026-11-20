-- Migración 021 — recordatorios por correo de Rendición Trimestral
-- (backend/cron/rendicion_reminders.php). Guarda qué recordatorio ya se
-- envió para cada trimestre, para no duplicar el correo si el cron corre
-- más de una vez el mismo día. Ejecutar una sola vez en instalaciones
-- existentes (ya cubierto en schema.sql para instalaciones nuevas).

CREATE TABLE IF NOT EXISTS rendicion_reminders_sent (
    quarter VARCHAR(7) NOT NULL,
    reminder_type ENUM('kickoff','meeting') NOT NULL,
    sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (quarter, reminder_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
