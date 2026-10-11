-- Migration 009: student_check_in_codes (QR token for event check-in)
-- Each student can have an active QR token for kiosk check-in.

CREATE TABLE IF NOT EXISTS student_check_in_codes (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    student_id  INT UNSIGNED NOT NULL,
    qr_token    VARCHAR(255) NOT NULL COMMENT 'Active check-in token',
    is_active   BOOLEAN DEFAULT TRUE,
    issued_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    rotated_at  TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY uk_qr_token (qr_token),
    CONSTRAINT fk_qr_student
        FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_qr_student ON student_check_in_codes (student_id);
