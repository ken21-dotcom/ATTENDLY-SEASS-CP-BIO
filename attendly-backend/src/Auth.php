<?php
/**
 * ATTENDLY — Session Authentication  (attendly_fresh schema)
 *
 * Rewritten for the attendly_fresh database, which has NO unified `users`
 * table. Credentials live in three role tables:
 *
 *   administrator  (admin_id,  full_name, email, password_hash)
 *   ssc_officer    (officer_id, full_name, email, password_hash, account_status)
 *   student        (student_id, full_name, email, password_hash, account_status)
 *
 * Login tries the tables in that order. The frontend keeps receiving the
 * exact shape it already expects:
 *   {id, name, email, role, username}   with role in {admin, ssc-officer, student}
 *
 * `username` is derived from the email local-part with the same rule as
 * js/auth.js deriveUsername(), because attendly_fresh stores no username
 * column anywhere.
 *
 * Sessions stay PHP-native (config/session.php), exactly like the previous
 * backend. The attendly_fresh.auth_session table exists for a possible
 * future DB-backed session implementation and is intentionally unused here.
 *
 * Status semantics per table:
 *   administrator : no status column — always active
 *   ssc_officer   : account_status Pending  -> 403 officer_pending
 *                   account_status Inactive -> 403 account_inactive
 *   student       : account_status Inactive -> 403 account_inactive
 */

declare(strict_types=1);

namespace Attendly;

use PDO;

require_once __DIR__ . '/../config/session.php';

final class Auth
{
    /**
     * Client role => [table, id column, DB role label].
     * Table/column names are internal constants, never user input.
     */
    private const ROLE_TABLES = [
        'admin'       => ['administrator', 'admin_id',   'Administrator'],
        'ssc-officer' => ['ssc_officer',   'officer_id', 'SSC Officer'],
        'student'     => ['student',       'student_id', 'Student'],
    ];

    /** Dummy bcrypt hash so a missing account costs the same time as a hit. */
    private const DUMMY_HASH = '$2y$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';

    public function __construct(private PDO $db)
    {
    }

    /**
     * Verify credentials and start a session.
     *
     * @return array the safe user record (no password hash)
     */
    public function login(string $email, string $password): array
    {
        $row = $this->findIn('administrator', 'admin_id', $email);
        if ($row !== null) {
            return $this->finishLogin($row, 'admin', $password, 'active');
        }

        $row = $this->findIn('ssc_officer', 'officer_id', $email);
        if ($row !== null) {
            return $this->finishLogin($row, 'ssc-officer', $password, $this->normStatus($row['account_status'] ?? null));
        }

        $row = $this->findIn('student', 'student_id', $email);
        if ($row !== null) {
            return $this->finishLogin($row, 'student', $password, $this->normStatus($row['account_status'] ?? null));
        }

        // No account anywhere: still burn the same time as a real check.
        password_verify($password, self::DUMMY_HASH);
        Response::fail('invalid_credentials', 'Invalid email or password.', 401);
    }

    /**
     * Destroy the current session.
     */
    public function logout(): void
    {
        init_session();
        destroy_session();
    }

    /**
     * Resolve the signed-in user, or null when there is no valid session.
     */
    public function currentUser(): ?array
    {
        init_session();
        $id   = $_SESSION['user_id'] ?? null;
        $role = $_SESSION['role'] ?? null;
        if ($id === null || !is_string($role) || !isset(self::ROLE_TABLES[$role])) {
            return null;
        }

        [$table, $idCol] = self::ROLE_TABLES[$role];
        $row = $this->findById($table, $idCol, (int) $id);
        if ($row === null) {
            // Stale session pointing at a deleted account.
            $this->logout();
            return null;
        }

        $status = $table === 'administrator' ? 'active' : $this->normStatus($row['account_status'] ?? null);
        if ($status !== 'active') {
            $this->logout();
            return null;
        }

        return $this->safeUser($row, $role);
    }

    /**
     * Require a signed-in user, else fail with 401.
     */
    public function requireUser(): array
    {
        $user = $this->currentUser();
        if ($user === null) {
            Response::fail('unauthenticated', 'Sign in to continue.', 401);
        }
        return $user;
    }

    /**
     * Require one of the given roles, else fail with 403.
     *
     * @param string[] $roles  client roles: admin, ssc-officer, student
     */
    public function requireRole(array $roles): array
    {
        $user = $this->requireUser();
        if (!in_array($user['role'], $roles, true)) {
            Response::fail('forbidden', 'Your role cannot perform this action.', 403);
        }
        return $user;
    }

    /**
     * Update the signed-in user's password after verifying the current one.
     */
    public function changePassword(array $user, string $current, string $next): void
    {
        if (strlen($next) < 8) {
            Response::fail('weak_password', 'New password must be at least 8 characters.', 422);
        }
        if (!isset(self::ROLE_TABLES[$user['role']])) {
            Response::fail('server_error', 'An unexpected error occurred.', 500);
        }
        [$table, $idCol] = self::ROLE_TABLES[$user['role']];

        $stmt = $this->db->prepare("SELECT password_hash FROM {$table} WHERE {$idCol} = :id");
        $stmt->execute(['id' => (int) $user['id']]);
        $hash = (string) $stmt->fetchColumn();

        if ($hash === '' || !password_verify($current, $hash)) {
            Response::fail('invalid_credentials', 'Current password is incorrect.', 401);
        }

        $update = $this->db->prepare("UPDATE {$table} SET password_hash = :hash WHERE {$idCol} = :id");
        $update->execute([
            'hash' => password_hash($next, PASSWORD_DEFAULT),
            'id'   => (int) $user['id'],
        ]);
    }

    /**
     * Translate a database role label into the vocabulary the frontend uses.
     */
    public static function clientRole(string $dbRole): string
    {
        return match ($dbRole) {
            'Administrator' => 'admin',
            'SSC Officer'   => 'ssc-officer',
            default         => 'student',
        };
    }

    // ── internals ────────────────────────────────────────────────

    /**
     * Find one row by email in a role table. Returns null when absent.
     */
    private function findIn(string $table, string $idCol, string $email): ?array
    {
        $extra = $table === 'administrator' ? '' : ', account_status';
        $stmt  = $this->db->prepare(
            "SELECT {$idCol} AS id, full_name, email, password_hash{$extra} FROM {$table} WHERE email = :email LIMIT 1"
        );
        $stmt->execute(['email' => $email]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    /**
     * Find one row by primary key in a role table. Returns null when absent.
     */
    private function findById(string $table, string $idCol, int $id): ?array
    {
        $extra = $table === 'administrator' ? '' : ', account_status';
        $stmt  = $this->db->prepare(
            "SELECT {$idCol} AS id, full_name, email, password_hash{$extra} FROM {$table} WHERE {$idCol} = :id LIMIT 1"
        );
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    /**
     * Complete a login once the candidate row is known.
     */
    private function finishLogin(array $row, string $clientRole, string $password, string $status): array
    {
        $hash = (string) ($row['password_hash'] ?? '');
        // password_hash is NULLABLE in attendly_fresh (e.g. an officer row
        // created before credentials were set) — NULL never authenticates,
        // but still costs a verification so the timing stays flat.
        if ($hash === '' || !password_verify($password, $hash)) {
            Response::fail('invalid_credentials', 'Invalid email or password.', 401);
        }

        if ($status === 'pending') {
            Response::fail('officer_pending', 'Your officer account is awaiting administrator approval.', 403);
        }
        if ($status !== 'active') {
            Response::fail('account_inactive', 'This account has been deactivated.', 403);
        }

        init_session();
        regenerate_session();

        $safe = $this->safeUser($row, $clientRole);
        $_SESSION['user_id'] = $safe['id'];
        $_SESSION['role']    = $safe['role'];
        return $safe;
    }

    /**
     * Normalise a DB account_status to active|pending|inactive.
     */
    private function normStatus(?string $dbStatus): string
    {
        return match ($dbStatus) {
            'Active'  => 'active',
            'Pending' => 'pending',
            default   => 'inactive',
        };
    }

    /**
     * Same rule as js/auth.js deriveUsername(): the schema stores no
     * username column, so the client-facing username is derived.
     */
    public static function deriveUsername(string $email): string
    {
        $local   = strtolower(explode('@', $email)[0] ?? '');
        $cleaned = substr((string) preg_replace('/[^a-z0-9_-]/', '', $local), 0, 50);
        return $cleaned !== '' ? $cleaned : 'student';
    }

    /**
     * Strip anything the client must never see.
     *
     * @return array{id:int,name:string,email:string,role:string,username:string}
     */
    private function safeUser(array $row, string $clientRole): array
    {
        $email = (string) $row['email'];
        return [
            'id'       => (int) $row['id'],
            'name'     => (string) $row['full_name'],
            'email'    => $email,
            'role'     => $clientRole,
            'username' => self::deriveUsername($email),
        ];
    }
}
