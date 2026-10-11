/* ============================================================
   API Client
   ------------------------------------------------------------
   The single place the frontend talks to the PHP backend. Every
   call goes through request(); nothing else uses fetch().

   The app runs in localStorage mode by default, so the prototype
   still works with no database. To use the real backend:

     1. Start it:   php -S localhost:8000 -t public router.php
                   (from the attendly-backend directory)
     2. Allow the frontend origin in config/config.php:
                   'cors' => ['allowed_origin' => 'http://localhost:5173']
     3. Set API_BASE_URL below to 'http://localhost:8000/api'.

   Leave it empty to keep the offline prototype behaviour.
   ============================================================ */

/* eslint-env browser */

/* ── What is and is not synced ─────────────────────────────────────
 *
 * Backend mode is opt-in and partial by design. Reading is fully wired;
 * writing is only wired where the form actually collects the data the
 * endpoint requires.
 *
 *   Read  (hydrateFromApi, on login)
 *     users, events, attendance, sanctions ......... synced
 *
 *   Write
 *     event create / delete ....................... synced
 *     kiosk check-in ............................. synced
 *     login / logout / change password ............ synced
 *     signup (student self-registration) ......... LOCAL ONLY
 *     student create ............................. LOCAL ONLY
 *     student edit / delete ...................... LOCAL ONLY
 *     officer create / approve / deactivate ....... LOCAL ONLY
 *     sanction create / approve / reject ......... LOCAL ONLY
 *     biometric enrolment ........................ LOCAL ONLY
 *     appeals, reenrollment requests ............. LOCAL ONLY
 *
 * The local-only entries are not oversights. There are no endpoints for
 * them yet, and the forms do not collect the fields those endpoints
 * would need — POST /users/students requires a student ID number,
 * username and section that no page currently asks for. Inventing a
 * student ID number to satisfy an endpoint would put fabricated identity
 * data into the database, so these stay local until the forms and
 * endpoints both exist. Sign-up shares that limitation: it creates a
 * student record with no student ID number or section to send.
 *
 * Because local-only mutations are not sent anywhere, a record changed in
 * the browser is not changed for anyone else.
 * ------------------------------------------------------------------ */

/**
 * True when the app is configured to talk to the PHP backend.
 *
 * This reads the configuration, not the last request outcome, so it is
 * still correct on a freshly loaded page — unlike apiOnline, which
 * starts false again on every navigation.
 *
 * @returns {boolean}
 */
function isApiEnabled() {
  return typeof API_BASE_URL === 'string' && API_BASE_URL.trim() !== '';
}

/**
 * Base URL of the JSON API, including the /api mount point.
 * Empty string = localStorage mode (no backend required).
 * @type {string}
 */
var API_BASE_URL = 'http://localhost:8000/api';

/** True once a backend call has succeeded at least once. */
var apiOnline = false;

/** True once a backend call has failed with a network/CORS error. */
var apiOffline = false;

/**
 * Absolute URL for an API path.
 * @param {string} path e.g. '/events'
 * @returns {string}
 */
function apiUrl(path) {
  if (!API_BASE_URL) return path;
  return API_BASE_URL.replace(/\/+$/, '') + path;
}

/**
 * Perform a JSON request against the API.
 *
 * @param {string} path    e.g. '/events'
 * @param {Object} [options]
 * @param {string} [options.method='GET']
 * @param {Object} [options.body]     JSON request payload
 * @param {boolean} [options.anonymous=false] skip the 401 redirect
 * @returns {Promise<*>} resolves with the `data` field, or the
 *   resolved value of options.validate when it returns false
 * @throws {Error} with .code and .status set on failure
 */
async function request(path, options) {
  var opts = options || {};

  if (!API_BASE_URL) {
    throw new Error('API is not configured');
  }

  var init = {
    method: opts.method || 'GET',
    // Send the PHP session cookie. Requires the backend to echo a
    // matching Access-Control-Allow-Origin (see config/config.php).
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  };

  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  var response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch (networkError) {
    apiOffline = true;
    var offline = new Error('Cannot reach the server. Check that the backend is running.');
    offline.code = 'network_error';
    throw offline;
  }

  var payload = null;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON body means something other than the API answered
    // (a PHP notice, a proxy error page).
    var malformed = new Error('The server returned an unexpected response.');
    malformed.code = 'invalid_response';
    throw malformed;
  }

  if (!response.ok) {
    var detail = payload && payload.error ? payload.error : null;
    var error = new Error(detail ? detail.message : 'Request failed.');
    error.code = detail ? detail.code : 'http_error';
    error.status = response.status;

    // 401 means the PHP session expired. Only bounce to login for
    // calls the user initiated, never for a background probe.
    if (response.status === 401 && !opts.anonymous) {
      redirectToLogin();
    }
    throw error;
  }

  apiOnline = true;
  apiOffline = false;

  var data = payload && Object.prototype.hasOwnProperty.call(payload, 'data')
    ? payload.data
    : payload;

  if (typeof opts.validate === 'function' && !opts.validate(data)) {
    var invalid = new Error('The server response was missing required fields.');
    invalid.code = 'invalid_response';
    throw invalid;
  }

  return data;
}

/**
 * Send the browser to the login page, preserving where the user was.
 * Defined in auth.js; guarded so api.js stays usable on the kiosk,
 * which is deliberately unauthenticated.
 */
function redirectToLogin() {
  if (typeof clearSession === 'function') clearSession();
  if (typeof pageUrl === 'function') {
    window.location.href = pageUrl('login');
  }
}

/**
 * Whether the app should read through the backend.
 *
 * True only when a base URL is configured and the backend answered a
 * health check. Until then the prototype keeps using localStorage.
 * @returns {Promise<boolean>}
 */
async function useRemoteData() {
  if (!API_BASE_URL) return false;
  try {
    var health = await request('/health', { anonymous: true });
    return !!health && health.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Prime the localStorage cache from the backend.
 *
 * Every page reads its data through synchronous accessors such as
 * getEvents(), so rather than converting all of them to async this pulls
 * the collections the API can serve into the same keys the accessors read.
 * A page load after login therefore behaves identically whether the data
 * came from the database or from the seed data.
 *
 * Deliberately never throws: a partial backend must not block sign-in.
 * The return value lets the caller report what did not load, because
 * silently serving demo data as though it were real data is the one
 * failure mode worth surfacing.
 *
 * @returns {Promise<{synced: string[], failed: string[]}>}
 */
async function hydrateFromApi() {
  var result = { synced: [], failed: [] };
  if (!isApiEnabled()) return result;

  // Sequential on purpose: these share one PHP session, and a 401 mid-run
  // should surface as a clean failure rather than five parallel redirects.
  var jobs = [
    ['users', function () { return api.listUsers(); }, 'setUsers'],
    ['events', function () { return api.listEvents(); }, 'setEvents'],
    ['attendance', function () { return api.listAttendance(); }, 'setAttendance'],
    ['sanctions', function () { return api.listSanctions(); }, 'setSanctions'],
  ];

  for (var i = 0; i < jobs.length; i++) {
    var name = jobs[i][0];
    try {
      var rows = await jobs[i][1]();
      if (!Array.isArray(rows)) throw new Error('expected a list');
      // Resolved by name at call time: data.js is not loaded when this
      // file is parsed, but it always is by the time we run.
      var store = window[jobs[i][2]];
      if (typeof store !== 'function') throw new Error('accessor missing');
      store(rows);
      result.synced.push(name);
    } catch (err) {
      result.failed.push(name);
    }
  }
  return result;
}

/* ── Endpoint helpers ────────────────────────────────────────── */

/**
 * Add one hour to an 'HH:MM' string, wrapping past midnight.
 * @param {string} hhmm
 * @returns {string}
 */
function addHour(hhmm) {
  var parts = String(hhmm).split(':');
  var minutes = (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0) + 60;
  var hh = Math.floor(minutes / 60) % 24;
  var mm = minutes % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

var api = {
  login: function (email, password) {
    return request('/auth/login', {
      method: 'POST',
      body: { email: email, password: password },
      anonymous: true,
      validate: function (user) {
        return user && user.id && user.role;
      },
    });
  },

  logout: function () {
    // Always clear locally, even if the server call fails.
    return request('/auth/logout', { method: 'POST', anonymous: true })
      .catch(function () { return { ok: true }; });
  },

  me: function () {
    return request('/auth/me', { anonymous: true });
  },

  changePassword: function (currentPassword, newPassword) {
    return request('/auth/password', {
      method: 'POST',
      body: { currentPassword: currentPassword, newPassword: newPassword },
    });
  },

  listUsers: function () {
    return request('/users', { validate: Array.isArray });
  },

  createStudent: function (student) {
    return request('/users/students', { method: 'POST', body: student });
  },

  listEvents: function () {
    return request('/events', { validate: Array.isArray });
  },

  /**
   * Translate a UI event into the API's shape.
   *
   * The event form speaks the dashboard's vocabulary (major/minor,
   * location, a single time) while the schema uses mandatory/optional
   * and venue. Doing the translation in one place keeps the mapper in
   * Repository.php and this function as exact inverses.
   *
   * @param {Object} event a UI event object
   * @param {string} [endTime] 'HH:MM'; defaults to one hour after start
   * @returns {Object} request body for POST /events
   */
  toEventPayload: function (event, endTime) {
    var start = event.time || '00:00';
    return {
      name: event.name,
      date: event.date,
      startTime: start,
      endTime: endTime || addHour(start),
      venue: event.location,
      // The form's minor/major scale is the inverse of optional/mandatory.
      eventType: event.type === 'major' ? 'mandatory' : 'optional',
      description: event.description || null,
    };
  },

  createEvent: function (event) {
    return request('/events', { method: 'POST', body: api.toEventPayload(event) });
  },

  deleteEvent: function (id) {
    return request('/events/' + encodeURIComponent(id), { method: 'DELETE' });
  },

  listAttendance: function (eventId) {
    var query = eventId ? '?event_id=' + encodeURIComponent(eventId) : '';
    return request('/attendance' + query, { validate: Array.isArray });
  },

  /**
   * Record a check-in. The kiosk calls this without a session, so the
   * request is anonymous and a failure surfaces as a normal error.
   */
  checkIn: function (eventId, studentId, method) {
    return request('/attendance/check-in', {
      method: 'POST',
      anonymous: true,
      body: {
        eventId: eventId,
        studentId: studentId,
        verificationMethod: method || 'fingerprint',
      },
    });
  },

  listSanctions: function (studentId) {
    var query = studentId ? '?student_id=' + encodeURIComponent(studentId) : '';
    return request('/sanctions' + query, { validate: Array.isArray });
  },

  signup: function (student) {
    return request('/auth/signup', {
      method: 'POST',
      body: student,
      anonymous: true,
    });
  },
};