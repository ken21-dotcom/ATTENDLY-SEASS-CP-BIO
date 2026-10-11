-- Migration 010: photo_records (biometric enrollment photo audit)

CREATE TABLE IF NOT EXISTS photo_records (
    id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    student_id       INT UNSIGNED NOT NULL,
    image_url        VARCHAR(500) COMMENT 'Reference to stored photo file',
    is_active        BOOLEAN DEFAULT TRUE,
    enrolled_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_photo_student
        FOREIGN KEY (student_id) REFERENCES students(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_photo_student ON photo_records (student_id);
