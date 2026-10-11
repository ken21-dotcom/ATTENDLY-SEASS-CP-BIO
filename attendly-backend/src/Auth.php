<?php
/**
 * ATTENDLY — Session Authentication
 *
 * Passwords are verified with password_verify() against the bcrypt hash
 * stored in users.password_hash. Plaintext is never logged, compared
 * outside this function, or returned to the client.
 *
 * The frontend's localStorage SHA-256 scheme is prototype-only; this is
 * the replacement path.
 */

declare(strict_types=1);

namespace Attendly;

use PDO;

require_once __DIR__ . '/../config/session.php';

final class Auth
{
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
        $stmt = $this->db->prepare(
            'SELECT id, role, username, email, password_hash, status FROM users WHERE email = :email LIMIT 1'
        );
        $stmt->execute(['email' => $email]);
        $user = $stmt->fetch();

        // Always run a verification so a missing account and a wrong
        // password take the same amount of time.
        $hash = $user['password_hash'] ?? '$2y$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';

        if (!password_verify($password, $hash) || $user === false) {
            Response::fail('invalid_credentials', 'Invalid email or password.', 401);
        }

        if (($user['status'] ?? '') !== 'active') {
            Response::fail('account_inactive', 'This account has been deactivated.', 403);
        }

        init_session();
        regenerate_session();

        // Officers stay out until an administrator approves them.
        if ($user['role'] === 'ssc_officer' && !$this->officerApproved((int) $user['id'])) {
            Response::fail('officer_pending', 'Your officer account is awaiting administrator approval.', 403);
        }

        $safe = $this->safeUser($user);

        $_SESSION['user_id'] = $safe['id'];
        $_SESSION['role']    = $safe['role'];

        return $safe;
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
        $id = $_SESSION['user_id'] ?? null;
        if ($id === null) {
            return null;
        }

        $stmt = $this->db->prepare(
            'SELECT id, role, username, email, status FROM users WHERE id = :id LIMIT 1'
        );
        $stmt->execute(['id' => (int) $id]);
        $user = $stmt->fetch();
        if ($user === false || $user['status'] !== 'active') {
            // Stale session pointing at a deleted or disabled account.
            $this->logout();
            return null;
        }

        $user['name'] = $this->displayName((int) $user['id'], $user['role'], $user['username']);
        return $this->safeUser($user);
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
     * @param string[] $roles
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

        $stmt = $this->db->prepare('SELECT password_hash FROM users WHERE id = :id');
        $stmt->execute(['id' => $user['id']]);
        $hash = (string) $stmt->fetchColumn();

        if (!password_verify($current, $hash)) {
            Response::fail('invalid_credentials', 'Current password is incorrect.', 401);
        }

        $update = $this->db->prepare('UPDATE users SET password_hash = :hash WHERE id = :id');
        $update->execute([
            'hash' => password_hash($next, PASSWORD_DEFAULT),
            'id'   => $user['id'],
        ]);
    }

    private function officerApproved(int $userId): bool
    {
        $stmt = $this->db->prepare(
            'SELECT status FROM ssc_officers WHERE user_id = :uid LIMIT 1'
        );
        $stmt->execute(['uid' => $userId]);
        return $stmt->fetchColumn() === 'approved';
    }

    /**
     * Best-effort human name; falls back to the username.
     */
    private function displayName(int $userId, string $role, string $username): string
    {
        if ($role !== 'student') {
            return $username;
        }
        $stmt = $this->db->prepare(
            'SELECT first_name, last_name FROM students WHERE user_id = :uid LIMIT 1'
        );
        $stmt->execute(['uid' => $userId]);
        $row = $stmt->fetch();
        if ($row === false) {
            return $username;
        }
        return trim($row['first_name'] . ' ' . $row['last_name']) ?: $username;
    }

    /**
     * Translate a database role into the vocabulary the frontend uses.
     *
     * The database stores 'administrator' and 'ssc_officer'; every page,
     * requireAuth() guard, pageUrl() case and seeded localStorage record
     * uses 'admin' and 'ssc-officer'. Role is compared after this mapping
     * (see requireRole), so both sides must agree on these strings.
     */
    public static function clientRole(string $dbRole): string
    {
        return match ($dbRole) {
            'administrator' => 'admin',
            'ssc_officer'  => 'ssc-officer',
            default         => $dbRole,
        };
    }

    /**
     * Strip anything the client must never see.
     *
     * @return array{id:int,name:string,email:string,role:string,username:string}
     */
    private function safeUser(array $user): array
    {
        return [
            'id'       => (int) $user['id'],
            'name'     => (string) ($user['name'] ?? $user['username']),
            'email'    => (string) $user['email'],
            'role'     => self::clientRole((string) $user['role']),
            'username' => (string) $user['username'],
        ];
    }
}