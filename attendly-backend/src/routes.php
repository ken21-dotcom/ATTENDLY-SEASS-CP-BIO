<?php
/**
 * ATTENDLY — Route Table
 *
 * Maps method + path to a handler. Paths support ":param" segments and
 * are matched in declaration order, so literal paths must come before
 * parameterised ones.
 *
 * $ctx = ['repo' => Repository, 'auth' => Auth, 'method' => string, 'config' => array]
 */

declare(strict_types=1);

use Attendly\Response;

/**
 * Send a matched route's payload to the client and end the request.
 *
 * @param array{0:int,1:callable} $route
 */
function respond(array $route): void
{
    [$status, $handler] = $route;
    Response::ok($handler(), $status);
}

/**
 * @param array<string,mixed> $ctx
 * @return array{0:int,1:callable}
 */
function attendly_route(string $path, string $method, array $ctx): array
{
    $repo  = $ctx['repo'];
    $auth  = $ctx['auth'];
    $config = $ctx['config'];
    $match = null;

    $routes = [
        // ── Health ──
        ['GET', '/health', fn(): array => ['status' => 'ok']],

        // ── Auth ──
        ['POST', '/auth/login', function () use ($auth): array {
            $body = Response::body();
            return $auth->login(
                Response::requireString($body, 'email'),
                Response::requireString($body, 'password')
            );
        }],
        ['POST', '/auth/logout', function () use ($auth): array {
            $auth->logout();
            return ['ok' => true];
        }],
        ['GET', '/auth/me', function () use ($auth): array {
            return $auth->currentUser() ?? ['user' => null];
        }],
        ['POST', '/auth/password', function () use ($auth): array {
            $user = $auth->requireUser();
            $body = Response::body();
            $auth->changePassword(
                $user,
                Response::requireString($body, 'currentPassword'),
                Response::requireString($body, 'newPassword')
            );
            return ['ok' => true];
        }],

        ['POST', '/auth/signup', function () use ($repo): array {
            $body = Response::body();
            return $repo->createStudent([
                'username'         => Response::requireString($body, 'username'),
                'email'            => Response::requireString($body, 'email'),
                'password'         => Response::requireString($body, 'password'),
                'studentIdNumber'  => Response::requireString($body, 'studentIdNumber'),
                'firstName'        => Response::requireString($body, 'firstName'),
                'lastName'         => Response::requireString($body, 'lastName'),
                'program'          => Response::requireString($body, 'program'),
                'yearLevel'        => Response::requireString($body, 'yearLevel'),
                'section'          => Response::requireString($body, 'section'),
            ], []);
        }],

        // ── Users ──
        ['GET', '/users', function () use ($repo, $auth): array {
            // Never anonymous: this returns student records and emails.
            return $repo->listUsers($auth->requireRole(['admin', 'ssc-officer', 'student']));
        }],
        ['POST', '/users/students', function () use ($repo, $auth): array {
            $auth->requireRole(['admin']);
            $body = Response::body();
            return $repo->createStudent([
                'username'         => Response::requireString($body, 'username'),
                'email'            => Response::requireString($body, 'email'),
                'password'         => Response::requireString($body, 'password'),
                'studentIdNumber'  => Response::requireString($body, 'studentIdNumber'),
                'firstName'        => Response::requireString($body, 'firstName'),
                'lastName'         => Response::requireString($body, 'lastName'),
                'program'          => Response::requireString($body, 'program'),
                'yearLevel'        => Response::requireString($body, 'yearLevel'),
                'section'          => Response::requireString($body, 'section'),
            ], $auth->currentUser() ?? []);
        }],

        // ── Events ──
        // The kiosk needs the schedule before anyone signs in, so the list
        // is intentionally readable without a session.
        ['GET', '/events', fn(): array => $repo->listEvents()],
        ['POST', '/events', function () use ($repo, $auth): array {
            // events.created_by references ssc_officers(user_id), so an
            // administrator has no valid row to be recorded as the creator.
            // Only approved officers can create events.
            $actor = $auth->requireRole(['ssc-officer']);
            $body  = Response::body();
            return $repo->createEvent([
                'name'        => Response::requireString($body, 'name'),
                'date'        => Response::requireString($body, 'date'),
                'startTime'   => Response::requireString($body, 'startTime'),
                'endTime'     => Response::requireString($body, 'endTime'),
                'venue'       => Response::requireString($body, 'venue'),
                'eventType'   => $body['eventType'] ?? 'mandatory',
                'description' => $body['description'] ?? null,
            ], $actor);
        }],
        ['DELETE', '/events/:id', function () use ($repo, $auth, &$match): array {
            $auth->requireRole(['ssc-officer', 'admin']);
            $repo->deleteEvent(Response::requireId($match, 'id'));
            return ['ok' => true];
        }],
        ['PATCH', '/events/:id', function () use ($repo, $auth, &$match): array {
            $actor = $auth->requireRole(['ssc-officer']);
            $body = Response::body();
            $repo->updateEvent(
                Response::requireId($match, 'id'),
                $body,
                $actor
            );
        }],

// ── Attendance ──
        ['GET', '/attendance', function () use ($repo, $auth, $config): array {
            // Students only ever see their own rows; staff see everything
            // or one event.
            $viewer    = $auth->requireRole(['admin', 'ssc-officer', 'student']);
            $isStudent = $viewer['role'] === 'student';
            // A student cannot widen their scope by passing ?event_id.
            $eventId   = $isStudent ? null : query_id('event_id');
            $studentId = $isStudent ? $viewer['id'] : query_id('student_id');
            return $repo->listAttendance($eventId, $studentId, $config);
        }],
        ['POST', '/attendance/check-in', function () use ($repo): array {
            // The kiosk is intentionally unauthenticated: it identifies a
            // student by ID, not by session.
            $body = Response::body();
            return $repo->checkIn([
                'eventId'            => Response::requireBodyId($body, 'eventId'),
                'studentId'          => Response::requireBodyId($body, 'studentId'),
                'verificationMethod' => $body['verificationMethod'] ?? 'fingerprint',
            ]);
        }],

        // ── Sanctions ──
        ['GET', '/sanctions', function () use ($repo, $auth): array {
            $viewer = $auth->requireRole(['admin', 'ssc-officer', 'student']);
            $studentId = $viewer['role'] === 'student' ? $viewer['id'] : query_id('student_id');
            $statusFilter = $_GET['status'] ?? null;
            return $repo->listSanctions($studentId, $statusFilter);
        }],
    ];

    foreach ($routes as [$routeMethod, $pattern, $handler]) {
        if ($routeMethod !== $method) {
            continue;
        }
        $params = match_path($pattern, $path);
        if ($params !== null) {
            $match = $params;
            return [200, $handler];
        }
    }

    // Path matched a verb we do not implement — tell the client honestly.
    $allowed = [];
    foreach ($routes as [$routeMethod, $pattern]) {
        if (match_path($pattern, $path) !== null) {
            $allowed[] = $routeMethod;
        }
    }
    if ($allowed !== []) {
        header('Allow: ' . implode(', ', $allowed));
        Response::fail('method_not_allowed', 'That method is not supported for this route.', 405);
    }

    Response::fail('not_found', 'No API route matches ' . $path . '.', 404);
}

/**
 * Read an optional positive integer from the query string.
 *
 * Returns null when the parameter is absent, and fails the request when
 * it is present but not a positive whole number — casting "abc" to 0
 * would silently turn a typo into a filter that matches nothing.
 */
function query_id(string $key): ?int
{
    if (!array_key_exists($key, $_GET)) {
        return null;
    }
    return Response::requireBodyId($_GET, $key);
}

/**
 * Match a "/a/:id" pattern against a concrete path.
 *
 * @return array<string,string>|null captured params, or null when no match
 */
function match_path(string $pattern, string $path): ?array
{
    $patternParts = explode('/', trim($pattern, '/'));
    $pathParts    = explode('/', trim($path, '/'));

    if ($path === '/') {
        $patternParts = [];
        $pathParts    = [];
    }

    if (count($patternParts) !== count($pathParts)) {
        return null;
    }

    $params = [];
    foreach ($patternParts as $i => $part) {
        if (str_starts_with($part, ':')) {
            $params[substr($part, 1)] = $pathParts[$i];
            continue;
        }
        if ($part !== $pathParts[$i]) {
            return null;
        }
    }
    return $params;
}