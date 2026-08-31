-- Migración 019 — módulo "Egresos" (gastos y préstamos del equipo).
-- Registro general de agencia, sin ligar a clientes/tableros de Trello.
-- Ejecutar una sola vez en instalaciones existentes (ya cubierto en
-- schema.sql para instalaciones nuevas).

CREATE TABLE IF NOT EXISTS expenses (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    expense_date DATE NOT NULL,
    type ENUM('gasto','prestamo') NOT NULL DEFAULT 'gasto',
    category VARCHAR(100) NOT NULL DEFAULT '',
    account VARCHAR(100) NOT NULL DEFAULT '',
    concept VARCHAR(255) NOT NULL,
    amount DECIMAL(14,2) NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT 'COP',
    paid_by_name VARCHAR(190) NULL,
    reimbursement_status ENUM('pendiente','reembolsado') NULL,
    reimbursed_at DATETIME NULL,
    notes TEXT NULL,
    created_by INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_expenses_date (expense_date),
    KEY idx_expenses_type (type, reimbursement_status),
    CONSTRAINT fk_expenses_operator FOREIGN KEY (created_by) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS expense_attachments (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    expense_id INT UNSIGNED NOT NULL,
    stored_name VARCHAR(64) NOT NULL,
    original_name VARCHAR(190) NULL,
    size INT UNSIGNED NOT NULL DEFAULT 0,
    width SMALLINT UNSIGNED NULL,
    height SMALLINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_expense_attachments_expense (expense_id),
    CONSTRAINT fk_expense_attachments_expense FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
