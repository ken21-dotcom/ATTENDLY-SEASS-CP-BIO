// Student page-specific logic

let dashboardCalendarDate = new Date();

document.addEventListener('DOMContentLoaded', function() {
  const user = requireAuth('student');
  if (!user) return;

  const studentName = document.getElementById('studentName');
  const todayLabel = document.getElementById('todayLabel');
  if (studentName) studentName.textContent = user.name;
  if (todayLabel) todayLabel.textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  if (document.getElementById('miniCalendar')) {
    loadStudentDashboard(user);
    document.querySelector('[aria-label="Previous month"]').addEventListener('click', function() {
      dashboardCalendarDate = new Date(dashboardCalendarDate.getFullYear(), dashboardCalendarDate.getMonth() - 1, 1);
      renderMiniCalendar(dashboardCalendarDate, getEvents());
    });
    document.querySelector('[aria-label="Next month"]').addEventListener('click', function() {
      dashboardCalendarDate = new Date(dashboardCalendarDate.getFullYear(), dashboardCalendarDate.getMonth() + 1, 1);
      renderMiniCalendar(dashboardCalendarDate, getEvents());
    });
  }

  // Notifications are shared by ui.js; this dashboard also exposes its
  // "View all" text action to the same panel.
  updateNotificationBadge();
  const viewAllBtn = document.getElementById('viewAllAnnouncements');
  if (viewAllBtn) viewAllBtn.addEventListener('click', function () {
    if (window.openSharedNotifications) window.openSharedNotifications(viewAllBtn);
  });

  // On attendance page: load attendance records
  if (document.getElementById('attendanceTableBody')) {
    loadStudentAttendance(user.id);
  }

  // On sanctions page: load sanctions (skip if enhanced version handles it)
  if (document.getElementById('sanctionTableBody') && !document.getElementById('sanctionStats')) {
    loadStudentSanctions(user.id);
  }

  if (document.getElementById('appealForm')) {
    loadAppealForm(user.id);
  }

  // Profile page (profileBiometricStatus) or kiosk page (enrollmentStatus)
  if (document.getElementById('profileBiometricStatus') || document.getElementById('enrollmentStatus')) {
    loadEnrollmentStatus(user.id);
  }

  // Password change form handler
  if (document.getElementById('passwordForm')) {
    const passwordForm = document.getElementById('passwordForm');
    passwordForm.addEventListener('submit', function(event) {
      event.preventDefault();
      const currentPassword = document.getElementById('currentPassword').value;
      const newPassword = document.getElementById('newPassword').value;
      const confirmPassword = document.getElementById('confirmPassword').value;
      if (!currentPassword || !newPassword || !confirmPassword) {
        showToast('error', 'Please fill all fields.');
        return;
      }
      if (newPassword !== confirmPassword) {
        showToast('error', 'New passwords do not match.');
        return;
      }
      if (newPassword.length < 6) {
        showToast('error', 'New password must be at least 6 characters.');
        return;
      }
      const users = getUsers();
      const userIndex = users.findIndex(u => u.id === user.id);
      if (userIndex === -1) {
        showToast('error', 'User not found.');
        return;
      }
      if (!passwordMatches(currentPassword, users[userIndex].password)) {
        showToast('error', 'Current password is incorrect.');
        return;
      }
      users[userIndex].password = hashPassword(newPassword);
      setUsers(users);
      setSession({ ...user, password: hashPassword(newPassword) });
      passwordForm.reset();
      document.getElementById('passwordSaved').classList.remove('d-none');
      showToast('success', 'Password updated successfully.');
    });
  }
});

function loadStudentDashboard(user) {
  const firstName = user.name.split(' ')[0];
  document.getElementById('studentName').textContent = user.name;
  document.getElementById('welcomeName').textContent = firstName;
  document.getElementById('todayLabel').textContent = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  const events = getEvents();
  const attendance = getAttendance().filter(record => record.studentId === user.id);
  const sanctions = getSanctions().filter(record => record.studentId === user.id && record.status === 'active');
  const presentCount = attendance.filter(record => record.status === 'present' || record.status === 'late').length;
  const totalEvents = Math.max(events.length, presentCount);
  const attendanceRate = totalEvents ? Math.round((presentCount / totalEvents) * 100) : 0;
  const absentRate = Math.max(0, 100 - attendanceRate);

  document.getElementById('attendanceRate').textContent = `${attendanceRate}%`;
  document.getElementById('attendanceProgress').style.width = `${attendanceRate}%`;
  document.getElementById('presentCount').textContent = presentCount;
  document.getElementById('sanctionCount').textContent = sanctions.length;

  // FR14/FR17: derive current standing from the most severe active sanction
  const severityRank = { suspension: 3, probation: 2, warning: 1 };
  const standingLabels = { suspension: 'Suspension', probation: 'Probation', warning: 'Warning', good: 'Good Standing' };
  let standing = 'good';
  sanctions.forEach(record => {
    if ((severityRank[record.severity] || 0) > (severityRank[standing] || 0)) standing = record.severity;
  });
  const standingElement = document.getElementById('standingStatus');
  if (standingElement) {
    standingElement.textContent = standingLabels[standing] || 'Good Standing';
    standingElement.className = `enrollment-pill standing-${safeToken(standing, ['good', 'warning', 'probation', 'suspension'])}`;
  }

  document.getElementById('donutPercent').textContent = `${attendanceRate}%`;
  document.getElementById('presentLegend').textContent = `${attendanceRate}%`;
  document.getElementById('absentLegend').textContent = `${absentRate}%`;
  document.getElementById('attendanceDonut').style.setProperty('--present-rate', `${attendanceRate}%`);

  renderAnnouncements();
  renderMiniCalendar(dashboardCalendarDate, events);
  loadWeather();
}

/* ── Weather (Open-Meteo) ─────────────────────────────────────── */

var weatherRefreshTimer = null;

/**
 * WMO Weather interpretation codes → description + Bootstrap icon.
 * Reference: https://open-meteo.com/en/docs#weathervariables
 */
var WMO_CODES = {
  0:  { desc: 'Clear sky',          icon: 'bi-sun' },
  1:  { desc: 'Mainly clear',       icon: 'bi-sun' },
  2:  { desc: 'Partly cloudy',      icon: 'bi-cloud-sun' },
  3:  { desc: 'Overcast',           icon: 'bi-cloud' },
  45: { desc: 'Fog',                icon: 'bi-cloud-fog' },
  48: { desc: 'Depositing rime fog',icon: 'bi-cloud-fog' },
  51: { desc: 'Light drizzle',      icon: 'bi-cloud-drizzle' },
  53: { desc: 'Moderate drizzle',   icon: 'bi-cloud-drizzle' },
  55: { desc: 'Dense drizzle',      icon: 'bi-cloud-drizzle' },
  56: { desc: 'Freezing drizzle',   icon: 'bi-cloud-drizzle' },
  57: { desc: 'Dense freezing drizzle', icon: 'bi-cloud-drizzle' },
  61: { desc: 'Slight rain',        icon: 'bi-cloud-rain' },
  63: { desc: 'Moderate rain',      icon: 'bi-cloud-rain' },
  65: { desc: 'Heavy rain',         icon: 'bi-cloud-rain-heavy' },
  66: { desc: 'Freezing rain',      icon: 'bi-cloud-rain' },
  67: { desc: 'Heavy freezing rain',icon: 'bi-cloud-rain-heavy' },
  71: { desc: 'Slight snow',        icon: 'bi-snow' },
  73: { desc: 'Moderate snow',      icon: 'bi-snow' },
  75: { desc: 'Heavy snow',         icon: 'bi-snow' },
  77: { desc: 'Snow grains',        icon: 'bi-snow' },
  80: { desc: 'Rain showers',       icon: 'bi-cloud-rain' },
  81: { desc: 'Moderate rain showers', icon: 'bi-cloud-rain-heavy' },
  82: { desc: 'Violent rain showers',  icon: 'bi-cloud-rain-heavy' },
  85: { desc: 'Snow showers',       icon: 'bi-snow' },
  86: { desc: 'Heavy snow showers', icon: 'bi-snow' },
  95: { desc: 'Thunderstorm',       icon: 'bi-cloud-lightning' },
  96: { desc: 'Thunderstorm with hail', icon: 'bi-cloud-lightning' },
  99: { desc: 'Thunderstorm with heavy hail', icon: 'bi-cloud-lightning' },
};

function wmoLookup(code) {
  return WMO_CODES[code] || { desc: 'Unknown', icon: 'bi-question-circle' };
}

/**
 * Pick the hourly value whose timestamp (Asia/Manila, ISO) matches the API's
 * current forecast time, so the correct hour is used regardless of the
 * viewer's device clock/timezone. Falls back to the nearest future hour.
 */
function pickHourlyValue(times, values, currentTime) {
  if (!times || !values || !times.length) return null;
  var target = (currentTime || '').slice(0, 13);
  if (!target) return values[0];
  for (var i = 0; i < times.length; i++) {
    if (times[i].slice(0, 13) >= target) return values[i];
  }
  return values[values.length - 1];
}

function loadWeather() {
  // Clear any existing auto-refresh timer to avoid stacking
  if (weatherRefreshTimer) { clearInterval(weatherRefreshTimer); weatherRefreshTimer = null; }

  // JHCSC Balangasan, Pagadian City
  var LAT  = 7.8265;
  var LON  = 123.4198;
  var API  = 'https://api.open-meteo.com/v1/forecast'
           + '?latitude=' + LAT
           + '&longitude=' + LON
           + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code'
           + '&hourly=precipitation_probability'
           + '&timezone=Asia/Manila'
           + '&forecast_days=1';

  var tempEl      = document.getElementById('weatherTemp');
  var condEl      = document.getElementById('weatherCondition');
  var feelsEl     = document.getElementById('weatherFeelsLike');
  var humEl       = document.getElementById('weatherHumidity');
  var rainEl      = document.getElementById('weatherRain');
  var iconWrap    = document.getElementById('weatherIcon');
  var updatedEl   = document.getElementById('weatherUpdated');

  function showUnavailable() {
    tempEl.textContent  = '--°';
    condEl.textContent  = 'Weather data unavailable';
    feelsEl.textContent = '';
    humEl.textContent   = '--%';
    rainEl.textContent  = '--%';
    iconWrap.innerHTML  = '<i class="bi bi-cloud-slash"></i>';
    if (updatedEl) updatedEl.textContent = '';
  }

  var attempts = 0;
  var maxAttempts = 3;

  function callApi() {
    attempts++;

    // Manual timeout so older browsers without AbortSignal.timeout still work
    var controller = new AbortController();
    var timeoutId  = setTimeout(function () { controller.abort(); }, 10000);

    fetch(API, { signal: controller.signal })
      .then(function (res) {
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var cur     = data.current;
        var rainProb = data.hourly && data.hourly.precipitation_probability
          ? pickHourlyValue(data.hourly.time, data.hourly.precipitation_probability, cur.time)
          : null;

        var info = wmoLookup(cur.weather_code);

        tempEl.textContent    = Math.round(cur.temperature_2m) + '°';
        condEl.textContent    = info.desc;
        feelsEl.textContent   = 'Feels like ' + Math.round(cur.apparent_temperature) + '°';
        humEl.textContent     = cur.relative_humidity_2m + '%';
        rainEl.textContent    = rainProb !== null ? rainProb + '%' : '—';
        iconWrap.innerHTML    = '<i class="bi ' + info.icon + '"></i>';

        var now = new Date();
        updatedEl.textContent = 'Updated '
          + now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

        // Auto-refresh every 15 minutes
        weatherRefreshTimer = setInterval(loadWeather, 15 * 60 * 1000);
      })
      .catch(function () {
        clearTimeout(timeoutId);
        if (attempts < maxAttempts) {
          setTimeout(callApi, 1000 * attempts);
          return;
        }
        showUnavailable();
      });
  }

  callApi();
}

function loadEnrollmentStatus(studentId) {
  const record = getBiometrics().find(item => item.studentId === studentId);
  // Profile page uses profileBiometricStatus; kiosk page uses enrollmentStatus
  const statusElement = document.getElementById('profileBiometricStatus') || document.getElementById('enrollmentStatus');
  const detailElement = document.getElementById('profileBiometricDetail') || document.getElementById('enrollmentStatusDetail');
  const actionContainer = document.getElementById('reenrollmentAction');
  const requestButton = document.getElementById('reenrollmentRequestButton');
  const requests = getReenrollmentRequests().filter(request => request.studentId === studentId && request.status === 'pending');
  const status = record ? record.status : 'not-enrolled';
  const labels = { enrolled: 'Enrolled', 'needs-reenrollment': 'Needs re-enrollment', 'not-enrolled': 'Not enrolled' };
  statusElement.textContent = labels[status] || 'Not enrolled';
  statusElement.className = `enrollment-pill ${safeToken(status, ['enrolled', 'needs-reenrollment', 'not-enrolled'])}`;
  detailElement.textContent = 'Your fingerprint can only be registered or changed by an ATTENDLY administrator.';

  const setButtonState = function(disabled, text) {
    if (requestButton) {
      requestButton.disabled = disabled;
      requestButton.textContent = text;
      requestButton.classList.remove('btn-danger', 'btn-outline-danger');
      requestButton.classList.add(disabled ? 'btn-outline-secondary' : 'btn-outline-danger');
    }
  };

  // Profile page: show re-enrollment action when not fully enrolled
  if (status !== 'enrolled' && actionContainer) {
    actionContainer.classList.remove('d-none');
    setButtonState(requests.length > 0, requests.length > 0 ? 'Request pending' : 'Request re-enrollment');
  }

  // Remove any existing event listeners by cloning the button
  const newButton = requestButton.cloneNode(true);
  requestButton.parentNode.replaceChild(newButton, requestButton);
  // FIX: reassign so later code targets the live button, not the detached clone
  requestButton = newButton;

  requestButton.addEventListener('click', function() {
    const modalEl = document.getElementById('reenrollmentModal');
    if (modalEl) {
      const modal = new bootstrap.Modal(modalEl);
      modal.show();
    }
  });

  // Handle form submission
  const submitBtn = document.getElementById('submitReenrollmentRequest');
  if (submitBtn) {
    const newSubmitBtn = submitBtn.cloneNode(true);
    submitBtn.parentNode.replaceChild(newSubmitBtn, submitBtn);
    newSubmitBtn.addEventListener('click', function() {
      const reason = document.getElementById('reenrollmentReason').value.trim();
      const acknowledge = document.getElementById('reenrollmentAcknowledge').checked;
      if (!reason || !acknowledge) {
        showToast('error', 'Please provide a reason and acknowledge the statement.');
        return;
      }
      const updatedRequests = getReenrollmentRequests();
      updatedRequests.push({ id: generateId('reenroll'), studentId, reason, status: 'pending', date: todayStr() });
      setReenrollmentRequests(updatedRequests);
      if (requestButton) {
        requestButton.disabled = true;
        requestButton.textContent = 'Request pending';
        requestButton.classList.remove('btn-danger', 'btn-outline-danger');
        requestButton.classList.add('btn-outline-secondary');
      }
      document.getElementById('reenrollmentForm').reset();
      bootstrap.Modal.getInstance(document.getElementById('reenrollmentModal')).hide();
      showToast('success', 'Re-enrollment request sent to the admin.');
    });
  }
}

function announcementItemHTML(announcement) {
  return `
    <div class="announcement-item">
      <span class="announcement-icon ${announcement.type === 'event' ? 'event-icon' : ''}"><i class="bi bi-${announcement.type === 'event' ? 'calendar-event' : 'megaphone'}"></i></span>
      <div><strong>${escapeHtml(announcement.title)}</strong><small>${escapeHtml(announcement.detail)}</small></div>
    </div>`;
}

function renderAnnouncements() {
  const container = document.getElementById('announcementList');
  if (!container) return;
  const announcements = getAnnouncements();
  container.innerHTML = announcements.slice(0, 3).map(announcementItemHTML).join('');
}

/* ── Notifications panel ────────────────────────────────────── */

const READ_KEY = 'attendly_read_announcements';

function getReadAnnouncements() {
  try { return JSON.parse(localStorage.getItem(READ_KEY)) || []; } catch (e) { return []; }
}

function unreadAnnouncementCount() {
  const announcements = getAnnouncements();
  const read = getReadAnnouncements();
  return announcements.filter(a => !read.includes(a.id)).length;
}

function renderNotificationList() {
  const list = document.getElementById('notificationList');
  const announcements = getAnnouncements();
  if (!announcements.length) {
    list.innerHTML = '<p class="notification-empty">No announcements yet.</p>';
    return;
  }
  list.innerHTML = announcements.map(announcementItemHTML).join('');
}

function openNotifications() {
  const panel = document.getElementById('notificationPanel');
  const backdrop = document.getElementById('notificationBackdrop');
  if (!panel) return;
  renderNotificationList();
  panel.hidden = false;
  if (backdrop) backdrop.hidden = false;
  document.body.classList.add('notification-open');
  // Mark current announcements as read and refresh the badge
  const read = getReadAnnouncements();
  const ids = getAnnouncements().map(a => a.id);
  localStorage.setItem(READ_KEY, JSON.stringify(Array.from(new Set([...read, ...ids]))));
  updateNotificationBadge();
}

function closeNotifications() {
  const panel = document.getElementById('notificationPanel');
  const backdrop = document.getElementById('notificationBackdrop');
  if (panel) panel.hidden = true;
  if (backdrop) backdrop.hidden = true;
  document.body.classList.remove('notification-open');
}

function updateNotificationBadge() {
  const badge = document.getElementById('notificationBadge');
  if (!badge) return;
  const count = unreadAnnouncementCount();
  badge.textContent = count > 9 ? '9+' : count;
  badge.classList.toggle('hidden', count === 0);
}

function renderMiniCalendar(monthDate, events) {
  const calendar = document.getElementById('miniCalendar');
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const visibleEvents = events.filter(event => event && event.date);
  const cells = [];

  for (let blankDay = 0; blankDay < firstDay; blankDay += 1) cells.push('<span class="calendar-cell empty"></span>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${monthPrefix}-${String(day).padStart(2, '0')}`;
    const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
    const dayEvents = visibleEvents.filter(event => event.date === dateKey);
    const hasEvent = dayEvents.length > 0;
    const titleAttr = hasEvent ? ` title="${escapeHtml(dayEvents.length + ' ' + (dayEvents.length === 1 ? 'event' : 'events'))}"` : '';
    cells.push(`<span class="calendar-cell ${isToday ? 'today' : ''} ${hasEvent ? 'has-event' : ''}"${titleAttr}>${day}</span>`);
  }

  document.getElementById('calendarMonthLabel').textContent = monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const countEl = document.getElementById('calendarEventCount');
  if (countEl) {
    const eventCount = visibleEvents.filter(event => event.date.startsWith(monthPrefix)).length;
    countEl.textContent = eventCount === 1 ? '1 event' : `${eventCount} events`;
  }
  calendar.innerHTML = cells.join('');
}

function loadStudentAttendance(studentId) {
  const attendance = getAttendance().filter(a => a.studentId === studentId);
  const tbody = document.getElementById('attendanceTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const events = getEvents();
  attendance.forEach(record => {
    const event = events.find(e => e.id === record.eventId) || { name: 'Unknown Event' };
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${formatDate(record.date)}</td>
      <td>${escapeHtml(event.name)}</td>
      <td>${escapeHtml(record.time ?? '—')}</td>
      <td><span class="status-badge ${safeToken(record.status, ['present', 'late', 'absent', 'excused'])}">${escapeHtml(record.status)}</span></td>
    `;
    tbody.appendChild(row);
  });
  toggleEmptyState('emptyState', attendance.length > 0);
}

function loadStudentSanctions(studentId) {
  const sanctions = getSanctions().filter(s => s.studentId === studentId);
  const appeals = getAppeals().filter(appeal => appeal.studentId === studentId);
  const tbody = document.getElementById('sanctionTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  sanctions.forEach(sanction => {
    const appeal = appeals.find(item => item.sanctionId === sanction.id);
    const appealCell = appeal
      ? `<span class="appeal-status ${safeToken(appeal.status, ['pending', 'approved', 'denied'])}">${escapeHtml(appeal.status)}</span>`
      : sanction.status === 'active'
        ? `<a class="appeal-link" href="student-appeal.html?sanction=${encodeURIComponent(sanction.id)}">Appeal</a>`
        : '<span class="text-muted">Not available</span>';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${formatDate(sanction.date)}</td>
      <td>${escapeHtml(sanction.description)}</td>
      <td>${severityBadge(sanction.severity)}</td>
      <td><span class="badge bg-${sanction.status === 'active' ? 'danger' : 'secondary'}">${escapeHtml(sanction.status)}</span></td>
      <td>${appealCell}</td>
    `;
    tbody.appendChild(row);
  });
  toggleEmptyState('emptyState', sanctions.length > 0);
}

function loadAppealForm(studentId) {
  const select = document.getElementById('appealSanction');
  const activeSanctions = getSanctions().filter(sanction => sanction.studentId === studentId && sanction.status === 'active');
  const appeals = getAppeals().filter(appeal => appeal.studentId === studentId);
  const availableSanctions = activeSanctions.filter(sanction => !appeals.some(appeal => appeal.sanctionId === sanction.id && appeal.status === 'pending'));
  select.innerHTML = availableSanctions.length
    ? availableSanctions.map(sanction => `<option value="${escapeHtml(sanction.id)}">${escapeHtml(sanction.description)} - ${formatDate(sanction.date)}</option>`).join('')
    : '<option value="">No sanctions available for appeal</option>';
  const requestedSanction = new URLSearchParams(window.location.search).get('sanction');
  if (requestedSanction && availableSanctions.some(sanction => sanction.id === requestedSanction)) select.value = requestedSanction;
  if (!availableSanctions.length) document.getElementById('appealSubmit').disabled = true;

  document.getElementById('appealForm').addEventListener('submit', function(event) {
    event.preventDefault();
    const sanctionId = select.value;
    const reason = document.getElementById('appealReason').value.trim();
    if (!sanctionId || !reason) {
      showToast('error', 'Select a sanction and explain your excuse.');
      return;
    }
    const updatedAppeals = getAppeals().filter(appeal => !(appeal.studentId === studentId && appeal.sanctionId === sanctionId && appeal.status === 'pending'));
    updatedAppeals.push({ id: generateId('appeal'), studentId, sanctionId, reason, status: 'pending', date: todayStr() });
    setAppeals(updatedAppeals);
    document.getElementById('appealForm').reset();
    document.getElementById('appealForm').classList.add('d-none');
    document.getElementById('appealSubmitted').classList.remove('d-none');
    showToast('success', 'Your appeal was submitted for review.');
  });
}
