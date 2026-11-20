-- Cumpleaños por miembro de Trello (solo día y mes; el año no se guarda).
-- Se usa para el popup de felicitación del día del cumpleaños. Correr una sola vez.
ALTER TABLE member_settings
    ADD COLUMN birth_month TINYINT UNSIGNED NULL AFTER hourly_rate,
    ADD COLUMN birth_day TINYINT UNSIGNED NULL AFTER birth_month;
