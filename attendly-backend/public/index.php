<?php
/**
 * ATTENDLY — Front Controller
 *
 * Single entry point for the JSON API. Routed by method + path so the
 * API can live behind one URL instead of a directory of PHP files.
 *
 * Every response is JSON. Errors use a stable envelope:
 *   { "error": { "code": "...", "message": "..." } }
 *
 * The frontend client is js/api.js; both sides were written against the
 * same shapes.
 */

declare(strict_types=1);

require __DIR__ . '/../config/db.php';
require __DIR__ . '/../config/session.php';
require __DIR__ . '/../src/Response.php';
require __DIR__ . '/../src/Auth.php';
require __DIR__ . '/../src/Repository.php';
require __DIR__ . '/../src/routes.php';

use Attendly\Response;
use Attendly\Auth;
use Attendly\Repository;

// ── CORS (config-driven; credentials require an exact origin) ─────
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

$configFile = __DIR__ . '/../config/config.php';
if (!is_file($configFile)) {
    Response::fail('config_missing', 'config/config.php is missing.', 500);
}
$config = require $configFile;

$allowedOrigin = $config['cors']['allowed_origin'] ?? '';
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($allowedOrigin !== '' && $origin === $allowedOrigin) {
    header('Access-Control-Allow-Origin: ' . $allowedOrigin);
    header('Access-Control-Allow-Credentials: true');
    header('Vary: Origin');
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    header('Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
    http_response_code(204);
    exit;
}

// ── Route table ───────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path   = rtrim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/', '/');
if ($path === '') {
    $path = '/';
}

// Strip the mount prefix so the app works from a subdirectory or via
// the PHP built-in server at /index.php.
$prefix = (string) ($config['app']['api_prefix'] ?? '/api');
if ($prefix !== '' && $prefix !== '/' && str_starts_with($path, $prefix)) {
    $path = substr($path, strlen($prefix));
}
$path = '/' . ltrim($path, '/');

try {
    $db    = get_db();
    $repo  = new Repository($db);
    $auth  = new Auth($db);
    $ctx   = ['repo' => $repo, 'auth' => $auth, 'method' => $method, 'config' => $config];

    respond(attendly_route($path, $method, $ctx));
} catch (Throwable $e) {
    // Never leak a stack trace or SQL fragment to the client.
    error_log('[attendly] ' . $e->getMessage());
    Response::fail('server_error', 'An unexpected error occurred.', 500);
}