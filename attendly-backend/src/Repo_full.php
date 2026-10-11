<?php
/**
 * ATTENDLY — Data Access
 *
 * Reads and writes for the entities the frontend needs. Every query
 * uses prepared statements; row shapes are mapped into the camelCase
 * field names js/*.js already expect so the client needs no reshaping.
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
            $stmt = $this->db->prepare(
                'SELECT u.id, u.role, u.username, u.email, u.status,
                        s.student_id_number, s.first_name, s.last_name,
                        s.program, s.year_level, s.section, s.fingerprint_enrolled
                 FROM users u
                 LEFT JOIN students s ON s.user_id = u.id
                 WHERE u.id = :id'
            );
            $stmt->execute(['id' => $viewer['id']]);
            return array_map([$this, 'mapUser'], $stmt->fetchAll());
        }

        $rows = $this->db->query(
            'SELECT u.id, u.role, u.username, u.email, u.status,
                    s.student_id_number, s.first_name, s.last_name,
                    s.program, s.year_level, s.section, s.fingerprint_enrolled,
                    o.position, o.status AS officer_status
             FROM users u
             LEFT JOIN students s ON s.user_id = u.id
             LEFT JOIN ssc_officers o ON o.user_id = u.id
             ORDER BY u.role, u.id'
        )->fetchAll();

        return array_map([$this, 'mapUser'], $rows);
    }

    /**
     * Create a student plus their users row.
     *
     * @param array<string,mixed> $input
     */
    public function createStudent(array $input, array $actor): array
    {
        $this->db->beginTransaction();
        try {
            $stmt = $this->db->prepare(
                'INSERT INTO users (role, username, email, password_hash, status)
                 VALUES (\'student\', :username, :email, :hash, \'active\')'
            );
            $stmt->execute([
                'username' => $input['username'],
                'email'    => $input['email'],
                'hash'     => password_hash($input['password'], PASSWORD_DEFAULT),
            ]);
            $userId = (int) $this->db->lastInsertId();

            $profile = $this->db->prepare(
                'INSERT INTO students
                    (user_id, student_id_number, first_name, last_name, program, year_level, section, fingerprint_enrolled)
                 VALUES (:uid, :idnum, :first, :last, :program, :year, :section, 0)'
            );
            $profile->execute([
                'uid'     => $userId,
                'idnum'   => $input['studentIdNumber'],
                'first'   => $input['firstName'],
                'last'    => $input['lastName'],
                'program' => $input['program'],
                'year'    => (string) $input['yearLevel'],
                // Section stored as combined format: PROGRAM-YEAR-LETTER
                // (e.g. "BSIT-1A") to match existing seeded student records.
                'section' => ($input['program'] ? $input['program'] : 'STUD') . '-' . ((string)$input['yearLevel']) . ($input['section'] ? $input['section'] : ''),
            ]);

            $this->db->commit();
        } catch (PDOException $e) {
            $this->db->rollBack();
            $errInfo = $e->errorInfo ?? [];
            $driverErr = $errInfo[1] ?? null;
            if ($driverErr === 1062) {
                Response::fail('duplicate', 'That email or student ID number is already registered.', 409);
            }
            throw $e;
        }

        $rows = $this->db->prepare(
            'SELECT u.id, u.role, u.username, u.email, u.status,
                    s.student_id_number, s.first_name, s.last_name,
                    s.program, s.year_level, s.section, s.fingerprint_enrolled
             FROM users u LEFT JOIN students s ON s.user_id = u.id WHERE u.id = :id'
        );
        $rows->execute(['id' => $userId]);
        return $this->mapUser($rows->fetch());
    }

    /* ── Events ────────────────────────────────────────────────── */

    /**
     * @return array<int,array<string,mixed>>
     */
    public function listEvents(): array
    {
        $rows = $this->db->query(
            'SELECT id, name, description, event_date, start_time, end_time, venue, event_type, status
             FROM events ORDER BY event_date, start_time'
        )->fetchAll();
        return array_map([$this, 'mapEvent'], $rows);
    }

    /**
     * @param array<string,mixed> $input
     */
    public function createEvent(array $input, array $actor): array
    {
        $stmt = $this->db->prepare(
            'INSERT INTO events (name, description, event_date, start_time, end_time, venue, event_type, status, created_by)
             VALUES (:name, :description, :date, :start, :end, :venue, :type, \'scheduled\', :created_by)'
        );
        $stmt->execute([
            'name'        => $input['name'],
            'description' => $input['description'] ?? null,
            'date'        => $input['date'],
            'start'       => $input['startTime'],
            'end'         => $input['endTime'],
            'venue'       => $input['venue'],
            'type'        => $input['eventType'] === 'optional' ? 'optional' : 'mandatory',
            'created_by'  => $actor['id'],
        ]);

        $id = (int) $this->db->lastInsertId();
        $row = $this->db->prepare('SELECT id, name, description, event_date, start_time, end_time, venue, event_type, status FROM events WHERE id = :id');
        $row->execute(['id' => $id]);
        return $this->mapEvent($row->fetch());
    }

    /**
     * Delete an event. Attendance rows reference events with ON DELETE
     * RESTRICT, so an event that already has check-ins cannot be removed.
     */
    public function deleteEvent(int $eventId): void
    {
        try {
            $stmt = $this->db->prepare('SELECT 1 FROM events WHERE id = :id LIMIT 1');
            $stmt->execute(['id' => $eventId]);
            if ($stmt->fetch() === false) {
                Response::fail('event_not_found', 'Event not found.', 404);
            }
            $stmt = $this->db->prepare('DELETE FROM events WHERE id = :id');
            $stmt->execute(['id' => $eventId]);
        } catch (PDOException $e) {
            $errInfo = $e->errorInfo ?? [];
            $driverErr = $errInfo[1] ?? null;
            // 1451 = FK constraint prevents deletion (attendance records reference this event).
            if ($driverErr === 1451) {
                Response::fail('event_in_use', 'This event already has attendance records and cannot be deleted.', 409);
            }
            throw $e;
        }
    }

    /**
     * Update an event with partial data. Accepts any of: name, description,
     * date, startTime, endTime, venue, eventType, status (scheduled|cancelled|completed).
     *
     * @param array{name?, description?, date?, startTime?, endTime?, venue?, eventType?, status?} $input
     * @param array{id: int, role: string} $actor
     * @return array the updated event record (as mapEvent output)
     */
    public function updateEvent(int $eventId, array $input, array $actor): array
    {
        // Check existence
        $stmt = $this->db->prepare('SELECT 1 FROM events WHERE id = :id LIMIT 1');
        $stmt->execute(['id' => $eventId]);
        if ($stmt->fetch() === false) {
            Response::fail('event_not_found', 'Event not found.', 404);
        }

        // Determine if event has attendance records that would block time edits
        $hasAttendance = false;
        $stmt = $this->db->prepare(
            'SELECT 1 FROM attendance_records WHERE event_id = :event_id LIMIT 1'
        );
        $stmt->execute(['event_id' => $eventId]);
        if ($stmt->fetch()) {
            $hasAttendance = true;
        }

        // Build SET clause from provided keys
        $fields = [];
        $vals   = [];

        if (array_key_exists('name', $input)) {
            $fields[] = 'name = :name';
            $vals[':name'] = $input['name'];
        }
        if (array_key_exists('description', $input)) {
            $fields[] = 'description = :description';
            $vals[':description'] = $input['description'];
        }
        if (array_key_exists('date', $input)) {
            if ($hasAttendance) {
                Response::fail('event_has_attendance', 'Cannot change event date when attendance records exist.', 409);
            }
            $fields[] = 'event_date = :date';
            $vals[':date'] = $input['date'];
        }
        if (array_key_exists('startTime', $input) || array_key_exists('endTime', $input)) {
            if ($hasAttendance) {
                Response::fail('event_has_attendance', 'Cannot change event time when attendance records exist.', 409);
            }
            if (array_key_exists('startTime', $input)) {
                $fields[] = 'start_time = :start_time';
                $vals[':start_time'] = $input['startTime'];
            }
            if (array_key_exists('endTime', $input)) {
                $fields[] = 'end_time = :end_time';
                $vals[':end_time'] = $input['endTime'];
            }
        }
        if (array_key_exists('venue', $input)) {
            $fields[] = 'venue = :venue';
            $vals[':venue'] = $input['venue'];
        }
        if (array_key_exists('eventType', $input)) {
            $fields[] = 'event_type = :event_type';
            $vals[':event_type'] = $input['eventType'] === 'optional' ? 'optional' : 'mandatory';
        }
        if (array_key_exists('status', $input)) {
            $valid = ['scheduled', 'cancelled', 'completed'];
            if (!in_array($input['status'], $valid, true)) {
                Response::fail('invalid_status', 'Status must be one of: scheduled, cancelled, completed.', 422);
            }
            $fields[] = 'status = :status';
            $vals[':status'] = $input['status'];
        }

        if (empty($fields)) {
            Response::fail('invalid_field', 'At least one field must be provided for update.', 422);
        }

        $vals[':id'] = $eventId;
        $sql = 'UPDATE events SET ' . implode(', ', $fields) . ' WHERE id = :id';

        try {
            $stmt = $this->db->prepare($sql);
            $stmt->execute($vals);
        } catch (Throwable $e) {
            Response::fail('server_error', 'Failed to update event.', 500);
        }

        // Return the updated event
        return $this->readEvent($eventId);
    }

    /**
     * Update event status to cancelled or completed; reject edits to
     * date/time on cancelled/completed events. Reject un-cancelling.
     */
    public function cancelEvent(int $eventId, string $newStatus): array
    {
        $stmt = $this->db->prepare('SELECT status FROM events WHERE id = :id LIMIT 1');
        $stmt->execute(['id' => $eventId]);
        $current = $stmt->fetchColumn();
        if ($current === false) {
            Response::fail('event_not_found', 'Event not found.', 404);
        }
        if ($current === 'cancelled' || $current === 'completed') {
            Response::fail('invalid_status', 'Cannot modify date/time on a cancelled or completed event.', 422);
        }
        if ($newStatus !== 'cancelled' && $newStatus !== 'completed') {
            Response::fail('invalid_status', 'Can only cancel or complete an event.', 422);
        }
        $update = $this->db->prepare('UPDATE events SET status = :status WHERE id = :id');
        $update->execute(['status' => $newStatus, 'id' => $eventId]);
        return $this->readEvent($eventId);
    }

    /* ── Attendance ────────────────────────────────────────────── */

    /**
     * @return array<int,array<string,mixed>>
     */
    public function listAttendance(?int $eventId, ?int $studentId, ?array $config = null): array
    {
        $graceMinutes = (int) ($config['app']['late_grace_minutes'] ?? 15);
        $sql = 'SELECT a.id, a.event_id, a.student_id, a.check_in_time,
                       a.verification_method, s.student_id_number,
                       e.start_time
                FROM attendance_records a
                JOIN students s ON s.user_id = a.student_id
                LEFT JOIN events e ON e.id = a.event_id
                WHERE 1 = 1';
        $params = [];

        if ($eventId !== null) {
            $sql .= ' AND a.event_id = :event_id';
            $params['event_id'] = $eventId;
        }
        if ($studentId !== null) {
            $sql .= ' AND a.student_id = :student_id';
            $params['student_id'] = $studentId;
        }
        $sql .= ' ORDER BY a.check_in_time DESC';

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        $lateGraceMinutes = (int) ($config['app']['late_grace_minutes'] ?? 15);
        $mapped = array_map(function ($row) use ($lateGraceMinutes) {
            return $this->mapAttendanceWithGrace($row, $lateGraceMinutes);
        }, $rows);
        return $mapped;
    }

    /**
     * Map attendance with late calculation based on event start_time + grace minutes.
     *
     * @param array<string,mixed> $row
     * @param int $graceMinutes
     * @return array<string,mixed>
     */
    private function mapAttendanceWithGrace(array $row, int $graceMinutes): array
    {
        $checkIn = (string) $row['check_in_time'];
        $time    = substr($checkIn, 11, 5); // "HH:MM:SS" out of the timestamp
        $startTime = $row['start_time'] ?? null;
        $isLate = false;
        if ($startTime !== null) {
            $start = (string) $startTime;
            $startMinute = (int) substr($start, 0, 2) * 60 + (int) substr($start, 3, 2);
            $checkInMinute = (int) substr($time, 0, 2) * 60 + (int) substr($time, 3, 2);
            $isLate = $checkInMinute > $startMinute + $graceMinutes;
        } else {
            // Fallback: after 08:15 (original behavior)
            $isLate = $time > '08:15';
        }
        $status  = $isLate ? 'late' : 'present';

        return [
            'id'                 => (int) $row['id'],
            'eventId'            => (int) $row['event_id'],
            'studentId'          => (int) $row['student_id'],
            'studentIdNumber'    => $row['student_id_number'] ?? null,
            'date'               => substr($checkIn, 0, 10),
            'time'               => $time,
            'status'             => $status,
            'verificationMethod' => $row['verification_method'],
        ];
    }

    /**
     * Record a check-in. The UNIQUE(event_id, student_id) constraint is
     * the real duplicate guard — a race between two kiosks is rejected by
     * MySQL, not by a prior SELECT.
     *
     * @param array<string,mixed> $input
     */
    public function checkIn(array $input): array
    {
        try {
            $stmt = $this->db->prepare(
                'INSERT INTO attendance_records (event_id, student_id, verification_method)
                 VALUES (:event_id, :student_id, :method)'
            );
            $stmt->execute([
                'event_id'   => $input['eventId'],
                'student_id' => $input['studentId'],
                'method'     => $input['verificationMethod'] === 'manual' ? 'manual' : 'fingerprint',
            ]);
        } catch (PDOException $e) {
            $errInfo = $e->errorInfo ?? [];
            $driverErr = $errInfo[1] ?? null;
            // 1062 = duplicate entry (already checked in for event).
            if ($driverErr === 1062) {
                Response::fail('duplicate_checkin', 'This student is already checked in for that event.', 409);
            }
            // 1452 = foreign key failure (student or event does not exist).
            if ($driverErr === 1452) {
                // Determine which reference failed. Check if event exists.
                $evt = $this->db->prepare('SELECT 1 FROM events WHERE id = :id LIMIT 1');
                $evt->execute(['id' => (int) $input['eventId']]);
                if ($evt->fetch() === false) {
                    Response::fail('event_not_found', 'Event not found.', 404);
                }
                // Event exists; must be missing student.
                Response::fail('student_not_found', 'No student is registered under that ID.', 404);
            }
            throw $e;
        }

        $id = (int) $this->db->lastInsertId();
        $row = $this->db->prepare(
            'SELECT id, event_id, student_id, check_in_time, verification_method
             FROM attendance_records WHERE id = :id'
        );
        $row->execute(['id' => $id]);
        return $this->mapAttendance($row->fetch());
    }

    /* ── Sanctions ─────────────────────────────────────────────── */

    /**
     * @return array<int,array<string,mixed>>
     */
    public function listSanctions(?int $studentId = null, ?string $statusFilter = null): array
    {
        $sql = 'SELECT sr.id, sr.recommendation_id, sr.student_id, sr.type,
                       sr.decided_by, sr.decision_notes, sr.decided_at, sr.lifted_at,
                       s.first_name, s.last_name, s.student_id_number
                FROM sanction_records sr
                JOIN students s ON s.user_id = sr.student_id
                WHERE 1 = 1';
        $params = [];
        if ($studentId !== null) {
            $sql .= ' AND sr.student_id = :student_id';
            $params['student_id'] = $studentId;
        }
        if ($statusFilter !== null && ($statusFilter === 'active' || $statusFilter === 'resolved')) {
            if ($statusFilter === 'active') {
                $sql .= ' AND sr.lifted_at IS NULL';
            } else {
                $sql .= ' AND sr.lifted_at IS NOT NULL';
            }
        }
        $sql .= ' ORDER BY sr.decided_at DESC';

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return array_map([$this, 'mapSanction'], $stmt->fetchAll());
    }

    /* ── Row mapping ───────────────────────────────────────────── */

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private function mapUser(array $row): array
    {
        return [
            'id'            => (int) $row['id'],
            'role'          => Auth::clientRole((string) $row['role']),
            'username'      => $row['username'],
            'email'         => $row['email'],
            'status'        => $row['status'],
            'name'          => isset($row['first_name'])
                ? trim(($row['first_name'] ?? '') . ' ' . ($row['last_name'] ?? '')) ?: $row['username']
                : $row['username'],
            'studentIdNumber' => $row['student_id_number'] ?? null,
            'program'       => $row['program'] ?? null,
            'yearLevel'     => $row['year_level'] ?? null,
            'section'       => $row['section'] ?? null,
            'position'      => $row['position'] ?? null,
            'officerStatus' => $row['officer_status'] ?? null,
            'fingerprintEnrolled' => isset($row['fingerprint_enrolled'])
                ? (bool) $row['fingerprint_enrolled']
                : null,
        ];
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private function mapEvent(array $row): array
    {
        // The schema calls this mandatory/optional; the UI's event type is
        // major/minor and it also carries a redundant `mandatory` flag
        // (see loadEventsTable in js/ssc.js). Translating here keeps the
        // database vocabulary out of the markup and stops a hydrated event
        // from rendering as "Optional" with a neutral badge.
        $mandatory = $row['event_type'] === 'mandatory';

        return [
            'id'          => (int) $row['id'],
            'name'        => $row['name'],
            'description' => $row['description'],
            'date'        => $row['event_date'],
            'time'        => substr((string) $row['start_time'], 0, 5),
            'startTime'   => substr((string) $row['start_time'], 0, 5),
            'endTime'     => substr((string) $row['end_time'], 0, 5),
            // The UI column is "location", never "venue".
            'location'    => $row['venue'],
            'type'        => $mandatory ? 'major' : 'minor',
            'mandatory'   => $mandatory,
            // No column stores the recurrence rule; the UI hides the badge
            // when this is falsy, so null is the honest value.
            'recurring'   => null,
            'status'      => $row['status'],
        ];
    }

    /**
     * The frontend models a check-in as a table row with eventId, date,
     * time and a present/late status; the schema stores a timestamp and a
     * verification method, so those are derived here.
     *
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private function mapAttendance(array $row): array
    {
        $checkIn = (string) $row['check_in_time'];
        $time    = substr($checkIn, 11, 5); // "HH:MM:SS" out of the timestamp
        // Late means arriving after 08:15, matching the kiosk's grace period.
        $status  = $time > '08:15' ? 'late' : 'present';

        return [
            'id'                 => (int) $row['id'],
            'eventId'            => (int) $row['event_id'],
            'studentId'          => (int) $row['student_id'],
            'studentIdNumber'    => $row['student_id_number'] ?? null,
            'date'               => substr($checkIn, 0, 10),
            'time'               => $time,
            'status'             => $status,
            'verificationMethod' => $row['verification_method'],
        ];
    }

    /**
     * Sanction rows are stored split across recommendation and decision;
     * the frontend wants one flat record with severity and a lifted/active
     * status.
     *
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private function mapSanction(array $row): array
    {
        $decidedAt = (string) $row['decided_at'];

        return [
            'id'               => (int) $row['id'],
            'studentId'        => (int) $row['student_id'],
            'studentName'      => trim(($row['first_name'] ?? '') . ' ' . ($row['last_name'] ?? '')),
            'studentIdNumber'  => $row['student_id_number'] ?? null,
            'recommendationId' => $row['recommendation_id'] !== null ? (int) $row['recommendation_id'] : null,
            // The schema's `type` ('warning'/'probation') is what the
            // frontend calls `severity`, and it is a subset of the
            // {warning, probation, suspension} set that severityBadge()
            // and severityRank() understand, so it maps across unchanged.
            'severity'         => $row['type'],
            'description'      => $row['decision_notes'] ?? '',
            'date'             => substr($decidedAt, 0, 10),
            // "resolved" is not a database word: the frontend toggles a
            // sanction between 'active' and 'resolved' (see
            // toggleSanctionStatus in js/ssc.js), so lifted_at is
            // translated rather than exposed as 'lifted'.
            'status'           => $row['lifted_at'] === null ? 'active' : 'resolved',
            'decidedBy'        => (int) $row['decided_by'],
            'liftedAt'         => $row['lifted_at'],
        ];
    }
}