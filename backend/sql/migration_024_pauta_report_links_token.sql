-- Ejecutar una sola vez, DESPUÉS de migration_023_pauta_report_links.sql (ya incluida en schema.sql para instalaciones nuevas).
-- Guarda el token del link cifrado (AES-256-GCM, misma ENCRYPTION_KEY que los tokens de Meta) para que
-- superadmin/admin puedan volver a copiar o reenviar un link ya creado (ej. el de tiempo real) sin
-- regenerarlo. La validación del portal público sigue siendo por token_hash.
-- Los links creados antes de esta migración no tienen token guardado: se muestran como "recrear para copiar".
ALTER TABLE pauta_report_links
    ADD COLUMN token_encrypted TEXT NULL AFTER token_hash,
    ADD COLUMN token_iv VARCHAR(32) NULL AFTER token_encrypted;
