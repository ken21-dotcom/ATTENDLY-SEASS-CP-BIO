<?php
/**
 * ATTENDLY — XAMPP Configuration (C:\xampp\htdocs\attendly\config\config.php)
 *
 * Copy the backend folder into htdocs/, then create this file from config.example.php
 * and adjust the DB / CORS values below.
 */
return [
    'db' => [
        'host'     => '127.0.0.1',
        'port'     => 3306,
        'dbname'   => 'attendly',
        'user'     => 'attendly_app',
        'password' => 'attendly_pass',
        'charset'  => 'utf8mb4',
        'time_zone'=> '+08:00',     // Asia/Manila; change to match your region
    ],
    'session' => [
        'cookie_name'     => 'attendly.sid',
        'cookie_httponly' => true,
        'cookie_secure'   => false,
        'cookie_samesite' => 'Lax',
        'ttl_hours'       => 8,
    ],
    'cors' => [
        'allowed_origin' => 'http://localhost:3000',
    ],
    'default_admin' => [
        'username' => 'admin',
        'email'    => 'admin@example.com',
        'password' => 'password123',
    ],
    'app' => [
        'env'                => 'development',
        'api_prefix'         => '/attendly/api',
        'late_grace_minutes'=> 15,
    ],
];
