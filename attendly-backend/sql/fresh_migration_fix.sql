-- =====================================================================
-- ATTENDLY — attendly_fresh migration fixes
-- Run these in phpMyAdmin's SQL tab (with `attendly_fresh` selected)
-- BEFORE starting the new backend. Both statements are required.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Allow the simulated-enrollment marker in the action_type column.
--
-- WHY THIS IS NEEDED: the stock column is ENUM('Enroll','Re-enroll'), so
-- MySQL rejects any other value. Writing action_type='simulated_enroll'
-- without this ALTER fails outright — this is why the earlier one-off
-- script ended up with action_type='Enroll' and the simulated marker only
-- inside a JSON payload. After this change, simulated vs. real enrollments
-- are distinguishable with a plain column query:
--
--   SELECT log_id, student_id, action_type, action_timestamp
--   FROM fingerprint_enrollment_log
--   WHERE action_type = 'simulated_enroll';
--
-- Existing values ('Enroll','Re-enroll') are preserved: they remain valid
-- members of the enlarged enum, so no existing row changes meaning.
-- ---------------------------------------------------------------------
ALTER TABLE `fingerprint_enrollment_log`
  MODIFY COLUMN `action_type`
    ENUM('Enroll','Re-enroll','simulated_enroll','simulated_reenroll')
    NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Fix the row written by the earlier one-off script, which used the
--    generic 'Enroll' value with the simulated marker only in JSON.
-- ---------------------------------------------------------------------
UPDATE `fingerprint_enrollment_log`
SET `action_type` = 'simulated_enroll'
WHERE `log_id` = 1;
