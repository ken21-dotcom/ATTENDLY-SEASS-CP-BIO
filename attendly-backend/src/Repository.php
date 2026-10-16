<?php
/**
 * ATTENDLY — Data Access  (attendly_fresh schema)
 *
 * Reads and writes for the entities the frontend needs. Every query uses
 * prepared statements; row shapes are mapped into the camelCase field names
 * js/*.js already expects so the client needs no reshaping.
 *
 * Table map (attendly_fresh):
 *   administrator / ssc_officer / student   role tables (no unified users table)
 *   department / program                    reference data
 *   event                                   event_id, event_name, event_type, event_status
 *   attendance                              attendance_id, student_id, event_id, verification_status
 *   fingerprint_template                    fingerprint_id, student_id, template_data, is_current
 *   fingerprint_enrollment_log              log_id, action_type, ...
 *   sanction                                two-stage: recommendation_status + final_status
 *   student_standing / absence_threshold_config / notification / auth_session
 *
 * Assumptions (all documented where used):
 *  - Login identity is the email address; `username` in API output is
 *    derived from the email local-part (same rule as js/auth.js).
 *  - student.section stores the section letter as-is (e.g. "A"). The old
 *    backend stored a combined "PROGRAM-YEAR-LETTER" string; the fresh
 *    schema has dedicated columns so no combining is needed.
 *  - The signup form's single course select sends a combined taxonomy
 *    string like "BSIT – Bachelor of Science in Information Technology":
 *    the short code ("BSIT") goes into `course`, the full string into
 *    `program` (the fresh schema keeps both columns).
 *  - attendance has no verification_method column: the kiosk's
 *    verificationMethod is accepted by the endpoint but only
 *    verification_status ('Verified'/'Failed') is persisted.
 *  - Fingerprint enrollment writes action_type='simulated_enroll' for
 *    simulated enrollments. THIS REQUIRES the enum extension in
 *    sql/fresh_migration_fix.sql to be applied first — the stock column
 *    only allows ('Enroll','Re-enroll') and MySQL will reject anything else.
 */

declare(strict_types=1);

namespace Attendly;

use PDO;
use PDOException;

final class Repository
{
    public function __construct(private PDO $db)
    {
    }

    /* ── Users ─────────────────────────────────────────────────── */

    /**
     * List users. Staff see everyone; a student sees only themselves.
     *
     * @return array<int,array<string,mixed>>
     */
    public function listUsers(?array $viewer): array
    {
        if ($viewer !== null && $viewer['role'] === 'student') {
            $row = $this->getStudentRow((int) $viewer['id']);
            return $row === null ? [] : [$this->mapUserRow($row)];
        }

        $rows = $this->db->query(
            "SELECT admin_id AS id, 'admin' AS role, full_name AS name, email,
                    'active' AS status, NULL AS student_number, NULL AS program,
                    NULL AS course, NULL AS year_level, NULL AS section,
                    NULL AS fingerprint_enrolled, NULL AS position
             FROM administrator
             UNION ALL
             SELECT officer_id, 'ssc-officer', full_name, email,
                    CASE account_status
                        WHEN 'Active' THEN 'active'
                        WHEN 'Pending' THEN 'pending'
                        ELSE 'inactive'
                    END,
                    NULL, NULL, NULL, NULL, NULL, NULL, position
             FROM ssc_officer
             UNION ALL
             SELECT s.student_id, 'student', s.full_name, s.email,
                    CASE s.account_status WHEN 'Active' THEN 'active' ELSE 'inactive' END,
                    s.student_number, s.program, s.course, s.year_level, s.section,
                    (ft.fingerprint_id IS NOT NULL), NULL
             FROM student s
             LEFT JOIN fingerprint_template ft
               ON ft.student_id = s.student_id AND ft.is_current = 1
             ORDER BY role, id"
        )->fetchAll();

        return array_map([$this, 'mapUserRow'], $rows);
    }

    /**
     * Create a student plus their standing row, in one transaction.
     *
     * @param array<string,mixed> $input  username,email,password,studentIdNumber,
     *                                    firstName,lastName,program,yearLevel,section
     * @param array<string,mixed> $actor   the creating admin (id) or [] for self-signup
     */
    public function createStudent(array $input, array $actor): array
    {
        $this->db->beginTransaction();
        try {
            $createdBy = null;
            if (!empty($actor) && ($actor['role'] ?? '') === 'admin') {
                // FK created_by -> administrator(admin_id).
                $createdBy = (int) $actor['id'];
            }

            $stmt = $this->db->prepare(
                "INSERT INTO student
                    (student_number, full_name, email, course, program, year_level,
                     section, password_hash, account_status, created_by)
                 VALUES (:num, :name, :email, :course, :program, :year,
                         :section, :hash, 'Active', :created_by)"
            );
            $stmt->execute([
                'num'        => $input['studentIdNumber'],
                'name'       => trim($input['firstName'] . ' ' . $input['lastName']),
                'email'      => $input['email'],
                // The form sends one combined taxonomy string; split the
                // short code into `course` (varchar(50)) and keep the full
                // string in `program` (varchar(100)).
                'course'     => $this->courseCode((string) $input['program']),
                'program'    => $input['program'],
                'year'       => (string) $input['yearLevel'],
                'section'    => $input['section'],
                'hash'       => password_hash($input['password'], PASSWORD_DEFAULT),
                'created_by' => $createdBy,
            ]);
            $studentId = (int) $this->db->lastInsertId();

            $this->db->prepare(
                'INSERT INTO student_standing (student_id, total_mandatory_absences, standing_status)
                 VALUES (:sid, 0, \'Good\')'
            )->execute(['sid' => $studentId]);

            $this->db->commit();
        } catch (PDOException $e) {
            $this->db->rollBack();
            if (($e->errorInfo[1] ?? null) === 1062) {
                Response::fail('duplicate', 'That email or student ID number is already registered.', 409);
            }
            throw $e;
        }

        $row = $this->getStudentRow($studentId);
        if ($row === null) {
            Response::fail('server_error', 'An unexpected error occurred.', 500);
        }
        return $this->mapUserRow($row);
    }

    /**
     * Split the short course code ("BSIT") off a combined taxonomy string
     * like "BSIT – Bachelor of Science in Information Technology". Falls
     * back to the whole string (truncated) when no separator is present.
     */
    private function courseCode(string $program): string
    {
        $parts = preg_split('/\s*[–—-]\s*/u', trim($program), 2);
        $code = trim((string) ($parts[0] ?? ''));
        if ($code === '') {
            $code = trim($program);
        }
        return mb_substr($code, 0, 50);
    }

    /**
     * One student row in the same shape as the UNION in listUsers().
     */
    private function getStudentRow(int $studentId): ?array
    {
        $stmt = $this->db->prepare(
            "SELECT s.student_id AS id, 'student' AS role, s.full_name AS name, s.email,
                    CASE s.account_status WHEN 'Active' THEN 'active' ELSE 'inactive' END AS status,
                    s.student_number, s.program, s.course, s.year_level, s.section,
                    (ft.fingerprint_id IS NOT NULL) AS fingerprint_enrolled,
                    NULL AS position
             FROM student s
             LEFT JOIN fingerprint_template ft
               ON ft.student_id = s.student_id AND ft.is_current = 1
             WHERE s.student_id = :id
             LIMIT 1"
        );
        $stmt->execute(['id' => $studentId]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    /* ── Events ────────────────────────────────────────────────── */

    /**
     * @return array<int,array<string,mixed>>
     */
    public function listEvents(): array
    {
        $rows = $this->db->query(
            'SELECT e.event_id, e.event_name, e.description, e.event_date,
                    e.start_time, e.end_time, e.venue, e.event_type, e.event_status,
                    e.created_by, o.full_name AS creator_name
             FROM event e
             LEFT JOIN ssc_officer o ON o.officer_id = e.created_by
             ORDER BY e.event_date, e.start_time'
        )->fetchAll();
        return array_map([$this, 'mapEvent'], $rows);
    }

    /**
     * @param array<string,mixed> $input  name,date,startTime,endTime,venue,eventType,description
     * @param array<string,mixed> $actor  the creating officer (must be ssc-officer:
     *                                    event.created_by references ssc_officer)
     */
    public function createEvent(array $input, array $actor): array
    {
        $stmt = $this->db->prepare(
            "INSERT INTO event
                (event_name, description, event_date, start_time, end_time,
                 venue, event_type, event_status, created_by)
             VALUES (:name, :description, :date, :start, :end,
                     :venue, :type, 'Scheduled', :created_by)"
        );
        $stmt->execute([
            'name'        => $input['name'],
            'description' => $input['description'] ?? null,
            'date'        => $input['date'],
            'start'       => $input['startTime'],
            'end'         => $input['endTime'],
            'venue'       => $input['venue'],
            'type'        => ($input['eventType'] ?? '') === 'optional' ? 'Optional' : 'Mandatory',
            'created_by'  => (int) $actor['id'],
        ]);

        return $this->getEvent((int) $this->db->lastInsertId());
    }

    /**
     * @param array<string,mixed> $input  partial event fields (API names)
     */
    public function updateEvent(int $eventId, array $input, array $actor): array
    {
        $stmt = $this->db->prepare('SELECT 1 FROM event WHERE event_id = :id LIMIT 1');
        $stmt->execute(['id' => $eventId]);
        if ($stmt->fetch() === false) {
            Response::fail('event_not_found', 'Event not found.', 404);
        }

        // Don't let a schedule shift silently invalidate recorded check-ins.
        $stmt = $this->db->prepare('SELECT 1 FROM attendance WHERE event_id = :eid LIMIT 1');
        $stmt->execute(['eid' => $eventId]);
        $hasAttendance = (bool) $stmt->fetch();

        // API field name => DB column.
        $map = [
            'name'        => 'event_name',
            'description' => 'description',
            'date'        => 'event_date',
            'startTime'   => 'start_time',
            'endTime'     => 'end_time',
            'venue'       => 'venue',
            'location'    => 'venue',
        ];

        $fields = [];
        $vals   = [];
        foreach ($map as $apiKey => $col) {
            if (!array_key_exists($apiKey, $input)) {
                continue;
            }
            if ($hasAttendance && in_array($col, ['event_date', 'start_time', 'end_time'], true)) {
                Response::fail(
                    'event_locked',
                    'This event already has attendance records; its date and time can no longer be changed.',
                    422
                );
            }
            $fields[]         = "{$col} = :{$col}";
            $vals[$col]       = $input[$apiKey];
        }

        if (array_key_exists('eventType', $input)) {
            $fields[]       = 'event_type = :event_type';
            $vals['event_type'] = $input['eventType'] === 'optional' ? 'Optional' : 'Mandatory';
        }
        if (array_key_exists('status', $input)) {
            $fields[]         = 'event_status = :event_status';
            $vals['event_status'] = $this->normaliseEventStatus((string) $input['status']);
        }

        if ($fields !== []) {
            $vals['id'] = $eventId;
            $set = implode(', ', $fields);
            $this->db->prepare("UPDATE event SET {$set} WHERE event_id = :id")->execute($vals);
        }

        return $this->getEvent($eventId);
    }

    public function deleteEvent(int $eventId): void
    {
        $stmt = $this->db->prepare('DELETE FROM event WHERE event_id = :id');
        $stmt->execute(['id' => $eventId]);
        if ($stmt->rowCount() === 0) {
            Response::fail('event_not_found', 'Event not found.', 404);
        }
        // attendance rows cascade via FK fk_att_event.
    }

    /**
     * Read one event back in API shape, or 404.
     */
    private function getEvent(int $eventId): array
    {
        $stmt = $this->db->prepare(
            'SELECT e.event_id, e.event_name, e.description, e.event_date,
                    e.start_time, e.end_time, e.venue, e.event_type, e.event_status,
                    e.created_by, o.full_name AS creator_name
             FROM event e
             LEFT JOIN ssc_officer o ON o.officer_id = e.created_by
             WHERE e.event_id = :id
             LIMIT 1'
        );
        $stmt->execute(['id' => $eventId]);
        $row = $stmt->fetch();
        if ($row === false) {
            Response::fail('event_not_found', 'Event not found.', 404);
        }
        return $this->mapEvent($row);
    }

    private function normaliseEventStatus(string $status): string
    {
        return match (strtolower($status)) {
            'cancelled' => 'Cancelled',
            'completed' => 'Completed',
            default     => 'Scheduled',
        };
    }

    /* ── Attendance ────────────────────────────────────────────── */

    /**
     * @return array<int,array<string,mixed>>
     */
    public function listAttendance(?int $eventId, ?int $studentId, array $config): array
    {
        $grace = (int) ($config['app']['late_grace_minutes'] ?? 15);

        $stmt = $this->db->prepare(
            'SELECT a.attendance_id, a.student_id, a.event_id, a.check_in_time,
                    a.verification_status,
                    s.student_number, s.full_name AS student_name,
                    e.event_name, e.event_date, e.start_time
             FROM attendance a
             JOIN student s ON s.student_id = a.student_id
             JOIN event e   ON e.event_id = a.event_id
             WHERE (:event_id IS NULL OR a.event_id = :event_id)
               AND (:student_id IS NULL OR a.student_id = :student_id)
             ORDER BY a.check_in_time DESC'
        );
        // PDO needs each named placeholder bound once even when reused.
        $stmt->execute(['event_id' => $eventId, 'student_id' => $studentId]);

        return array_map(
            fn(array $row) => $this->mapAttendanceWithGrace($row, $grace),
            $stmt->fetchAll()
        );
    }

    /**
     * Record a check-in. The kiosk calls this without a session.
     *
     * @param array<string,mixed> $input  eventId, studentId, verificationMethod
     */
    public function checkIn(array $input): array
    {
        $eventId   = (int) $input['eventId'];
        $studentId = (int) $input['studentId'];

        $stmt = $this->db->prepare('SELECT 1 FROM event WHERE event_id = :id LIMIT 1');
        $stmt->execute(['id' => $eventId]);
        if ($stmt->fetch() === false) {
            Response::fail('event_not_found', 'Event not found.', 404);
        }

        $stmt = $this->db->prepare(
            "SELECT 1 FROM student WHERE student_id = :id AND account_status = 'Active' LIMIT 1"
        );
        $stmt->execute(['id' => $studentId]);
        if ($stmt->fetch() === false) {
            Response::fail('student_not_found', 'Student not found or inactive.', 404);
        }

        // NOTE: attendly_fresh.attendance has no verification_method column —
        // the kiosk's verificationMethod is accepted but only the
        // verification_status enum ('Verified'/'Failed') is persisted.
        try {
            $stmt = $this->db->prepare(
                "INSERT INTO attendance (student_id, event_id, check_in_time, verification_status)
                 VALUES (:student_id, :event_id, NOW(), 'Verified')"
            );
            $stmt->execute(['student_id' => $studentId, 'event_id' => $eventId]);
        } catch (PDOException $e) {
            if (($e->errorInfo[1] ?? null) === 1062) {
                Response::fail('already_checked_in', 'This student is already checked in to this event.', 409);
            }
            throw $e;
        }

        $stmt = $this->db->prepare(
            'SELECT a.attendance_id, a.student_id, a.event_id, a.check_in_time,
                    a.verification_status,
                    s.student_number, s.full_name AS student_name,
                    e.event_name, e.event_date, e.start_time
             FROM attendance a
             JOIN student s ON s.student_id = a.student_id
             JOIN event e   ON e.event_id = a.event_id
             WHERE a.attendance_id = :id
             LIMIT 1'
        );
        $stmt->execute(['id' => (int) $this->db->lastInsertId()]);
        return $this->mapAttendanceWithGrace($stmt->fetch(), 15);
    }

    /* ── Sanctions ─────────────────────────────────────────────── */

    /**
     * @return array<int,array<string,mixed>>
     */
    public function listSanctions(?int $studentId, ?string $statusFilter): array
    {
        $stmt = $this->db->prepare(
            'SELECT sg.sanction_id, sg.student_id, s.full_name AS student_name,
                    s.student_number, sg.reason, sg.severity,
                    sg.recommendation_status, sg.final_status,
                    sg.recommended_by, o.full_name AS recommended_by_name,
                    sg.finalized_by, sg.date_finalized, sg.created_at
             FROM sanction sg
             JOIN student s     ON s.student_id = sg.student_id
             JOIN ssc_officer o ON o.officer_id = sg.recommended_by
             WHERE (:sid IS NULL OR sg.student_id = :sid)
             ORDER BY sg.created_at DESC'
        );
        $stmt->execute(['sid' => $studentId]);

        $rows = array_map([$this, 'mapSanction'], $stmt->fetchAll());

        if ($statusFilter !== null && $statusFilter !== '') {
            $rows = array_values(array_filter(
                $rows,
                fn(array $r) => $r['status'] === $statusFilter
            ));
        }
        return $rows;
    }

    /* ── Fingerprint enrollment ────────────────────────────────── */

    /**
     * Enroll (or re-enroll) a student's fingerprint template.
     *
     * Simulated enrollments — the AS608 sensor is not connected yet — are
     * written with action_type='simulated_enroll' so they are distinguishable
     * from real enrollments with a plain column query, no JSON parsing:
     *   SELECT * FROM fingerprint_enrollment_log WHERE action_type = 'simulated_enroll';
     *
     * PREREQUISITE: sql/fresh_migration_fix.sql must be applied first. The
     * stock column is ENUM('Enroll','Re-enroll') and MySQL rejects any other
     * value, so writing 'simulated_enroll' without the ALTER TABLE fails.
     *
     * @param array<string,mixed> $input  studentId, administratorId,
     *                                    templateData (base64, ignored when simulated),
     *                                    simulated (bool)
     */
    public function enrollFingerprint(array $input): array
    {
        $studentId = (int) $input['studentId'];
        $adminId   = (int) $input['administratorId'];
        $simulated = !empty($input['simulated']);

        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare('SELECT 1 FROM student WHERE student_id = :id LIMIT 1');
            $stmt->execute(['id' => $studentId]);
            if ($stmt->fetch() === false) {
                Response::fail('student_not_found', 'Student not found.', 404);
            }

            $stmt = $this->db->prepare('SELECT 1 FROM administrator WHERE admin_id = :id LIMIT 1');
            $stmt->execute(['id' => $adminId]);
            if ($stmt->fetch() === false) {
                Response::fail('admin_not_found', 'Administrator not found.', 404);
            }

            // Retire any current template for this student.
            $this->db->prepare(
                'UPDATE fingerprint_template SET is_current = 0 WHERE student_id = :sid AND is_current = 1'
            )->execute(['sid' => $studentId]);

            if ($simulated) {
                // Placeholder bytes, explicitly marked. The JSON marker is a
                // courtesy; the queryable marker is the action_type column.
                $templateData = 'SIMULATED:' . json_encode([
                    'simulated' => true,
                    'note'      => 'AS608 sensor not connected; placeholder template only',
                ]);
                $actionType = 'simulated_enroll';
            } else {
                $templateData = (string) ($input['templateData'] ?? '');
                if ($templateData === '') {
                    Response::fail('missing_template', 'Fingerprint template data is required.', 422);
                }
                $actionType = 'Enroll';
            }

            $stmt = $this->db->prepare(
                'INSERT INTO fingerprint_template (student_id, is_current, enrolled_by, template_data)
                 VALUES (:sid, 1, :admin, :data)'
            );
            $stmt->execute(['sid' => $studentId, 'admin' => $adminId, 'data' => $templateData]);
            $fingerprintId = (int) $this->db->lastInsertId();

            $stmt = $this->db->prepare(
                'INSERT INTO fingerprint_enrollment_log
                    (fingerprint_id, student_id, administrator_id, action_type)
                 VALUES (:fp, :sid, :admin, :action)'
            );
            $stmt->execute([
                'fp'     => $fingerprintId,
                'sid'    => $studentId,
                'admin'  => $adminId,
                'action' => $actionType,
            ]);
            $logId = (int) $this->db->lastInsertId();

            $this->db->commit();
        } catch (PDOException $e) {
            $this->db->rollBack();
            throw $e;
        }

        return [
            'fingerprintId' => $fingerprintId,
            'logId'         => $logId,
            'actionType'    => $actionType,
            'simulated'     => $simulated,
        ];
    }

    /**
     * Whether a student currently has an active fingerprint template.
     */
    public function getFingerprintStatus(int $studentId): array
    {
        $stmt = $this->db->prepare(
            'SELECT fingerprint_id, enrolled_at FROM fingerprint_template
             WHERE student_id = :sid AND is_current = 1 LIMIT 1'
        );
        $stmt->execute(['sid' => $studentId]);
        $row = $stmt->fetch();
        if ($row === false) {
            return ['enrolled' => false, 'fingerprintId' => null, 'enrolledAt' => null];
        }
        return [
            'enrolled'      => true,
            'fingerprintId' => (int) $row['fingerprint_id'],
            'enrolledAt'    => $row['enrolled_at'],
        ];
    }

    /* ── row mappers ───────────────────────────────────────────── */

    /**
     * @param array<string,mixed> $row
     */
    private function mapUserRow(array $row): array
    {
        $email = (string) $row['email'];
        $name  = trim((string) $row['name']);
        $firstSpace = strpos($name, ' ');
        return [
            'id'                 => (int) $row['id'],
            'role'               => (string) $row['role'],
            'username'           => Auth::deriveUsername($email),
            'email'              => $email,
            'name'               => $name,
            'status'             => (string) $row['status'],
            'studentIdNumber'    => $row['student_number'] ?? null,
            'firstName'          => $firstSpace === false ? $name : substr($name, 0, $firstSpace),
            'lastName'           => $firstSpace === false ? '' : trim(substr($name, $firstSpace + 1)),
            'program'            => $row['program'] ?? null,
            'course'             => $row['course'] ?? null,
            'yearLevel'          => $row['year_level'] ?? null,
            'section'            => $row['section'] ?? null,
            'fingerprintEnrolled'=> (bool) ($row['fingerprint_enrolled'] ?? false),
            'position'           => $row['position'] ?? null,
        ];
    }

    /**
     * @param array<string,mixed> $row
     */
    private function mapEvent(array $row): array
    {
        // DB stores 'Mandatory'/'Optional'; the UI models major/minor and a
        // redundant `mandatory` flag (see loadEventsTable in js/ssc.js).
        $mandatory = strcasecmp((string) $row['event_type'], 'Mandatory') === 0;

        return [
            'id'          => (int) $row['event_id'],
            'name'        => $row['event_name'],
            'description' => $row['description'],
            'date'        => $row['event_date'],
            'time'        => substr((string) $row['start_time'], 0, 5),
            'startTime'   => substr((string) $row['start_time'], 0, 5),
            'endTime'     => substr((string) $row['end_time'], 0, 5),
            // The UI column is "location", never "venue".
            'location'    => $row['venue'],
            'type'        => $mandatory ? 'major' : 'minor',
            'mandatory'   => $mandatory,
            'recurring'   => null,
            'status'      => strtolower((string) $row['event_status']),
            'createdBy'   => $row['created_by'] !== null ? (int) $row['created_by'] : null,
            'creatorName' => $row['creator_name'] ?? null,
        ];
    }

    /**
     * The frontend models a check-in as a table row with eventId, date, time
     * and a present/late status; the schema stores a timestamp and a
     * verification enum, so the translation happens here.
     *
     * @param array<string,mixed> $row
     */
    private function mapAttendanceWithGrace(array $row, int $graceMinutes): array
    {
        $checkIn = (string) $row['check_in_time'];
        $time    = substr($checkIn, 11, 5); // "HH:MM" out of the timestamp

        $isLate = false;
        if (!empty($row['start_time'])) {
            $start = (string) $row['start_time'];
            $startMinute   = (int) substr($start, 0, 2) * 60 + (int) substr($start, 3, 2);
            $checkInMinute = (int) substr($time, 0, 2) * 60 + (int) substr($time, 3, 2);
            $isLate = $checkInMinute > $startMinute + $graceMinutes;
        } else {
            $isLate = $time > '08:15';
        }

        return [
            'id'                 => (int) $row['attendance_id'],
            'eventId'            => (int) $row['event_id'],
            'eventName'          => $row['event_name'] ?? null,
            'studentId'          => (int) $row['student_id'],
            'studentIdNumber'    => $row['student_number'] ?? null,
            'studentName'        => $row['student_name'] ?? null,
            'date'               => substr($checkIn, 0, 10),
            'time'               => $time,
            'status'             => $isLate ? 'late' : 'present',
            // attendly_fresh.attendance has no verification_method column;
            // the kiosk's verificationMethod is accepted by the endpoint but
            // only verification_status is persisted.
            'verificationMethod' => null,
            'verificationStatus' => strtolower((string) $row['verification_status']),
        ];
    }

    /**
     * The fresh schema models sanctions in two stages
     * (recommendation_status + final_status) with severity Low/Medium/High.
     * The frontend speaks warning/probation/suspension and active/resolved:
     *
     *   severity Low->warning, Medium->probation, High->suspension
     *   status   'Pending Review' -> active, anything decided -> resolved
     *
     * @param array<string,mixed> $row
     */
    private function mapSanction(array $row): array
    {
        $severity = match ($row['severity']) {
            'High'   => 'suspension',
            'Medium' => 'probation',
            default  => 'warning',
        };

        $decided = ((string) $row['recommendation_status']) !== 'Pending Review';

        return [
            'id'                 => (int) $row['sanction_id'],
            'studentId'          => (int) $row['student_id'],
            'studentName'        => $row['student_name'] ?? null,
            'studentIdNumber'    => $row['student_number'] ?? null,
            // No separate recommendation table in the fresh schema; the
            // sanction row itself carries the recommendation.
            'recommendationId'   => (int) $row['sanction_id'],
            'severity'           => $severity,
            'description'        => (string) $row['reason'],
            'date'               => substr((string) $row['created_at'], 0, 10),
            'status'             => $decided ? 'resolved' : 'active',
            'recommendationStatus' => (string) $row['recommendation_status'],
            'finalStatus'        => $row['final_status'],
            'decidedBy'          => $row['finalized_by'] !== null
                ? (int) $row['finalized_by']
                : (int) $row['recommended_by'],
            'recommendedByName'  => $row['recommended_by_name'] ?? null,
        ];
    }
}
