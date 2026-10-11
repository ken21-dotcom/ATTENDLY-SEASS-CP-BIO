/* Tests for the backend data wiring: hydrateFromApi, isApiEnabled and the
 * event payload translation.
 *
 * These lift the real implementations out of js/api.js rather than
 * restating them, so the assertions cannot drift from the code.
 *
 * Run: node tools/hydration.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/api.js'), 'utf8');

let pass = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) pass++;
  else failures.push(name + (detail !== undefined ? ' -> ' + detail : ''));
}

async function throws(fn) {
  try { await fn(); return false; } catch { return true; }
}

/* ── Lift the real implementations ──────────────────────────────── */
// These resolve API_BASE_URL, api and window from the surrounding scope,
// so they must be declared before the eval below.

var API_BASE_URL = '';
var api = {};
var window = {};

const lift = (name) => eval('(' + apiSrc.match(new RegExp('(?:async )?function ' + name + '[\\s\\S]*?\\n}'))[0] + ')');

const isApiEnabled = lift('isApiEnabled');
const hydrateFromApi = lift('hydrateFromApi');
const addHour = lift('addHour');

/* ── The accessors hydration writes through ─────────────────────── */

function freshStore() {
  const store = {};
  window.setUsers = (v) => { store.users = v; };
  window.setEvents = (v) => { store.events = v; };
  window.setAttendance = (v) => { store.attendance = v; };
  window.setSanctions = (v) => { store.sanctions = v; };
  return store;
}

function workingApi() {
  return {
    listUsers: async () => [{ id: 1, role: 'student', name: 'Ana' }],
    listEvents: async () => [{ id: 7, name: 'Foundation Day', type: 'major', mandatory: true }],
    listAttendance: async () => [{ id: 3, eventId: 7, studentId: 1, status: 'present' }],
    listSanctions: async () => [{ id: 4, studentId: 1, severity: 'probation', status: 'active' }],
  };
}

(async () => {

  /* ── 1. isApiEnabled gates everything ────────────────────────── */

  API_BASE_URL = '';
  ok('disabled when base URL is empty', isApiEnabled() === false);
  API_BASE_URL = '   ';
  ok('disabled when base URL is whitespace', isApiEnabled() === false);
  API_BASE_URL = 'http://localhost:8000/api';
  ok('enabled when base URL is set', isApiEnabled() === true);

  /* ── 2. Disabled mode must not touch the network or the cache ── */

  API_BASE_URL = '';
  api = workingApi();
  let store = freshStore();
  let result = await hydrateFromApi();
  ok('disabled: nothing synced', result.synced.length === 0, JSON.stringify(result.synced));
  ok('disabled: nothing failed', result.failed.length === 0);
  ok('disabled: cache untouched', Object.keys(store).length === 0, Object.keys(store).join(','));
  ok('disabled: never throws', (await throws(() => hydrateFromApi())) === false);

  /* ── 3. Enabled mode primes every collection ─────────────────── */

  API_BASE_URL = 'http://localhost:8000/api';
  api = workingApi();
  store = freshStore();
  result = await hydrateFromApi();
  ok('all four collections synced', result.synced.length === 4, JSON.stringify(result.synced));
  ok('none failed', result.failed.length === 0, JSON.stringify(result.failed));
  ok('users written through setUsers', store.users && store.users[0].name === 'Ana');
  ok('events written through setEvents', store.events && store.events[0].type === 'major');
  ok('attendance written through setAttendance', store.attendance && store.attendance[0].status === 'present');
  ok('sanctions written through setSanctions', store.sanctions && store.sanctions[0].severity === 'probation');

  /* ── 4. One failing collection must not block the others ─────── */

  api = workingApi();
  api.listEvents = async () => { throw new Error('boom'); };
  store = freshStore();
  result = await hydrateFromApi();
  ok('partial failure reported', result.failed.includes('events'), JSON.stringify(result.failed));
  ok('other collections still synced', result.synced.length === 3, JSON.stringify(result.synced));
  ok('failed collection left cache alone', store.events === undefined);
  ok('hydrate never throws on server error', (await throws(() => hydrateFromApi())) === false);

  /* ── 5. A malformed payload is a failure, not silent corruption ─ */

  api = workingApi();
  api.listUsers = async () => ({ not: 'an array' });
  store = freshStore();
  result = await hydrateFromApi();
  ok('non-array response rejected', result.failed.includes('users'), JSON.stringify(result.failed));
  ok('non-array response not written', store.users === undefined);

  /* ── 6. A missing accessor is a failure, not a crash ─────────── */

  api = workingApi();
  store = freshStore();
  delete window.setSanctions;
  result = await hydrateFromApi();
  ok('missing accessor reported', result.failed.includes('sanctions'), JSON.stringify(result.failed));
  ok('missing accessor does not crash', result.synced.includes('users'));

  /* ── 7. The event payload translation ────────────────────────── */

  ok('addHour 08:00 -> 09:00', addHour('08:00') === '09:00', addHour('08:00'));
  ok('addHour 23:30 wraps to 00:30', addHour('23:30') === '00:30', addHour('23:30'));
  ok('addHour 09:07 -> 10:07', addHour('09:07') === '10:07', addHour('09:07'));
  ok('addHour tolerates junk', /^\d{2}:\d{2}$/.test(addHour('nonsense')), addHour('nonsense'));

  // api.toEventPayload is a method on the `api` object literal, so it has to
  // be lifted as `function (event, endTime) {...}` rather than a declaration.
  const toEventPayload = eval('(' + apiSrc.match(/function \(event, endTime\) \{[\s\S]*?\n  \}/)[0] + ')');

  const major = toEventPayload({ name: 'Foundation Day', date: '2026-03-10', time: '08:00', location: 'Hall A', type: 'major' });
  ok('name passed through', major.name === 'Foundation Day');
  ok('date passed through', major.date === '2026-03-10');
  ok('location -> venue', major.venue === 'Hall A', major.venue);
  ok('major -> mandatory', major.eventType === 'mandatory', major.eventType);
  ok('startTime from time', major.startTime === '08:00');
  ok('endTime defaults to +1h', major.endTime === '09:00', major.endTime);
  ok('missing description becomes null', major.description === null);

  const minor = toEventPayload({ name: 'Flag Ceremony', date: '2026-03-11', time: '07:15', location: 'Grounds', type: 'minor' });
  ok('minor -> optional', minor.eventType === 'optional', minor.eventType);
  ok('explicit endTime is respected', toEventPayload({ time: '08:00' }, '11:30').endTime === '11:30');

  /* ── 8. Structural guards on the wiring ──────────────────────── */
  // These cannot run the UI, but they do stop someone deleting a guard and
  // silently making an offline build depend on the network.

  const kioskJs = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/kiosk.js'), 'utf8');
  const sscJs = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/ssc.js'), 'utf8');
  const authSource = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/auth.js'), 'utf8');
  const dataJs = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/data.js'), 'utf8');
  const administratorPanelJs = fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/administrator-panel.js'), 'utf8');

  const recordAttendance = kioskJs.slice(kioskJs.indexOf('async function recordAttendance'), kioskJs.indexOf('// ── Result overlay'));
  ok('recordAttendance is async', /async function recordAttendance/.test(kioskJs));
  ok('kiosk server call is gated on isApiEnabled', recordAttendance.includes('isApiEnabled()'));
  ok('kiosk server call also requires numeric ids', /typeof currentEventId === 'number'/.test(recordAttendance));
  ok('kiosk still writes a local record when offline', /record \|\| \{/.test(recordAttendance));
  ok('kiosk keeps the excused flag', /excused:/.test(recordAttendance));
  ok('kiosk surfaces a server failure', /'server-error'/.test(kioskJs));
  const awaits = (kioskJs.match(/await recordAttendance/g) || []).length;
  ok('both kiosk call sites await recordAttendance', awaits === 2, String(awaits));

  ok('ssc event create is gated on isApiEnabled', /function syncEventToServer[\s\S]*?if \(!isApiEnabled\(\)\) return;/.test(sscJs));
  ok('ssc event delete is gated on isApiEnabled', /function syncEventDeleteToServer[\s\S]*?if \(!isApiEnabled\(\) \|\| typeof eventId !== 'number'\) return;/.test(sscJs));
  ok('ssc create adopts the server row', /Object\.assign\(\{\}, e, saved\)/.test(sscJs));

  ok('API login hydrates before redirecting', /await hydrateFromApi\(\)/.test(authSource));
  ok('partial hydration failure is reported', /hydration\.failed\.length/.test(authSource));
  ok('logout restores the demo dataset', /resetDemoData\(\)/.test(authSource));
  ok('resetDemoData exists', /function resetDemoData/.test(dataJs));
  ok('resetDemoData clears every registered key', /Object\.values\(STORAGE_KEYS\)\.forEach/.test(dataJs));
  ok('resetDemoData replays the seed migrations', /initMockData\(\);\s*\}\s*$/m.test(dataJs) || dataJs.includes('initMockData();'));

  /* ── 9. Documented sync coverage must match reality ─────────── */
  // The comment block in api.js lists what is and is not synced. If someone
  // adds a write path they must update it, and this asserts the two agree.

  ok('api.js documents sync coverage', /What is and is not synced/.test(apiSrc));
  ok('coverage notes student create is local only', /student create \.+ LOCAL ONLY/.test(apiSrc));

  const syncedWrites = [
    ['event create is wired', /function syncEventToServer/.test(sscJs)],
    ['event delete is wired', /function syncEventDeleteToServer/.test(sscJs)],
    ['kiosk check-in is wired', /api\.checkIn\(/.test(kioskJs)],
  ];
  for (const [name, wired] of syncedWrites) {
    ok(`${name} and is documented as synced`, wired);
  }

  // Student creation must NOT pretend to sync: the endpoint needs fields no
  // page collects. If someone adds the fields later, update both.
  ok('student create does not call the API', !/api\.createStudent\(/.test(administratorPanelJs));
  ok('student create is not claimed as synced', !/student create \.+ synced/.test(apiSrc));

  /* ── Report ────────────────────────────────────────────────── */

  if (failures.length === 0) {
    console.log(`  ${pass} hydration assertions passed`);
    process.exit(0);
  }
  console.log(`  ${pass} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log('    - ' + f);
  process.exit(1);
})();
