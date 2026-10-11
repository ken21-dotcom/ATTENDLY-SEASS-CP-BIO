/* ============================================================
   SSC Officer — all ssc-officer page logic
   ------------------------------------------------------------
   Loaded only by pages/ssc-officer/*.html. Administrator pages
   load administrator-panel.js instead.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function() {
  const user = requireAuth('ssc-officer');
  if (!user) return;

  const sscNav = document.querySelector('.role-nav[aria-label="SSC navigation"]');

  if (document.getElementById('biometricForm')) {
    loadBiometricRegistry();
    document.getElementById('biometricForm').addEventListener('submit', registerBiometric);
  }

  if (document.getElementById('biometricAuditBody')) {
    loadBiometricAudit();
  }

  // Dashboard stats
  if (document.getElementById('statStudents')) {
    loadDashboardStats();
  }

  // Manage students — grouped by Department → Course → Year Level
  if (document.getElementById('studentTableBody')) {
    initGroupedStudentList({
      tbodyId: 'studentTableBody',
      countId: 'studentCount',
      departmentFilterId: 'filterDepartment',
      courseFilterId: 'filterCourse',
      yearFilterId: 'filterYear',
      searchId: 'studentSearch',
      colspan: 5,
      renderRow: (student) =>
        `<td>${escapeHtml(student.id)}</td>` +
        `<td>${escapeHtml(student.name)}</td>` +
        `<td>${escapeHtml(student.email)}</td>` +
        `<td>${yearBadge(student)}</td>` +
        `<td><button class="btn btn-sm btn-outline-danger" onclick="deleteUser('${escapeHtml(student.id)}')">Delete</button></td>`,
    });

    // Department → Course cascade for the Add modal.
    if (document.getElementById('studentDepartment')) {
      initOrgModalSelects('studentDepartment', 'studentCourse', 'studentYear');
    }

    const addForm = document.getElementById('addStudentForm');
    if (addForm) {
      addForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const name = document.getElementById('studentName').value.trim();
        const email = document.getElementById('studentEmail').value.trim();
        if (!name || !email) {
          showToast('error', 'Please fill all fields.');
          return;
        }
        const users = getUsers();
        if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
          showToast('error', 'A user with this email already exists.');
          return;
        }
        const newUser = {
          id: generateId('stu'),
          name,
          email,
          password: hashPassword('password123'),
          role: 'student',
          department: (document.getElementById('studentDepartment') || {}).value || '',
          course:     (document.getElementById('studentCourse') || {}).value || '',
          yearLevel:  (document.getElementById('studentYear') || {}).value || '',
        };
        users.push(newUser);
        setUsers(users);
        showToast('success', 'Student added.');
        refreshGroupedStudentList();
        document.getElementById('addStudentModal').querySelector('.btn-close').click();
      });
    }
  }

  // Manage officers
  if (document.getElementById('officerTableBody')) {
    loadOfficersTable();
    const addForm = document.getElementById('addOfficerForm');
    if (addForm) {
      addForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const name = document.getElementById('officerName').value.trim();
        const email = document.getElementById('officerEmail').value.trim();
        if (!name || !email) {
          showToast('error', 'Please fill all fields.');
          return;
        }
        const users = getUsers();
        if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
          showToast('error', 'A user with this email already exists.');
          return;
        }
        const newUser = { id: generateId('off'), name, email, password: hashPassword('password123'), role: 'ssc-officer' };
        users.push(newUser);
        setUsers(users);
        showToast('success', 'Officer added.');
        loadOfficersTable();
        document.getElementById('addOfficerModal').querySelector('.btn-close').click();
      });
    }
  }

  // Manage events
  if (document.getElementById('eventTableBody')) {
    loadEventsTable();
    bindEventFormHandlers();
  }

  // Manage sanctions
  if (document.getElementById('sanctionTableBody')) {
    loadSanctionsTable();
    populateSanctionStudentSelect();
    const addForm = document.getElementById('addSanctionForm');
    if (addForm) {
      addForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const studentId = document.getElementById('sanctionStudent').value;
        const description = document.getElementById('sanctionDescription').value.trim();
        const severity = document.getElementById('sanctionSeverity').value;
        const notes = document.getElementById('sanctionNotes') ? document.getElementById('sanctionNotes').value.trim() : '';
        if (!studentId || !description) {
          showToast('error', 'Please fill all fields.');
          return;
        }
        const sanctions = getSanctions();
        const newSanction = {
          id: generateId('sanc'),
          studentId,
          description,
          severity,
          status: 'pending-review',
          date: todayStr(),
          officerId: getCurrentUser() ? getCurrentUser().id : null,
          notes: notes || null
        };
        sanctions.push(newSanction);
        setSanctions(sanctions);
        showToast('success', 'Sanction added.');
        loadSanctionsTable();
        addForm.reset();
        document.getElementById('addSanctionModal').querySelector('.btn-close').click();
      });
    }
  }

  // Reports
  if (document.getElementById('reportEvent')) {
    populateReportEventSelect();
    generateAttendanceReport();
    generateSanctionReport();
  }

  // FR12: report export
  if (document.getElementById('exportPdfBtn')) {
    document.getElementById('exportPdfBtn').addEventListener('click', function() {
      window.print();
    });
  }
  if (document.getElementById('exportExcelBtn')) {
    document.getElementById('exportExcelBtn').addEventListener('click', exportActiveReportToExcel);
  }
});

function tableToCsv(tableBodyId, headers) {
  const rows = Array.from(document.getElementById(tableBodyId).querySelectorAll('tr')).map(tr =>
    Array.from(tr.children).map(td => '"' + td.textContent.trim().replace(/"/g, '""') + '"').join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportActiveReportToExcel() {
  const sanctionPane = document.getElementById('sanctionReport');
  const isSanctionActive = sanctionPane.classList.contains('active');
  if (isSanctionActive) {
    downloadCsv('sanction-report.csv', tableToCsv('sanctionReportBody', ['Student', 'Description', 'Severity', 'Status']));
  } else {
    downloadCsv('attendance-report.csv', tableToCsv('attendanceReportBody', ['Student', 'Date', 'Time', 'Status']));
  }
  showToast('success', 'Report exported.');
}

function loadBiometricRegistry() {
  const select = document.getElementById('biometricStudent');
  const students = getUsers().filter(user => user.role === 'student');
  select.innerHTML = students.length
    ? students.map(student => `<option value="${student.id}">${escapeHtml(student.name)} (${escapeHtml(student.id)})</option>`).join('')
    : '<option value="">No students available</option>';
  renderBiometricTable();
}

function renderBiometricTable() {
  const tbody = document.getElementById('biometricTableBody');
  const users = getUsers();
  const biometrics = getBiometrics();
  tbody.innerHTML = users.filter(user => user.role === 'student').map(student => {
    const record = biometrics.find(item => item.studentId === student.id);
    return `<tr><td>${escapeHtml(student.name)}</td><td>${escapeHtml(student.id)}</td><td>${record ? formatDate(record.registeredAt) : '<span class="text-muted">Not registered</span>'}</td><td>${record ? '<span class="badge bg-success">Registered</span>' : '<span class="badge bg-secondary">Pending</span>'}</td></tr>`;
  }).join('');
}

function registerBiometric(event) {
  event.preventDefault();
  const studentId = document.getElementById('biometricStudent').value;
  const status = document.getElementById('biometricStatus');
  const student = getUsers().find(user => user.id === studentId);
  if (!student) return;
  if (!document.getElementById('identityVerified').checked || !document.getElementById('consentCaptured').checked) {
    status.innerHTML = '<span class="text-danger">Verify the student identity and capture consent before enrollment.</span>';
    return;
  }
  status.innerHTML = '<span class="text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Place the student\'s finger on the connected reader...</span>';
  document.getElementById('biometricSubmit').disabled = true;

  window.setTimeout(function() {
    const quality = document.getElementById('templateQuality').value;
    const registrationStatus = quality === 'poor' ? 'needs-reenrollment' : 'enrolled';
    const registeredAt = todayStr();
    const biometrics = getBiometrics().filter(record => record.studentId !== studentId);
    biometrics.push({ studentId, templateId: generateId('template'), registeredAt, status: registrationStatus, quality, consentCaptured: true, identityVerified: true });
    setBiometrics(biometrics);
    const audit = getBiometricAudit();
    audit.unshift({ id: generateId('audit'), action: registrationStatus === 'enrolled' ? 'enrollment' : 'quality-failure', studentId, adminId: getCurrentUser().id, date: registeredAt, device: 'Enrollment Station 01', quality, result: registrationStatus });
    setBiometricAudit(audit);
    status.innerHTML = `<span class="${registrationStatus === 'enrolled' ? 'text-success' : 'text-warning'}"><i class="bi bi-${registrationStatus === 'enrolled' ? 'check-circle' : 'exclamation-triangle'} me-2"></i>${escapeHtml(student.name)}'s template quality is ${escapeHtml(quality)}. Status: ${escapeHtml(registrationStatus)}.</span>`;
    document.getElementById('biometricSubmit').disabled = false;
    renderBiometricTable();
    showToast('success', 'Fingerprint registration complete.');
  }, 1200);
}

function loadDashboardStats() {
  const students = getUsers().filter(u => u.role === 'student');
  const today = todayStr();
  const events = getEvents();
  const eventsToday = events.filter(e => e.date === today).length;
  const attendance = getAttendance();
  // Count present OR late as attended, matching the student dashboard definition.
  const attended = attendance.filter(a => a.status === 'present' || a.status === 'late').length;
  const attendanceRate = attendance.length > 0 ? Math.round((attended / attendance.length) * 100) : 0;
  const activeSanctions = getSanctions().filter(s => s.status === 'active').length;
  document.getElementById('statStudents').textContent = students.length;
  document.getElementById('statEventsToday').textContent = eventsToday;
  document.getElementById('statAttendanceRate').textContent = attendanceRate + '%';
  document.getElementById('statActiveSanctions').textContent = activeSanctions;
  const rateProgress = document.getElementById('statProgressAttendance');
  if (rateProgress) rateProgress.style.width = attendanceRate + '%';
}

function loadOfficersTable() {
  const officers = getUsers().filter(u => u.role === 'ssc-officer');
  const tbody = document.getElementById('officerTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  officers.forEach(officer => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(officer.id)}</td>
      <td>${escapeHtml(officer.name)}</td>
      <td>${escapeHtml(officer.email)}</td>
      <td>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteUser('${escapeHtml(officer.id)}')">Delete</button>
      </td>
    `;
    tbody.appendChild(row);
  });
}

function deleteUser(userId) {
  if (!confirm('Are you sure you want to delete this user?')) return;
  let users = getUsers().filter(u => u.id !== userId);
  setUsers(users);
  // Also delete related attendance/sanctions
  let attendance = getAttendance().filter(a => a.studentId !== userId);
  setAttendance(attendance);
  let sanctions = getSanctions().filter(s => s.studentId !== userId);
  setSanctions(sanctions);
  // Clean up biometric records and audit trail
  let biometrics = getBiometrics().filter(b => b.studentId !== userId);
  setBiometrics(biometrics);
  let biometricAudit = getBiometricAudit().filter(a => a.studentId !== userId && a.adminId !== userId);
  setBiometricAudit(biometricAudit);
  // Clean up appeals tied to this student or their sanctions
  let appeals = getAppeals().filter(a => a.studentId !== userId);
  setAppeals(appeals);
  // Clean up reenrollment requests
  let reenrollment = getReenrollmentRequests().filter(r => r.studentId !== userId);
  setReenrollmentRequests(reenrollment);
  // Clean up flagged-student entries
  let flagged = getFlaggedStudents().filter(f => f.studentId !== userId);
  setFlaggedStudents(flagged);
  showToast('success', 'User deleted.');
  // Reload current table
  if (document.getElementById('studentTableBody')) refreshGroupedStudentList();
  if (document.getElementById('officerTableBody')) loadOfficersTable();
}

function loadEventsTable() {
  const events = getEvents();
  const tbody = document.getElementById('eventTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  events.forEach(event => {
    const type = event.type || 'minor';
    const mandatory = event.mandatory;
    const recurring = event.recurring;
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(event.id)}</td>
      <td>${escapeHtml(event.name)}</td>
      <td>${formatDate(event.date)}</td>
      <td>${escapeHtml(event.time)}</td>
      <td>${escapeHtml(event.location)}</td>
      <td>
        <div class="event-badges">
          <span class="event-type-badge ${safeToken(type, ['major', 'minor'])}"><i class="bi bi-${type === 'major' ? 'star' : 'circle'}"></i> ${escapeHtml(type)}</span>
          <span class="mandatory-badge ${mandatory ? 'yes' : 'no'}"><i class="bi bi-${mandatory ? 'exclamation-circle' : 'info-circle'}"></i> ${mandatory ? 'Mandatory' : 'Optional'}</span>
          ${recurring ? '<span class="recurring-badge"><i class="bi bi-arrow-repeat"></i> Every ' + escapeHtml(recurring.day) + '</span>' : ''}
        </div>
      </td>
      <td>
        <button class="btn btn-sm btn-outline-secondary me-1" onclick="editEvent('${escapeHtml(event.id)}')">Edit</button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteEvent('${escapeHtml(event.id)}')">Delete</button>
      </td>
    `;
    tbody.appendChild(row);
  });
}

// Bind add/edit event form handlers once (not inside loadEventsTable, which
// re-runs after every add/edit and would otherwise attach duplicate listeners
// that create duplicate events and announcements).
function bindEventFormHandlers() {
  const addForm = document.getElementById('addEventForm');
  if (addForm) {
    addForm.addEventListener('submit', function(e) {
      e.preventDefault();
      const name = document.getElementById('eventName').value.trim();
      const date = document.getElementById('eventDate').value;
      const time = document.getElementById('eventTime').value;
      const location = document.getElementById('eventLocation').value.trim();
      const type = document.getElementById('eventType').value;
      const mandatory = type === 'major';
      const recurringDay = document.getElementById('eventRecurringDay').value;
      if (!name || !date || !time || !location) {
        showToast('error', 'Please fill all fields.');
        return;
      }
      const events = getEvents();
      const newEvent = {
        id: generateId('evt'),
        name,
        date,
        time,
        location,
        type,
        mandatory,
        recurring: type === 'minor' ? { pattern: 'weekly', day: recurringDay } : null
      };
      events.push(newEvent);
      setEvents(events);
      syncEventToServer(newEvent);
      const announcements = getAnnouncements();
      announcements.unshift({
        id: generateId('notice'),
        title: `${name} has been announced`,
        detail: `${location} · ${date} at ${time}`,
        type: 'event'
      });
      setAnnouncements(announcements.slice(0, 10));
      showToast('success', 'Event created successfully.');
      addForm.reset();
      var recurringOpts = document.getElementById('recurringOptions');
      if (recurringOpts) recurringOpts.classList.remove('visible');
      document.getElementById('addEventModal').querySelector('.btn-close').click();
      loadEventsTable();
    });
  }

  const editForm = document.getElementById('editEventForm');
  if (editForm) {
    editForm.addEventListener('submit', function(e) {
      e.preventDefault();
      const id = document.getElementById('editEventId').value;
      const name = document.getElementById('editEventName').value.trim();
      const date = document.getElementById('editEventDate').value;
      const time = document.getElementById('editEventTime').value;
      const location = document.getElementById('editEventLocation').value.trim();
      const type = document.getElementById('editEventType').value;
      const mandatory = type === 'major';
      if (!name || !date || !time || !location) {
        showToast('error', 'Please fill all fields.');
        return;
      }
      let events = getEvents();
      const idx = events.findIndex(e => e.id === id);
      if (idx !== -1) {
        events[idx] = { ...events[idx], name, date, time, location, type, mandatory };
        setEvents(events);
        showToast('success', 'Event updated successfully.');
        document.getElementById('editEventModal').querySelector('.btn-close').click();
        loadEventsTable();
      }
    });
  }
}

function deleteEvent(eventId) {
  if (!confirm('Are you sure you want to delete this event?')) return;
  let events = getEvents().filter(e => e.id !== eventId);
  setEvents(events);
  let attendance = getAttendance().filter(a => a.eventId !== eventId);
  setAttendance(attendance);
  syncEventDeleteToServer(eventId);
  showToast('success', 'Event deleted.');
  loadEventsTable();
}

/**
 * Push a newly created event to the backend and adopt the row the server
 * returns, so its id is the database id and later edits/deletes line up.
 *
 * Runs only in backend mode; a failure is reported but the local event is
 * left in place, because dropping it would lose what the officer typed.
 */
function syncEventToServer(event) {
  if (!isApiEnabled()) return;
  api.createEvent(event)
    .then((saved) => {
      const all = getEvents().map((e) => (e.id === event.id ? Object.assign({}, e, saved) : e));
      setEvents(all);
      loadEventsTable();
    })
    .catch((err) => {
      showToast('error', 'Event saved locally only — the server rejected it: ' + err.message);
    });
}

/** Mirror a deletion server-side. Only numeric ids exist in the database. */
function syncEventDeleteToServer(eventId) {
  if (!isApiEnabled() || typeof eventId !== 'number') return;
  api.deleteEvent(eventId).catch((err) => {
    showToast('error', 'Deleted here, but not on the server: ' + err.message);
  });
}

function editEvent(eventId) {
  const events = getEvents();
  const event = events.find(e => e.id === eventId);
  if (!event) return;
  document.getElementById('editEventId').value = event.id;
  document.getElementById('editEventName').value = event.name;
  document.getElementById('editEventDate').value = event.date;
  document.getElementById('editEventTime').value = event.time;
  document.getElementById('editEventLocation').value = event.location;
  document.getElementById('editEventType').value = event.type || 'minor';
  const modal = new bootstrap.Modal(document.getElementById('editEventModal'));
  modal.show();
}

function loadSanctionsTable() {
  const sanctions = getSanctions();
  const tbody = document.getElementById('sanctionTableBody');
  if (!tbody) return;
  // Build user lookup map once to avoid O(n*m) inside the loop
  const userMap = new Map(getUsers().map(u => [u.id, u]));
  tbody.innerHTML = '';
  sanctions.forEach(sanction => {
    const student = userMap.get(sanction.studentId);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${escapeHtml(sanction.id)}</td>
      <td>${student ? escapeHtml(student.name) : 'Unknown'}</td>
      <td>${escapeHtml(sanction.description)}</td>
      <td>${severityBadge(sanction.severity)}</td>
      <td><span class="badge bg-${sanction.status === 'active' ? 'danger' : 'secondary'}">${escapeHtml(sanction.status)}</span></td>
      <td>
        <button class="btn btn-sm btn-outline-secondary" onclick="toggleSanctionStatus('${escapeHtml(sanction.id)}')">Toggle Status</button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteSanction('${escapeHtml(sanction.id)}')">Delete</button>
      </td>
    `;
    tbody.appendChild(row);
  });
}

function deleteSanction(sanctionId) {
  if (!confirm('Delete this sanction?')) return;
  let sanctions = getSanctions().filter(s => s.id !== sanctionId);
  setSanctions(sanctions);
  showToast('success', 'Sanction deleted.');
  loadSanctionsTable();
}

function toggleSanctionStatus(sanctionId) {
  let sanctions = getSanctions();
  const idx = sanctions.findIndex(s => s.id === sanctionId);
  if (idx !== -1) {
    sanctions[idx].status = sanctions[idx].status === 'active' ? 'resolved' : 'active';
    setSanctions(sanctions);
    showToast('success', 'Sanction status updated.');
    loadSanctionsTable();
  }
}

function populateSanctionStudentSelect() {
  const select = document.getElementById('sanctionStudent');
  if (!select) return;
  const students = getUsers().filter(u => u.role === 'student');
  select.innerHTML = students.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
}

function populateReportEventSelect() {
  const select = document.getElementById('reportEvent');
  if (!select) return;
  const events = getEvents();
  select.innerHTML = events.map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)} - ${formatDate(e.date)}</option>`).join('');
}

function generateAttendanceReport() {
  const eventId = document.getElementById('reportEvent')?.value;
  const attendance = getAttendance().filter(a => !eventId || a.eventId === eventId);
  const tbody = document.getElementById('attendanceReportBody');
  if (!tbody) return;
  const userMap = new Map(getUsers().map(u => [u.id, u]));
  tbody.innerHTML = '';
  attendance.forEach(record => {
    const student = userMap.get(record.studentId);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${student ? escapeHtml(student.name) : 'Unknown'}</td>
      <td>${formatDate(record.date)}</td>
      <td>${escapeHtml(record.time ?? '—')}</td>
      <td><span class="badge bg-${record.status === 'present' ? 'success' : record.status === 'late' ? 'warning text-dark' : 'danger'}">${escapeHtml(record.status)}</span></td>
    `;
    tbody.appendChild(row);
  });
}

function generateSanctionReport() {
  const statusFilter = document.getElementById('sanctionStatusFilter')?.value || 'all';
  const sanctions = getSanctions().filter(s => statusFilter === 'all' || s.status === statusFilter);
  const tbody = document.getElementById('sanctionReportBody');
  if (!tbody) return;
  const userMap = new Map(getUsers().map(u => [u.id, u]));
  tbody.innerHTML = '';
  sanctions.forEach(sanction => {
    const student = userMap.get(sanction.studentId);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${student ? escapeHtml(student.name) : 'Unknown'}</td>
      <td>${escapeHtml(sanction.description)}</td>
      <td>${severityBadge(sanction.severity)}</td>
      <td><span class="badge bg-${sanction.status === 'active' ? 'danger' : 'secondary'}">${escapeHtml(sanction.status)}</span></td>
    `;
    tbody.appendChild(row);
  });
}

function loadBiometricAudit() {
  const tbody = document.getElementById('biometricAuditBody');
  const audits = getBiometricAudit();
  const userMap = new Map(getUsers().map(u => [u.id, u]));
  tbody.innerHTML = audits.map(audit => {
    const student = userMap.get(audit.studentId);
    const admin = userMap.get(audit.adminId);
    return `<tr><td>${formatDate(audit.date)}</td><td>${escapeHtml(audit.action)}</td><td>${student ? escapeHtml(student.name) : escapeHtml(audit.studentId)}</td><td>${admin ? escapeHtml(admin.name) : escapeHtml(audit.adminId)}</td><td>${escapeHtml(audit.device)}</td><td>${escapeHtml(audit.quality)}</td><td>${escapeHtml(audit.result)}</td></tr>`;
  }).join('');
  toggleEmptyState('auditEmpty', audits.length > 0);
}