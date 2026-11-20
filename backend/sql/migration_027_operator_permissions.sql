-- Permisos por usuario (interruptores en Configuración → Equipo).
-- JSON {"create_brands": true, ...}. NULL = sin permisos extra. superadmin/admin no lo necesitan.
-- Correr una sola vez (phpMyAdmin). Hasta entonces el sitio funciona igual, sin permisos extra.
ALTER TABLE operators ADD COLUMN permissions TEXT NULL AFTER trello_member_id;
