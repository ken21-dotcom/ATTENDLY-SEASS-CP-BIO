<?php
/**
 * ATTENDLY — Session Configuration
 *
 * Uses PHP's native session handling with secure cookie settings.
 * Session data is stored on the filesystem by default (XAMPP standard).
 * Session ID is regenerated on login to prevent fixation.
 */

declare(strict_types=1);

function init_session(): void
{
    // Only start a session if one isn't already active
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    $cfg     = require __DIR__ . '/config.php';
    $sess    = $cfg['session'];
    $is_prod = ($cfg['app']['env'] === 'production');

    // Cookie parameters
    session_set_cookie_params([
        'lifetime' => $sess['ttl_hours'] * 3600,
        'path'     => '/',
        'domain'   => '',            // empty = current domain
        'secure'   => $is_prod ? true : $sess['cookie_secure'],
        'httponly'  => $sess['cookie_httponly'],
        'samesite'  => $sess['cookie_samesite'],
    ]);

    // Use a custom cookie name
    session_name($sess['cookie_name']);

    // Session handling settings
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_trans_sid', '0');

    session_start();
}

/**
 * Regenerate the session ID (call on login to prevent session fixation).
 */
function regenerate_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_regenerate_id(true);
    }
}

/**
 * Destroy the session completely (call on logout).
 */
function destroy_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        $_SESSION = [];
        session_destroy();
    }
}
