/* Cross-boundary contract tests: PHP Repository mappers <-> frontend consumers.
 *
 * These mirror the mapper logic in attendly-backend/src/Repository.php and
 * assert every value can be consumed by the JS that reads it. They are a
 * guard against vocabulary drift across the API boundary.
 *
 * Run: node tools/api-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    pass++;
  } else {
    failures.push(name + (detail ? ' -> ' + detail : ''));
  }
}

/* ── Mirrors of the PHP mappers ─────────────────────────────────── */

const clientRole = (db) => ({ administrator: 'admin', ssc_officer: 'ssc-officer' }[db] ?? db);

function mapAttendance(row) {
  const checkIn = String(row.check_in_time);
  const time = checkIn.slice(11, 16);
  const status = time > '08:15' ? 'late' : 'present';
  return {
    id: Number(row.id),
    eventId: Number(row.event_id),
    studentId: Number(row.student_id),
    studentIdNumber: row.student_id_number ?? null,
    date: checkIn.slice(0, 10),
    time,
    status,
    verificationMethod: row.verification_method,
  };
}

function mapSanction(row) {
  const decidedAt = String(row.decided_at);
  return {
    id: Number(row.id),
    studentId: Number(row.student_id),
    studentName: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
    studentIdNumber: row.student_id_number ?? null,
    recommendationId: row.recommendation_id != null ? Number(row.recommendation_id) : null,
    severity: row.type,
    description: row.decision_notes ?? '',
    date: decidedAt.slice(0, 10),
    status: row.lifted_at === null ? 'active' : 'resolved',
    decidedBy: Number(row.decided_by),
    liftedAt: row.lifted_at,
  };
}

function mapEvent(row) {
  const mandatory = row.event_type === 'mandatory';
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description,
    date: row.event_date,
    time: String(row.start_time).slice(0, 5),
    startTime: String(row.start_time).slice(0, 5),
    endTime: String(row.end_time).slice(0, 5),
    location: row.venue,
    type: mandatory ? 'major' : 'minor',
    mandatory,
    recurring: null,
    status: row.status,
  };
}

// Inverse of mapEvent, mirroring api.toEventPayload in js/api.js.
function toEventPayload(uiEvent, endTime) {
  const start = uiEvent.time || '00:00';
  const [h, m] = start.split(':').map(Number);
  const total = h * 60 + m + 60;
  const end = endTime || [String(Math.floor(total / 60) % 24).padStart(2, '0'), String(total % 60).padStart(2, '0')].join(':');
  return {
    name: uiEvent.name,
    date: uiEvent.date,
    startTime: start,
    endTime: end,
    venue: uiEvent.location,
    eventType: uiEvent.type === 'major' ? 'mandatory' : 'optional',
    description: uiEvent.description || null,
  };
}

/* ── Frontend expectations, extracted from the real source ──────── */

const studentJs = read('student-attendance-system/js/student.js');
const uiJs = read('student-attendance-system/js/ui.js');
const sscJs = read('student-attendance-system/js/ssc.js');
const dataJs = read('student-attendance-system/js/data.js');
const authJs = read('student-attendance-system/js/auth.js');

/* ── 1. Roles reach a page that exists ──────────────────────────── */

const pageUrl = (role) => ({
  login: 'login.html',
  student: 'student/student-dashboard.html',
  'ssc-officer': 'ssc-officer/ssc-dashboard.html',
  admin: 'administrator/admin-dashboard.html',
}[role] ?? 'login.html');

for (const dbRole of ['student', 'ssc_officer', 'administrator']) {
  const mapped = clientRole(dbRole);
  ok(`role ${dbRole} -> ${mapped}`, mapped !== 'login.html', pageUrl(mapped));
}
for (const role of ['student', 'ssc-officer', 'admin']) {
  ok(`pageUrl handles ${role}`, authJs.includes(`case '${role}'`));
}

/* ── 2. Attendance records satisfy every field student.js reads ─── */

const att = mapAttendance({
  id: 1, event_id: 7, student_id: 42,
  check_in_time: '2026-03-04 08:40:05',
  verification_method: 'fingerprint',
  student_id_number: 'S-042',
});

ok('attendance.studentId', typeof att.studentId === 'number');
ok('attendance.eventId', typeof att.eventId === 'number');
ok('attendance.date formatted', /^\d{4}-\d{2}-\d{2}$/.test(att.date), att.date);
ok('attendance.time HH:MM', /^\d{2}:\d{2}$/.test(att.time), att.time);
ok('attendance.status in safeToken allowlist',
  ['present', 'late', 'absent', 'excused'].includes(att.status), att.status);
ok('late threshold applied', att.status === 'late', `08:40 -> ${att.status}`);

const early = mapAttendance({ id: 2, event_id: 7, student_id: 42, check_in_time: '2026-03-04 08:00:00', verification_method: 'manual' });
ok('on-time is present', early.status === 'present', `08:00 -> ${early.status}`);

// Exactly at the boundary must count as present, not late.
const boundary = mapAttendance({ id: 3, event_id: 7, student_id: 42, check_in_time: '2026-03-04 08:15:00', verification_method: 'fingerprint' });
ok('08:15 boundary is present', boundary.status === 'present', `08:15 -> ${boundary.status}`);

ok('student.js reads attendance.status', studentJs.includes("record.status === 'present'"));
ok('student.js reads attendance.time', studentJs.includes('record.time'));
ok('student.js reads attendance.date', studentJs.includes('formatDate(record.date)'));

/* ── 3. Sanctions satisfy student.js and severityBadge ──────────── */

const sanction = mapSanction({
  id: 9, recommendation_id: 3, student_id: 42, type: 'probation',
  decided_by: 1, decision_notes: 'Repeated tardiness',
  decided_at: '2026-03-01 10:00:00', lifted_at: null,
  first_name: 'Ana', last_name: 'Dela Cruz', student_id_number: 'S-042',
});

ok('sanction.studentId', typeof sanction.studentId === 'number');
ok('sanction.date formatted', /^\d{4}-\d{2}-\d{2}$/.test(sanction.date), sanction.date);
ok('sanction.description non-empty', sanction.description.length > 0);
ok('sanction.status is active', sanction.status === 'active');

const lifted = mapSanction({
  id: 10, recommendation_id: 4, student_id: 42, type: 'warning',
  decided_by: 1, decision_notes: 'x', decided_at: '2026-03-01 10:00:00',
  lifted_at: '2026-04-01 09:00:00', first_name: 'Ana', last_name: 'Reyes',
});

// The frontend toggles active <-> resolved; it must never see 'lifted'.
ok('lifted maps to resolved', lifted.status === 'resolved', lifted.status);
ok("frontend toggles to 'resolved'", sscJs.includes("=== 'active' ? 'resolved' : 'active'"));
ok("no 'lifted' status leaks to the client", !/\? 'active' : 'lifted'/.test(read('attendly-backend/src/Repository.php')));

// severityBadge's classMap is the authority on which tokens render styled.
const classMap = uiJs.slice(uiJs.indexOf('const classMap'), uiJs.indexOf('};', uiJs.indexOf('const classMap')));
const badgeTokens = [...classMap.matchAll(/(\w+)\s*:\s*'badge-/g)].map((m) => m[1]);
for (const row of ['warning', 'probation']) {
  ok(`severity "${row}" has a badge style`, badgeTokens.includes(row), badgeTokens.join(','));
}
for (const sev of [sanction.severity, lifted.severity]) {
  ok(`mapped severity "${sev}" is renderable`, badgeTokens.includes(sev), sev);
}

// severityRank in student.js drives standing calculation.
const rank = { suspension: 3, probation: 2, warning: 1 };
ok('probation ranks above warning', rank[sanction.severity] > rank[lifted.severity]);

/* ── 4. Events satisfy the renderer in loadEventsTable ──────────── */

const event = mapEvent({
  id: 5, name: 'Orientation', description: null,
  event_date: '2026-03-10', start_time: '08:00:00', end_time: '10:00:00',
  venue: 'Hall A', event_type: 'mandatory', status: 'scheduled',
});

// The authoritative list of event types is the safeToken allowlist the
// renderer passes, not the schema's enum and not our own assumptions.
const typeAllowlist = sscJs.match(/safeToken\(type,\s*\[([^\]]+)\]/);
ok('renderer passes a type allowlist to safeToken', !!typeAllowlist);
const uiTypes = typeAllowlist ? [...typeAllowlist[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

for (const t of ['major', 'minor']) {
  ok(`UI event type "${t}" is in the renderer's allowlist`, uiTypes.includes(t), uiTypes.join(','));
}

// A hydrated event must produce a token the renderer will accept.
ok('mapped mandatory type is renderable', uiTypes.includes(event.type), event.type);
const optionalEvent = mapEvent({ ...{ id: 6, name: 'Opt-in', event_date: '2026-03-11', start_time: '09:00:00', end_time: '10:00:00', venue: 'Hall B', event_type: 'optional', status: 'scheduled' } });
ok('mapped optional type is renderable', uiTypes.includes(optionalEvent.type), optionalEvent.type);

// The renderer prints mandatory ? 'Mandatory' : 'Optional', so a
// mandatory event must not arrive with a falsy flag.
ok('mandatory event carries mandatory=true', event.mandatory === true, String(event.mandatory));
ok('optional event carries mandatory=false', optionalEvent.mandatory === false);

// The table prints event.location; the schema column is venue.
ok('renderer reads event.location', sscJs.includes('escapeHtml(event.location)'));
ok('mapped event has location', event.location === 'Hall A');
ok('mapped event has no venue key', !('venue' in event), Object.keys(event).join(','));

// recurring is read but null-guarded, so null is safe.
ok('renderer null-guards recurring', sscJs.includes('${recurring ?'));
ok('mapped recurring is falsy', !event.recurring);

// Formatters must receive a value they can parse.
ok('event.time HH:MM', /^\d{2}:\d{2}$/.test(event.time), event.time);
ok('renderer formats event.date', sscJs.includes('formatDate(event.date)'));
ok('data.js groups events by type', dataJs.includes('counts[event.type]'));

/* ── 4b. Write path is the exact inverse of the read path ───────── */

for (const dbRow of [
  { event_type: 'mandatory', venue: 'Hall A', start_time: '08:00:00', end_time: '09:30:00', event_date: '2026-03-10', name: 'Foundation Day', id: 1 },
  { event_type: 'optional', venue: 'Hall B', start_time: '23:30:00', end_time: '00:30:00', event_date: '2026-03-11', name: 'Opt-in Clinic', id: 2 },
]) {
  const roundTripped = toEventPayload(mapEvent(dbRow), mapEvent(dbRow).endTime);
  ok(`type round-trips for ${dbRow.event_type}`, roundTripped.eventType === dbRow.event_type, roundTripped.eventType);
  ok(`name round-trips for ${dbRow.name}`, roundTripped.name === dbRow.name);
  ok(`date round-trips for ${dbRow.name}`, roundTripped.date === dbRow.event_date);
  ok(`venue/location round-trips for ${dbRow.name}`, roundTripped.venue === dbRow.venue, roundTripped.venue);
}

// A single-time form has no end field, so the default must be sane.
ok('endTime defaults to +1h', toEventPayload({ time: '08:00' }).endTime === '09:00', toEventPayload({ time: '08:00' }).endTime);
ok('endTime wraps past midnight', toEventPayload({ time: '23:30' }).endTime === '00:30', toEventPayload({ time: '23:30' }).endTime);
ok('major maps to mandatory', toEventPayload({ type: 'major' }).eventType === 'mandatory');
ok('minor maps to optional', toEventPayload({ type: 'minor' }).eventType === 'optional');
ok('unknown type defaults to optional', toEventPayload({ type: 'weird' }).eventType === 'optional');

/* ── 5. No mapper emits snake_case to the client ────────────────── */

const repo = read('attendly-backend/src/Repository.php');
for (const method of ['mapUser', 'mapEvent', 'mapAttendance', 'mapSanction']) {
  const start = repo.indexOf('function ' + method);
  ok(`${method} exists`, start !== -1);
  if (start === -1) continue;
  const body = repo.slice(start, repo.indexOf('\n    }', start));
  // Keys must be camelCase; no raw column names may appear as array keys.
  const keys = [...body.matchAll(/'([a-z_]+)'\s*=>/g)].map((m) => m[1]);
  const snake = keys.filter((k) => k.includes('_'));
  ok(`${method} emits no snake_case keys`, snake.length === 0, snake.join(','));
}

/* ── Report ─────────────────────────────────────────────────────── */

if (failures.length === 0) {
  console.log(`  ${pass} contract assertions passed`);
  process.exit(0);
}
console.log(`  ${pass} passed, ${failures.length} FAILED:`);
for (const f of failures) console.log('    - ' + f);
process.exit(1);
