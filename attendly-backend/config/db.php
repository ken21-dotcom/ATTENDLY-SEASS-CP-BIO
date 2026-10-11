<?php
/**
 * ATTENDLY — PDO Database Connection
 *
 * Returns a configured PDO instance. Uses a singleton pattern
 * so the connection is shared across the request.
 */

declare(strict_types=1);

function get_db(): PDO
{
    static $pdo = null;

    if ($pdo !== null) {
        return $pdo;
    }

    $cfgFile = __DIR__ . '/config.php';
    if (!is_file($cfgFile)) {
        http_response_code(500);
        echo json_encode([
            'error' => [
                'code'    => 'config_missing',
                'message' => 'config/config.php is missing. Copy config.example.php to config.php and set your values.',
            ],
        ]);
        exit;
    }

    $cfg = require $cfgFile;
    $db  = $cfg['db'];

    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=%s',
        $db['host'],
        $db['port'],
        $db['dbname'],
        $db['charset']
    );

    $pdo = new PDO($dsn, $db['user'], $db['password'], [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,  // real prepared statements
    ]);
    // Ensure TIMESTAMP comparisons use the server's local time zone
    // (set in config.example.php as db.time_zone, e.g. '+08:00' for Asia/Manila).
    $tz = $cfg['db']['time_zone'] ?? 'SYSTEM';
    if ($tz !== 'SYSTEM') {
        $pdo->exec("SET time_zone = '{$tz}'");
    }

    return $pdo;
}
