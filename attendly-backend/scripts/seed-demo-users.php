<?php
/**
 * ATTENDLY — Demo User Seeder
 *
 * CLI:  php scripts/seed-demo-users.php
 *
 * Inserts the same demo accounts the frontend prototype seeds into
 * localStorage, so the MySQL database mirrors them. Passwords are
 * stored ONLY as bcrypt hashes via password_hash() — plaintext never
 * reaches the database. Idempotent: existing emails are skipped, so
 * re-running is safe.
 *
 * Depends on config/config.php (copy from config.example.php).
 */

declare(strict_types=1);

require __DIR__ . '/../config/db.php';

function out(string $msg): void
{
    fwrite(STDOUT, $msg . PHP_EOL);
}

/** Split "First Last" into [first, last]. Extra words fold into last. */
function split_name(string $full): array
{
    $parts = preg_split('/\s+/', trim($full));
    $first = array_shift($parts);
    return [$first, implode(' ', $parts) ?: ''];
}

/**
 * @return int the users.id of the inserted (or existing) user
 */
function upsert_user(PDO $pdo, array $u): int
{
    // Existing email → leave untouched (idempotent).
    $stmt = $pdo->prepare('SELECT id FROM users WHERE email = :email');
    $stmt->execute(['email' => $u['email']]);
    $existing = $stmt->fetchColumn();
    if ($existing !== false) {
        out(sprintf('  – %-22s already exists (id %d)', $u['email'], (int) $existing));
        return (int) $existing;
    }

    $pdo->prepare('INSERT INTO users (role, username, email, password_hash, status)
                   VALUES (:role, :username, :email, :hash, :status)')
        ->execute([
            'role'     => $u['role'],
            'username' => $u['username'],
            'email'    => $u['email'],
            'hash'     => password_hash($u['password'], PASSWORD_DEFAULT),
            'status'   => $u['status'] ?? 'active',
        ]);

    $id = (int) $pdo->lastInsertId();
    out(sprintf('  + %-22s inserted (id %d, bcrypt hash)', $u['email'], $id));
    return $id;
}

try {
    $pdo = get_db();
} catch (Throwable $e) {
    fwrite(STDERR, "ERROR: could not connect.\n" . $e->getMessage() . "\n"
        . "Run scripts/init-db.sql and check config/config.php first.\n");
    exit(1);
}

const DEMO_PASSWORD = 'password123';

out('Seeding demo users (bcrypt-hashed passwords)…');

// ── Administrators ──
$adminIds = [];
$adminIds[] = upsert_user($pdo, [
    'role' => 'administrator', 'username' => 'admin',   'email' => 'admin@example.com',         'password' => DEMO_PASSWORD,
]);
$adminIds[] = upsert_user($pdo, [
    'role' => 'administrator', 'username' => 'msantos', 'email' => 'santos.admin@example.com',  'password' => DEMO_PASSWORD,
]);
foreach ($adminIds as $adminId) {
    $pdo->prepare('INSERT IGNORE INTO administrators (user_id) VALUES (:uid)')
        ->execute(['uid' => $adminId]);
}

// ── SSC Officers ──
$officers = [
    ['username' => 'sscofficer', 'email' => 'officer@example.com',       'password' => DEMO_PASSWORD, 'position' => 'Chairperson',      'status' => 'approved'],
    ['username' => 'creyes',     'email' => 'reyes.officer@example.com', 'password' => DEMO_PASSWORD, 'position' => 'Vice Chairperson', 'status' => 'approved'],
];
foreach ($officers as $o) {
    $uid = upsert_user($pdo, [
        'role' => 'ssc_officer', 'username' => $o['username'], 'email' => $o['email'],
        'password' => $o['password'], 'status' => 'active',
    ]);
    $pdo->prepare('INSERT IGNORE INTO ssc_officers (user_id, position, approved_by, approved_at, status)
                   VALUES (:uid, :pos, :by, NOW(), :status)')
        ->execute(['uid' => $uid, 'pos' => $o['position'], 'by' => $adminIds[0], 'status' => $o['status']]);
}

// ── Students (mirrors the frontend dummy-data seed) ──
$students = [
    ['username' => 'student', 'email' => 'student@example.com',  'name' => 'John Student',   'program' => 'BSIT',       'year' => '3', 'section' => 'A', 'idnum' => '2023-00001'],
    ['username' => 'alice',   'email' => 'alice@example.com',    'name' => 'Alice Student',   'program' => 'BSN',        'year' => '1', 'section' => 'A', 'idnum' => '2026-00002'],
    ['username' => 'bob',     'email' => 'bob@example.com',      'name' => 'Bob Student',     'program' => 'BSEntrep',   'year' => '2', 'section' => 'B', 'idnum' => '2025-00003'],
    ['username' => 'maria',   'email' => 'maria@example.com',    'name' => 'Maria Santos',    'program' => 'BSHM',       'year' => '2', 'section' => 'A', 'idnum' => '2025-00004'],
    ['username' => 'jose',    'email' => 'jose@example.com',     'name' => 'Jose Reyes',      'program' => 'BSTM',       'year' => '3', 'section' => 'A', 'idnum' => '2023-00005'],
    ['username' => 'ana',     'email' => 'ana@example.com',      'name' => 'Ana Dela Cruz',   'program' => 'BSIT',       'year' => '1', 'section' => 'C', 'idnum' => '2026-00006'],
    ['username' => 'patrick', 'email' => 'patrick@example.com',  'name' => 'Patrick Lim',     'program' => 'BSN',        'year' => '4', 'section' => 'B', 'idnum' => '2022-00007'],
];
foreach ($students as $s) {
    [$firstName, $lastName] = split_name($s['name']);
    $uid = upsert_user($pdo, [
        'role' => 'student', 'username' => $s['username'], 'email' => $s['email'],
        'password' => DEMO_PASSWORD,
    ]);
    $pdo->prepare('INSERT IGNORE INTO students
                   (user_id, student_id_number, first_name, last_name, program, year_level, section, fingerprint_enrolled)
                   VALUES (:uid, :idnum, :fn, :ln, :program, :year, :section, 1)')
        ->execute([
            'uid' => $uid, 'idnum' => $s['idnum'], 'fn' => $firstName, 'ln' => $lastName,
            'program' => $s['program'], 'year' => $s['year'], 'section' => $s['section'],
        ]);
}

out('Done. All demo passwords are "password123" (stored as bcrypt hashes).');