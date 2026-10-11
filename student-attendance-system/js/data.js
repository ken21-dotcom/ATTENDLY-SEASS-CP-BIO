/* ============================================================
   Data Layer — localStorage helpers, mock data, session management
   ------------------------------------------------------------
   All persistence for the ATTENDLY prototype runs through this
   module. Every entity (users, events, attendance, sanctions,
   etc.) has a typed get/set pair that serialises to localStorage.

   Production note: localStorage is used only for the prototype.
   A real deployment stores everything server-side and this file
   becomes a thin API-client wrapper.

   STORAGE_KEYS use the "attendly_" prefix to avoid collisions
   with other applications on the same origin.
   ============================================================ */

// ── Storage key registry ──
const STORAGE_KEYS = Object.freeze({
  users:                'attendly_users',
  attendance:           'attendly_attendance',
  events:               'attendly_events',
  sanctions:            'attendly_sanctions',
  announcements:        'attendly_announcements',
  appeals:              'attendly_appeals',
  biometrics:           'attendly_biometrics',
  biometricAudit:       'attendly_biometric_audit',
  reenrollmentRequests: 'attendly_reenrollment_requests',
  session:              'attendly_session',
  sanctionPolicy:       'attendly_sanction_policy',
  flaggedStudents:      'attendly_flagged_students',
  dummyDataVersion:     'attendly_dummy_data_version',
});

// ── Default sanction policy thresholds ──
// These define the number of unexcused absences that trigger
// each severity level, broken down by event type.
const DEFAULT_SANCTION_POLICY = Object.freeze({
  minor: { warning: 3, probation: 5, suspension: 7 },
  major: { warning: 1, probation: 2, suspension: 3 },
});


/* ============================================================
   Student Organisational Taxonomy (Department → Course → Year)
   ------------------------------------------------------------
   Students are grouped under these headings on the manage-
   students pages. Values are prototype sample data — a real
   deployment pulls departments/courses from the registrar.
   ============================================================ */

const DEPARTMENTS = Object.freeze([
  'School of Computing Studies',
  'School of Nursing',
  'School of Business and Administration',
]);

const COURSES_BY_DEPARTMENT = Object.freeze({
  'School of Computing Studies': ['BSIT – Bachelor of Science in Information Technology'],
  'School of Nursing': ['BSN – Bachelor of Science in Nursing'],
  'School of Business and Administration': [
    'BSE – Bachelor of Science in Entrepreneurship',
    'BSHM – Bachelor of Science in Hospitality Management',
    'BSTM – Bachelor of Science in Tourism Management',
  ],
});

const YEAR_LEVELS = Object.freeze(['1', '2', '3', '4']);

/** Fallback bucket used whenever a student record lacks an org field. */
const UNASSIGNED = 'Unassigned';


/* ============================================================
   Password Hashing — SHA-256 (FIPS 180-4)
   ------------------------------------------------------------
   Demo/stored passwords are hashed before they ever touch
   localStorage, so plaintext is never persisted. This compact
   synchronous implementation works from any origin (file://
   included) without Web Crypto's secure-context requirement.

   Production note: this is a prototype-only convenience. A real
   deployment hashes with bcrypt/argon2 server-side (see the PHP
   backend, which uses PHP's password_hash() / password_verify()).
   ============================================================ */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

/**
 * UTF-8-safe SHA-256 of a string, returned as a 64-char lowercase hex digest.
 * @param {string} message
 * @returns {string}
 */
function sha256Hex(message) {
  const str = String(message);
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0xd800 || c >= 0xe000)
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else { // surrogate pair → 4-byte sequence
      c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(++i) & 0x3ff));
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length (high 32 bits zero for our short inputs)
  bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);

  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++)
      w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = sha256Rotr(w[i - 15], 7) ^ sha256Rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = sha256Rotr(w[i - 2], 17) ^ sha256Rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], h7 = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = sha256Rotr(e, 6) ^ sha256Rotr(e, 11) ^ sha256Rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h7 + s1 + ch + SHA256_K[i] + w[i]) | 0;
      const s0 = sha256Rotr(a, 2) ^ sha256Rotr(a, 13) ^ sha256Rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h7 = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + h7) | 0;
  }
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * Hash a password for storage. See note above on prototype scope.
 * @param {string} plain
 * @returns {string} 64-char lowercase hex digest
 */
function hashPassword(plain) {
  return sha256Hex(String(plain));
}

/** True when a stored (SHA-256 hex) value matches the typed password. */
function passwordMatches(plain, stored) {
  return typeof stored === 'string' && stored === hashPassword(plain);
}

/** A stored SHA-256 digest is always 64 lowercase hex chars. */
const HASHED_PASSWORD_RE = /^[a-f0-9]{64}$/;

/** The fixed demo cohort shown in the grouped student-management views. */
function getDemoStudentCohort() {
  const student = (id, name, email, department, course, yearLevel) => ({
    id, name, email, password: hashPassword('password123'), role: 'student', department, course, yearLevel,
  });
  const computing = 'School of Computing Studies';
  const nursing = 'School of Nursing';
  const business = 'School of Business and Administration';
  const bsit = 'BSIT – Bachelor of Science in Information Technology';
  const bsn = 'BSN – Bachelor of Science in Nursing';
  const bse = 'BSE – Bachelor of Science in Entrepreneurship';
  const bshm = 'BSHM – Bachelor of Science in Hospitality Management';
  const bstm = 'BSTM – Bachelor of Science in Tourism Management';

  return [
    student('u1', 'John Student', 'student@example.com', computing, bsit, '3'),
    student('u7', 'Ana Dela Cruz', 'ana@example.com', computing, bsit, '1'),
    student('u9', 'Carlo Mendoza', 'carlo.mendoza@example.com', computing, bsit, '2'),
    student('u10', 'Diana Flores', 'diana.flores@example.com', computing, bsit, '4'),
    student('u3', 'Alice Student', 'alice@example.com', nursing, bsn, '1'),
    student('u8', 'Patrick Lim', 'patrick@example.com', nursing, bsn, '4'),
    student('u11', 'Bea Ramos', 'bea.ramos@example.com', nursing, bsn, '2'),
    student('u12', 'Noel Garcia', 'noel.garcia@example.com', nursing, bsn, '3'),
    student('u4', 'Bob Student', 'bob@example.com', business, bse, '2'),
    student('u13', 'Erica Villanueva', 'erica.villanueva@example.com', business, bse, '1'),
    student('u14', 'Francis Cruz', 'francis.cruz@example.com', business, bse, '3'),
    student('u15', 'Grace Torres', 'grace.torres@example.com', business, bse, '4'),
    student('u5', 'Maria Santos', 'maria@example.com', business, bshm, '2'),
    student('u16', 'Hannah Reyes', 'hannah.reyes@example.com', business, bshm, '1'),
    student('u17', 'Ivan Lopez', 'ivan.lopez@example.com', business, bshm, '3'),
    student('u18', 'Janelle Aquino', 'janelle.aquino@example.com', business, bshm, '4'),
    student('u6', 'Jose Reyes', 'jose@example.com', business, bstm, '3'),
    student('u19', 'Kyle Navarro', 'kyle.navarro@example.com', business, bstm, '1'),
    student('u20', 'Lara Castillo', 'lara.castillo@example.com', business, bstm, '2'),
    student('u21', 'Miguel Bautista', 'miguel.bautista@example.com', business, bstm, '4'),
  ];
}


/* ============================================================
   Seed Data — populates localStorage on first visit
   ============================================================ */

/**
 * Initialize mock data if not already present.
 * Safe to call on every page load — each block is guarded by
 * an existence check so existing data is never overwritten.
 */
function initMockData() {
  const today = todayStr();
  const tomorrow = todayStr(1);
  // One-time-migration version. Each bump below runs only for storage whose
  // recorded version is older, so already-migrated (or freshly seeded) local
  // storage is untouched. Set to the newest value at the end of this function.
  const dummyVersion = parseInt(localStorage.getItem(STORAGE_KEYS.dummyDataVersion) || '0', 10) || 0;

  // ── Users (passwords stored as SHA-256 hashes — see hashPassword) ──
  if (!localStorage.getItem(STORAGE_KEYS.users)) {
    const users = [
      // ── Admins ──
      { id: 'u0',  name: 'System Administrator', email: 'admin@example.com',         password: hashPassword('password123'), role: 'admin' },
      { id: 'u0a', name: 'Maria Clara Santos',   email: 'santos.admin@example.com',  password: hashPassword('password123'), role: 'admin' },

      // ── SSC Officers ──
      { id: 'u2',  name: 'SSC Officer',          email: 'officer@example.com',       password: hashPassword('password123'), role: 'ssc-officer', status: 'active' },
      { id: 'u2a', name: 'Carlos Reyes',         email: 'reyes.officer@example.com', password: hashPassword('password123'), role: 'ssc-officer', status: 'active' },

      // ── Students ──
      ...getDemoStudentCohort(),
    ];
    localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(users));
  } else {
    /* ── Migration: ensure admin account exists and backfill officer status ── */
    let users = safeGet(STORAGE_KEYS.users, []);
    let changed = false;

    /* Add admin if missing (hashed password) */
    if (!users.some(u => u.role === 'admin')) {
      users.push({ id: 'u0', name: 'System Administrator', email: 'admin@example.com', password: hashPassword('password123'), role: 'admin' });
      changed = true;
    }

    /* Backfill officer status field */
    users = users.map(u => {
      if (u.role === 'ssc-officer' && !u.status) {
        changed = true;
        return { ...u, status: 'active' };
      }
      return u;
    });

    /* ── Dummy-data migration (v2) ──
       Add the extra admin, officer and student accounts for storage that
       predates them. New accounts are only added once per id, so a student
       a user deliberately deletes is NOT re-seeded on later visits. ── */
    if (dummyVersion < 2) {
      const additions = [
        { id: 'u0a', name: 'Maria Clara Santos',        email: 'santos.admin@example.com',  password: hashPassword('password123'), role: 'admin' },
        { id: 'u2a', name: 'Carlos Reyes',              email: 'reyes.officer@example.com', password: hashPassword('password123'), role: 'ssc-officer', status: 'active' },
      ];
      const existingIds = new Set(users.map(u => u.id));
      additions.forEach(a => {
        if (!existingIds.has(a.id)) {
          users.push(a);
          changed = true;
        }
      });
    }

    /* ── Password-hash migration (v3) ──
       Re-hash any legacy plaintext passwords (pre-hash storage) into SHA-256
       digests. Idempotent: a value that already looks like a digest is kept. ── */
    if (dummyVersion < 3) {
      users = users.map(u => {
        if (typeof u.password === 'string' && u.password && !HASHED_PASSWORD_RE.test(u.password)) {
          changed = true;
          return { ...u, password: hashPassword(u.password) };
        }
        return u;
      });
    }

    /* Academic-cohort migration (v4): update only known demo account IDs and
       add the requested cohort. Independently created student accounts stay. */
    if (dummyVersion < 4) {
      const cohort = getDemoStudentCohort();
      const cohortIds = new Set(cohort.map(student => student.id));
      users = [...users.filter(user => !cohortIds.has(user.id)), ...cohort];
      changed = true;
    }

    if (changed) {
      localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(users));
    }
  }

  // Backfill department/course/yearLevel on student records that
  // predate the organisational grouping (no-op when already set).
  backfillStudentOrg();

  // ── Events ──
  if (!localStorage.getItem(STORAGE_KEYS.events)) {
    const events = [
      { id: 'e1', name: 'Tech Workshop',      date: today,     time: '10:00', location: 'Room A',       type: 'minor', mandatory: false, recurring: null },
      { id: 'e2', name: 'Seminar on AI',       date: tomorrow,  time: '14:00', location: 'Auditorium',   type: 'major', mandatory: true,  recurring: null },
      { id: 'e3', name: 'Weekly Flag Ceremony', date: today,     time: '07:00', location: 'Quadrangle',   type: 'minor', mandatory: true,  recurring: { pattern: 'weekly', day: 'Monday' } },
    ];
    localStorage.setItem(STORAGE_KEYS.events, JSON.stringify(events));
  }

  // ── Attendance ──
  if (!localStorage.getItem(STORAGE_KEYS.attendance)) {
    const attendance = [
      { id: 'a1', studentId: 'u1', eventId: 'e1', date: today,     time: '10:05', status: 'present', excused: false, excuseReason: '' },
      { id: 'a2', studentId: 'u4', eventId: 'e1', date: today,     time: '10:12', status: 'late',    excused: false, excuseReason: '' },
      { id: 'a3', studentId: 'u3', eventId: 'e1', date: today,     time: null,    status: 'absent',  excused: true,  excuseReason: 'Documented medical appointment' },
      { id: 'a4', studentId: 'u3', eventId: 'e3', date: today,     time: null,    status: 'absent',  excused: false, excuseReason: '' },
      { id: 'a5', studentId: 'u3', eventId: 'e2', date: tomorrow,  time: null,    status: 'absent',  excused: false, excuseReason: '' },
    ];
    localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(attendance));
  }

  // ── Sanctions ──
  if (!localStorage.getItem(STORAGE_KEYS.sanctions)) {
    const yesterday = todayStr(-1);
    const lastWeek  = todayStr(-7);
    const sanctions = [
      {
        id: 's1', studentId: 'u1', description: 'Repeated tardiness',
        severity: 'warning', status: 'active', date: today, officerId: 'u2', eventId: 'e1',
        notes: 'Student arrived 15 minutes late for the third consecutive time. Verified via kiosk timestamp.',
      },
      {
        id: 's2', studentId: 'u4', description: 'Unexcused absence',
        severity: 'probation', status: 'active', date: yesterday, officerId: 'u2', eventId: 'e2',
        notes: 'Student did not attend the Seminar on AI without prior notification. No appeal on file.',
      },
      {
        id: 's3', studentId: 'u1', description: 'Missing biometric enrollment',
        severity: 'warning', status: 'resolved', date: lastWeek, officerId: 'u2', eventId: null,
        notes: 'Student was reminded to complete biometric enrollment. Resolved after compliance.',
      },
    ];
    localStorage.setItem(STORAGE_KEYS.sanctions, JSON.stringify(sanctions));
  }

  // ── Appeals ──
  if (!localStorage.getItem(STORAGE_KEYS.appeals)) {
    const appeals = [
      {
        id: 'ap1', studentId: 'u1', sanctionId: 's3',
        reason: 'I was sick during the enrollment period and could not attend.',
        status: 'approved', date: todayStr(-5), reviewedBy: 'u2',
        reviewNotes: 'Medical certificate verified. Appeal approved.',
      },
    ];
    localStorage.setItem(STORAGE_KEYS.appeals, JSON.stringify(appeals));
  }

  // ── Sanction policy (configurable thresholds) ──
  if (!localStorage.getItem(STORAGE_KEYS.sanctionPolicy)) {
    localStorage.setItem(STORAGE_KEYS.sanctionPolicy, JSON.stringify(DEFAULT_SANCTION_POLICY));
  }

  // ── Flagged students (auto-generated, officer reviews) ──
  if (!localStorage.getItem(STORAGE_KEYS.flaggedStudents)) {
    localStorage.setItem(STORAGE_KEYS.flaggedStudents, JSON.stringify([]));
  }

  // ── Biometrics ──
  // Seed data so the kiosk's fingerprint simulation has enrolled
  // students to match against. In production these templates are
  // stored server-side and never sent to the browser (see backend/).
  if (!localStorage.getItem(STORAGE_KEYS.biometrics)) {
    const biometrics = [
      { studentId: 'u1', templateId: 'tmpl_enroll_u1',          registeredAt: todayStr(-6),  status: 'enrolled',            quality: 'good',  consentCaptured: true, identityVerified: true },
      { studentId: 'u3', templateId: 'tmpl_enroll_u3',          registeredAt: todayStr(-20), status: 'enrolled',            quality: 'good',  consentCaptured: true, identityVerified: true },
      { studentId: 'u4', templateId: 'tmpl_needs_reenroll_u4',  registeredAt: todayStr(-40), status: 'needs-reenrollment',  quality: 'poor',  consentCaptured: true, identityVerified: false },
      { studentId: 'u5', templateId: 'tmpl_enroll_u5',          registeredAt: todayStr(-12), status: 'enrolled',            quality: 'good',  consentCaptured: true, identityVerified: true },
      { studentId: 'u6', templateId: 'tmpl_enroll_u6',          registeredAt: todayStr(-15), status: 'enrolled',            quality: 'good',  consentCaptured: true, identityVerified: true },
      { studentId: 'u7', templateId: 'tmpl_needs_reenroll_u7',  registeredAt: todayStr(-55), status: 'needs-reenrollment',  quality: 'poor',  consentCaptured: true, identityVerified: false },
      { studentId: 'u8', templateId: 'tmpl_enroll_u8',          registeredAt: todayStr(-9),  status: 'enrolled',            quality: 'good',  consentCaptured: true, identityVerified: true },
    ];
    localStorage.setItem(STORAGE_KEYS.biometrics, JSON.stringify(biometrics));
  }

  // ── Biometrics migration (dummy-data v2) ──
  // Same one-time guard as the users migration: add enrollments for the new
  // demo students to pre-existing storage, but never restore deleted ones.
  if (dummyVersion < 2) {
    const biometrics = safeGet(STORAGE_KEYS.biometrics, []);
    const enrolledIds = new Set(biometrics.map(b => b.studentId));
    const additions = [
      { studentId: 'u5', templateId: 'tmpl_enroll_u5',          registeredAt: todayStr(-12), status: 'enrolled',            quality: 'good',  consentCaptured: true, identityVerified: true },
      { studentId: 'u6', templateId: 'tmpl_enroll_u6',          registeredAt: todayStr(-15), status: 'enrolled',            quality: 'good',  consentCaptured: true, identityVerified: true },
      { studentId: 'u7', templateId: 'tmpl_needs_reenroll_u7',  registeredAt: todayStr(-55), status: 'needs-reenrollment',  quality: 'poor',  consentCaptured: true, identityVerified: false },
      { studentId: 'u8', templateId: 'tmpl_enroll_u8',          registeredAt: todayStr(-9),  status: 'enrolled',            quality: 'good',  consentCaptured: true, identityVerified: true },
    ];
    const toAdd = additions.filter(a => !enrolledIds.has(a.studentId));
    if (toAdd.length) {
      setBiometrics([...biometrics, ...toAdd]);
    }
  }

  // ── Announcements ──
  if (!localStorage.getItem(STORAGE_KEYS.announcements)) {
    const announcements = [
      { id: 'n1', title: 'Seminar on AI is tomorrow',    detail: 'Auditorium · 2:00 PM',        type: 'event' },
      { id: 'n2', title: 'Attendance policy reminder',   detail: 'Please arrive before the event starts.', type: 'notice' },
      { id: 'n3', title: 'Tech Workshop check-in',       detail: 'Room A · Scan at the event kiosk.',     type: 'event' },
    ];
    localStorage.setItem(STORAGE_KEYS.announcements, JSON.stringify(announcements));
  }

  // ── Set version flag LAST ──
  // All one-time migrations above (users + biometrics) check this flag. By
  // setting it only at the very end we guarantee every migration runs on the
  // first load after this release, exactly once. Bump the number whenever a
  // new one-time migration is added.
  localStorage.setItem(STORAGE_KEYS.dummyDataVersion, '4');
}

// Seed data on every page load (no-ops if already seeded).
initMockData();


/* ============================================================
   Date Helpers
   ============================================================ */

/**
 * Return today's date as a local "YYYY-MM-DD" string, optionally
 * offset by `offsetDays`. Uses local time (not UTC) so the
 * date changeover happens at local midnight.
 *
 * @param {number} [offsetDays=0] — days to add (negative = past)
 * @returns {string} e.g. "2026-09-08"
 */
function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}


/* ============================================================
   Generic localStorage Getters & Setters
   ============================================================ */

/**
 * Safely parse a JSON value from localStorage.
 * Returns `fallback` when the key is missing or the value
 * is corrupt (avoids runtime crashes on corrupted storage).
 *
 * @param {string} key      — localStorage key
 * @param {*}      fallback — value returned on missing/corrupt data
 * @returns {*}
 */
function safeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function getUsers()                { return safeGet(STORAGE_KEYS.users, []); }
function getEvents()               { return safeGet(STORAGE_KEYS.events, []); }
function getAttendance()           { return safeGet(STORAGE_KEYS.attendance, []); }
function getSanctions()            { return safeGet(STORAGE_KEYS.sanctions, []); }
function getAnnouncements()        { return safeGet(STORAGE_KEYS.announcements, []); }
function getAppeals()              { return safeGet(STORAGE_KEYS.appeals, []); }
function getBiometrics()           { return safeGet(STORAGE_KEYS.biometrics, []); }
function getBiometricAudit()       { return safeGet(STORAGE_KEYS.biometricAudit, []); }
function getReenrollmentRequests() { return safeGet(STORAGE_KEYS.reenrollmentRequests, []); }
function getSanctionPolicy()       { return safeGet(STORAGE_KEYS.sanctionPolicy, DEFAULT_SANCTION_POLICY); }
function getFlaggedStudents()      { return safeGet(STORAGE_KEYS.flaggedStudents, []); }

function setUsers(users)                 { localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(users)); }
function setEvents(events)               { localStorage.setItem(STORAGE_KEYS.events, JSON.stringify(events)); }
function setAttendance(attendance)       { localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(attendance)); }
function setSanctions(sanctions)         { localStorage.setItem(STORAGE_KEYS.sanctions, JSON.stringify(sanctions)); }
function setAnnouncements(announcements) { localStorage.setItem(STORAGE_KEYS.announcements, JSON.stringify(announcements)); }
function setAppeals(appeals)             { localStorage.setItem(STORAGE_KEYS.appeals, JSON.stringify(appeals)); }
function setBiometrics(biometrics)       { localStorage.setItem(STORAGE_KEYS.biometrics, JSON.stringify(biometrics)); }
function setBiometricAudit(logs)         { localStorage.setItem(STORAGE_KEYS.biometricAudit, JSON.stringify(logs)); }
function setReenrollmentRequests(reqs)   { localStorage.setItem(STORAGE_KEYS.reenrollmentRequests, JSON.stringify(reqs)); }
function setSanctionPolicy(policy)       { localStorage.setItem(STORAGE_KEYS.sanctionPolicy, JSON.stringify(policy)); }
function setFlaggedStudents(flags)       { localStorage.setItem(STORAGE_KEYS.flaggedStudents, JSON.stringify(flags)); }


/* ============================================================
   Sanction Policy & Auto-Flagging
   ============================================================ */

/**
 * Compute unexcused absences for a student, broken down by
 * event type (minor / major). Used by the auto-flag system
 * and the SSC dashboard.
 *
 * @param {string} studentId
 * @returns {{ minor: number, major: number }}
 */
function computeUnexcusedAbsences(studentId) {
  const attendance = getAttendance().filter(
    a => a.studentId === studentId && a.status === 'absent' && !a.excused
  );
  const events = getEvents();
  const counts = { minor: 0, major: 0 };

  attendance.forEach(a => {
    const event = events.find(e => e.id === a.eventId);
    if (event && counts[event.type] !== undefined) {
      counts[event.type]++;
    }
  });

  return counts;
}

/**
 * Given an event type and the student's unexcused-absence count,
 * return the severity level that crosses the policy threshold,
 * or null if still below all thresholds.
 *
 * @param {'minor'|'major'} eventType
 * @param {number} unexcusedCount
 * @returns {'warning'|'probation'|'suspension'|null}
 */
function getSuggestedSeverity(eventType, unexcusedCount) {
  const policy     = getSanctionPolicy();
  const thresholds = policy[eventType] || policy.minor;

  if (unexcusedCount >= thresholds.suspension) return 'suspension';
  if (unexcusedCount >= thresholds.probation)  return 'probation';
  if (unexcusedCount >= thresholds.warning)    return 'warning';
  return null; // below threshold
}

/**
 * Scan all students for new threshold crossings and create
 * flagged-student entries for the SSC officer to review.
 * Deduplicates against existing flags and active sanctions.
 *
 * @returns {Array} combined list of existing + new flags
 */
function autoFlagStudents() {
  const students      = getUsers().filter(u => u.role === 'student');
  const existingFlags = getFlaggedStudents();
  const existingKeys  = new Set(existingFlags.map(f => `${f.studentId}:${f.eventType}`));
  const newFlags      = [];

  students.forEach(student => {
    const counts = computeUnexcusedAbsences(student.id);

    ['minor', 'major'].forEach(type => {
      const count = counts[type];
      if (count <= 0) return;

      const suggested = getSuggestedSeverity(type, count);
      if (!suggested) return;

      const key = `${student.id}:${type}`;
      if (existingKeys.has(key)) return; // already flagged

      // Skip if a matching active sanction already exists
      const alreadySanctioned = getSanctions().some(
        s => s.studentId === student.id && s.severity === suggested && s.status === 'active'
      );
      if (alreadySanctioned) return;

      newFlags.push({
        id: generateId('flag'),
        studentId: student.id,
        eventType: type,
        unexcusedCount: count,
        suggestedSeverity: suggested,
        date: todayStr(),
      });
    });
  });

  if (newFlags.length > 0) {
    setFlaggedStudents([...existingFlags, ...newFlags]);
  }
  return [...existingFlags, ...newFlags];
}


/* ============================================================
   Session Management
   ============================================================ */

/**
 * Retrieve the current session object from localStorage.
 * @returns {{ id: string, name: string, email: string, role: string }|null}
 */
function getSession() {
  return safeGet(STORAGE_KEYS.session, null);
}

/**
 * Persist a minimal, non-sensitive session record.
 * Only id, name, email, and role are stored — the password
 * stays in the users collection and is never serialised to
 * the session key.
 *
 * @param {object|null} user — pass null to clear the session
 */
function setSession(user) {
  if (!user) { clearSession(); return; }
  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({
    id:    user.id,
    name:  user.name,
    email: user.email,
    role:  user.role,
  }));
}

/** Remove the active session. */
function clearSession() {
  localStorage.removeItem(STORAGE_KEYS.session);
}

/**
 * Discard everything this app stored and re-seed the demo dataset.
 *
 * Needed because hydrateFromApi() overwrites the users, events,
 * attendance and sanctions keys with database rows. Clearing them alone
 * would not restore a full demo dataset: the seed blocks are gated on
 * dummyDataVersion, so the one-time migrations would be skipped and the
 * accounts they add would stay missing. Resetting the version as well
 * replays every migration.
 *
 * Safe to call at any time; the next page load reseeds.
 */
function resetDemoData() {
  Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
  initMockData();
}

/**
 * Resolve the currently-logged-in user.
 *
 * Offline mode: the session record is cross-referenced against the
 * localStorage users collection, so a deleted user correctly resolves
 * to null.
 *
 * Backend mode: the signed-in user lives in the database, not in
 * localStorage, so there is nothing to cross-reference — falling back
 * to the cached session record is what keeps requireAuth() working.
 * Without this, an API login would resolve to null and every role page
 * would bounce straight back to the login screen.
 *
 * @returns {object|null} full user object (including role)
 */
function getCurrentUser() {
  const session = getSession();
  if (!session) return null;
  const cached = getUsers().find(u => u.id === session.id);
  if (cached) return cached;
  return isApiEnabled() ? session : null;
}


/* ============================================================
   Utility
   ============================================================ */

/**
 * Generate a collision-resistant unique ID. The prefix makes
 * it easy to identify the entity type in the DOM / console.
 *
 * @param {string} [prefix='id'] — e.g. 'stu', 'evt', 'sanc'
 * @returns {string} e.g. "stu_k3j9f8a2m"
 */
function generateId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).substring(2, 11)}`;
}


/* ============================================================
   Student Organisational Helpers (Department → Course → Year)
   ------------------------------------------------------------
   Pure, DOM-free logic used by the grouped manage-students lists
   (SSC + Admin). Kept here so it can be exercised in Node tests.
   ============================================================ */

/**
 * Return the department / course / year taxonomy as plain data.
 * @returns {{ departments: string[], coursesByDept: Object<string,string[]>, yearLevels: string[] }}
 */
function getStudentOrgTaxonomy() {
  return {
    departments: [...DEPARTMENTS],
    coursesByDept: Object.fromEntries(Object.entries(COURSES_BY_DEPARTMENT).map(([d, cs]) => [d, [...cs]])),
    yearLevels: [...YEAR_LEVELS],
  };
}

/**
 * Format a stored year level ("1"–"4") as "1st Year" etc.
 * Unrecognised/blank values fall back to {@link UNASSIGNED}.
 * @param {string|number} year
 * @returns {string}
 */
function getStudentYearLabel(year) {
  const n = parseInt(year, 10);
  if (!Number.isFinite(n) || n < 1) return UNASSIGNED;
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${suffix} Year`;
}

/**
 * Normalise a student's org fields, mapping blank/missing values
 * to {@link UNASSIGNED} so grouping/badges always have a bucket.
 * @param {object} student — a user record with role 'student'
 * @returns {{ department: string, course: string, yearLevel: string }}
 */
function normalizeStudentOrg(student) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : UNASSIGNED);
  return {
    department: pick(student && student.department),
    course:     pick(student && student.course),
    yearLevel:  pick(student && student.yearLevel),
  };
}

/**
 * Narrow students by the Department/Course/Year dropdowns (ANDed)
 * and a case-insensitive text search over name, ID and email.
 * Empty filter values and a blank query are ignored.
 *
 * @param {object[]} students
 * @param {{ department?: string, course?: string, yearLevel?: string }} filters
 * @param {string} [query]
 * @returns {object[]}
 */
function applyStudentFilters(students, filters, query) {
  const f = filters || {};
  const dept  = (f.department  || '').trim();
  const course = (f.course     || '').trim();
  const year  = (f.yearLevel   || '').trim();
  const q     = (query         || '').trim().toLowerCase();

  return students.filter(student => {
    const org = normalizeStudentOrg(student);
    if (dept  && org.department !== dept)  return false;
    if (course && org.course    !== course) return false;
    if (year  && org.yearLevel  !== year)  return false;
    if (q) {
      const haystack = [student.name, student.id, student.email]
        .map(v => (v || '').toString().toLowerCase());
      if (!haystack.some(v => v.includes(q))) return false;
    }
    return true;
  });
}

/**
 * Group students into the Department → Course hierarchy used by
 * the collapsible list. Year Level is kept on each student (not a
 * third nesting level) so rows stay compact. The {@link UNASSIGNED}
 * bucket always sorts last.
 *
 * @param {object[]} students
 * @returns {Array<{ department: string, courses: Array<{ course: string, students: object[] }> }>}
 */
function groupStudentsByOrg(students) {
  const groups = [];
  const byDept = new Map(); // department -> Map(course -> course group)

  students.forEach(student => {
    const org = normalizeStudentOrg(student);
    if (!byDept.has(org.department)) {
      byDept.set(org.department, new Map());
      groups.push({ department: org.department, courses: [] });
    }
    const courseMap = byDept.get(org.department);
    if (!courseMap.has(org.course)) {
      courseMap.set(org.course, { course: org.course, students: [] });
      groups[groups.length - 1].courses.push(courseMap.get(org.course));
    }
    courseMap.get(org.course).students.push(student);
  });

  const unassignedRank = (value) => value === UNASSIGNED ? 1 : 0;

  groups.sort((a, b) =>
    (unassignedRank(a.department) - unassignedRank(b.department)) ||
    a.department.localeCompare(b.department));

  groups.forEach(group => {
    group.courses.sort((a, b) =>
      (unassignedRank(a.course) - unassignedRank(b.course)) ||
      a.course.localeCompare(b.course));
    group.courses.forEach(courseGroup => {
      courseGroup.students.sort((s1, s2) =>
        (s1.name || '').localeCompare(s2.name || ''));
    });
  });

  return groups;
}

/**
 * Migrate existing student records (added before org fields existed)
 * so the grouped list always has data to group by. Missing values are
 * filled deterministically from the taxonomy — a fresh demo seed in a
 * real deployment would pull the correct values from the registrar.
 * Safe to run on every load; no-ops once every student is complete.
 */
function backfillStudentOrg() {
  const users = getUsers();
  const students = users.filter(u => u.role === 'student');
  let changed = false;

  students.forEach((student, i) => {
    const org = normalizeStudentOrg(student);
    const complete = org.department !== UNASSIGNED
      && org.course     !== UNASSIGNED
      && org.yearLevel  !== UNASSIGNED;
    if (complete) return;

    changed = true;
    const dept   = org.department !== UNASSIGNED ? org.department : DEPARTMENTS[i % DEPARTMENTS.length];
    const courses = (COURSES_BY_DEPARTMENT[dept] || []).length ? COURSES_BY_DEPARTMENT[dept] : [UNASSIGNED];
    student.department = dept;
    student.course     = org.course !== UNASSIGNED ? org.course : courses[i % courses.length];
    student.yearLevel  = org.yearLevel !== UNASSIGNED ? org.yearLevel : String((i % YEAR_LEVELS.length) + 1);
  });

  if (changed) setUsers(users);
}
