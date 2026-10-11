-- ATTENDLY — Database Provisioning Script
-- Run ONCE as MySQL/MariaDB root (or via phpMyAdmin SQL tab):
--   mysql -u root -p < scripts/init-db.sql
--
-- This creates the application database and a least-privilege user.
-- The application connects as attendly_app, NOT root.

-- Create the database
CREATE DATABASE IF NOT EXISTS attendly
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- Create the application user (XAMPP default: allow from localhost)
CREATE USER IF NOT EXISTS 'attendly_app'@'localhost' IDENTIFIED BY 'attendly_pass';
CREATE USER IF NOT EXISTS 'attendly_app'@'127.0.0.1' IDENTIFIED BY 'attendly_pass';
CREATE USER IF NOT EXISTS 'attendly_app'@'::1' IDENTIFIED BY 'attendly_pass';

-- Grant only the privileges the app needs on attendly database
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, REFERENCES, INDEX
  ON attendly.*
  TO 'attendly_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, REFERENCES, INDEX
  ON attendly.*
  TO 'attendly_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, REFERENCES, INDEX
  ON attendly.*
  TO 'attendly_app'@'::1';

FLUSH PRIVILEGES;

SELECT 'attendly database and attendly_app user created.' AS result;
