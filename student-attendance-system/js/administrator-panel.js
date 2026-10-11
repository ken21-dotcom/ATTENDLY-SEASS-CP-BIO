/* ============================================================
   Administrator Panel — all admin page logic
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  var user = requireAuth('admin');
  if (!user) return;

  /* ── User dropdown toggle ── */
  var userToggle = document.getElementById('userDropdownToggle');
  var userMenu   = document.getElementById('userDropdownMenu');
  if (userToggle && userMenu) {
    userToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = userMenu.classList.toggle('open');
      userToggle.setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', function () {
      userMenu.classList.remove('open');
      userToggle.setAttribute('aria-expanded', 'false');
    });
  }

  if (document.getElementById('adminEmail') && user.email) {
    document.getElementById('adminEmail').textContent = user.email;
  }

  /* ── Route to page-specific init ── */
  if (document.getElementById('statStudents'))         initAdminDashboard();
  if (document.getElementById('officerTableBody'))     initAdminManageOfficers();
  if (document.getElementById('sanctionReviewBody'))   initAdminManageSanctions();
  if (document.getElementById('studentTableBody'))     initAdminManageStudents();
  if (document.getElementById('biometricForm'))        initAdminManageBiometric();
  if (document.getElementById('biometricAuditBody'))   initAdminBiometricAudit();
  if (document.getElementById('reportEvent'))          initAdminReports();
  if (document.getElementById('policyMinorWarning'))   initAdminSettings();
});


/* ============================================================
   Admin Dashboard
   ============================================================ */

function initAdminDashboard() {
  var students = getUsers().filter(function (u) { return u.role === 'student'; });
  var officers = getUsers().filter(function (u) { return u.role === 'ssc-officer'; });
  var events   = getEvents();
  var sanctions = getSanctions();
  var attendance = getAttendance();

  document.getElementById('statStudents').textContent   = students.length;
  document.getElementById('statOfficers').textContent   = officers.length;
  document.getElementById('statEvents').textContent     = events.length;

  var pending = sanctions.filter(function (s) { return s.status === 'pending-review'; });
  document.getElementById('statPendingSanctions').textContent = pending.length;

  var attended = attendance.filter(function (a) { return a.status === 'present' || a.status === 'late'; }).length;
  var rate = attendance.length > 0 ? Math.round((attended / attendance.length) * 100) : 0;
  document.getElementById('statAttendanceRate').textContent = rate + '%';
  var rateProgress = document.getElementById('statProgressAttendance');
  if (rateProgress) rateProgress.style.width = rate + '%';

  renderPendingSanctionsPanel(pending, students);
  renderRecentEnrollmentPanel();
}

function renderPendingSanctionsPanel(pending, students) {
  var container = document.getElementById('pendingSanctionsList');
  if (!container) return;
  if (!pending.length) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--color-text-muted);font-size:.82rem;"><i class="bi bi-check-circle" style="font-size:1.2rem;display:block;margin-bottom:4px;"></i>No pending sanctions.</div>';
    return;
  }
  var userMap = new Map(students.map(function (s) { return [s.id, s]; }));
  container.innerHTML = pending.slice(0, 5).map(function (s) {
    var student = userMap.get(s.studentId);
    return '<div style="display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--color-border-default);">' +
      '<div style="flex:1;min-width:0;"><strong style="display:block;font-size:.85rem;">' + escapeHtml(student ? student.name : 'Unknown') + '</strong>' +
      '<small style="color:var(--color-text-muted);font-size:.75rem;">' + escapeHtml(s.description) + '</small></div>' +
      severityBadge(s.severity) +
      '<a href="admin-manage-sanctions.html" class="btn btn-sm btn-outline-primary">Review</a>' +
      '</div>';
  }).join('');
}

function renderRecentEnrollmentPanel() {
  var container = document.getElementById('recentEnrollmentList');
  if (!container) return;
  var audits = getBiometricAudit().slice(0, 5);
  if (!audits.length) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--color-text-muted);font-size:.82rem;"><i class="bi bi-info-circle" style="font-size:1.2rem;display:block;margin-bottom:4px;"></i>No enrollment activity yet.</div>';
    return;
  }
  var userMap = new Map(getUsers().map(function (u) { return [u.id, u]; }));
  container.innerHTML = audits.map(function (a) {
    var student = userMap.get(a.studentId);
    return '<div style="display:flex;align-items:center;gap:12px;padding:12px;border-bottom:1px solid var(--color-border-default);">' +
      '<div style="flex:1;min-width:0;"><strong style="display:block;font-size:.85rem;">' + escapeHtml(student ? student.name : a.studentId) + '</strong>' +
      '<small style="color:var(--color-text-muted);font-size:.75rem;">' + escapeHtml(a.action) + ' · ' + formatDate(a.date) + '</small></div>' +
      '<span class="badge bg-secondary" style="white-space:nowrap;">' + escapeHtml(a.device) + '</span>' +
      '</div>';
  }).join('');
}


/* ============================================================
   Admin — Manage Officers
   ============================================================ */

function initAdminManageOfficers() {
  loadOfficersTable();
  var addForm = document.getElementById('addOfficerForm');
  if (addForm) {
    addForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name  = document.getElementById('officerName').value.trim();
      var email = document.getElementById('officerEmail').value.trim();
      var org   = document.getElementById('officerOrg').value.trim();
      if (!name || !email) { showToast('error', 'Please fill all required fields.'); return; }
      var users = getUsers();
      if (users.some(function (u) { return u.email.toLowerCase() === email.toLowerCase(); })) {
        showToast('error', 'A user with this email already exists.');
        return;
      }
      var newUser = {
        id: generateId('off'), name: name, email: email,
        password: hashPassword('password123'), role: 'ssc-officer',
        org: org || '', status: 'pending'
      };
      users.push(newUser);
      setUsers(users);
      showToast('success', 'Officer account created (pending approval).');
      loadOfficersTable();
      addForm.reset();
      document.getElementById('addOfficerModal').querySelector('.btn-close').click();
    });
  }
}

function loadOfficersTable() {
  var officers = getUsers().filter(function (u) { return u.role === 'ssc-officer'; });
  var tbody = document.getElementById('officerTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  officers.forEach(function (officer) {
    var status = officer.status || 'active';
    var statusBadge = status === 'pending'    ? '<span class="badge bg-warning text-dark">Pending</span>'
                    : status === 'deactivated' ? '<span class="badge bg-secondary">Deactivated</span>'
                    : '<span class="badge bg-success">Active</span>';
    var row = document.createElement('tr');
    row.innerHTML =
      '<td>' + escapeHtml(officer.name) + '</td>' +
      '<td>' + escapeHtml(officer.email) + '</td>' +
      '<td>' + escapeHtml(officer.org || '—') + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td>' +
        (status === 'pending'
          ? '<button class="btn btn-sm btn-success me-1" onclick="approveOfficer(\'' + escapeHtml(officer.id) + '\')"><i class="bi bi-check-lg"></i> Approve</button>'
          : '') +
        (status === 'active'
          ? '<button class="btn btn-sm btn-outline-warning me-1" onclick="deactivateOfficer(\'' + escapeHtml(officer.id) + '\')"><i class="bi bi-pause"></i> Deactivate</button>'
          : '') +
        (status === 'deactivated'
          ? '<button class="btn btn-sm btn-outline-success me-1" onclick="reactivateOfficer(\'' + escapeHtml(officer.id) + '\')"><i class="bi bi-play"></i> Reactivate</button>'
          : '') +
        '<button class="btn btn-sm btn-outline-danger" onclick="deleteOfficer(\'' + escapeHtml(officer.id) + '\')"><i class="bi bi-trash"></i> Delete</button>' +
      '</td>';
    tbody.appendChild(row);
  });
}

function approveOfficer(id) {
  var users = getUsers();
  var idx = users.findIndex(function (u) { return u.id === id; });
  if (idx === -1) return;
  users[idx].status = 'active';
  setUsers(users);
  showToast('success', 'Officer approved.');
  loadOfficersTable();
}

function deactivateOfficer(id) {
  if (!confirm('Deactivate this officer? They will be unable to log in.')) return;
  var users = getUsers();
  var idx = users.findIndex(function (u) { return u.id === id; });
  if (idx === -1) return;
  users[idx].status = 'deactivated';
  setUsers(users);
  showToast('success', 'Officer deactivated.');
  loadOfficersTable();
}

function reactivateOfficer(id) {
  var users = getUsers();
  var idx = users.findIndex(function (u) { return u.id === id; });
  if (idx === -1) return;
  users[idx].status = 'active';
  setUsers(users);
  showToast('success', 'Officer reactivated.');
  loadOfficersTable();
}

function deleteOfficer(id) {
  if (!confirm('Permanently delete this officer account?')) return;
  var users = getUsers().filter(function (u) { return u.id !== id; });
  setUsers(users);
  showToast('success', 'Officer deleted.');
  loadOfficersTable();
}


/* ============================================================
   Admin — Manage Sanctions
   ============================================================ */

function initAdminManageSanctions() {
  loadSanctionReviewQueue();
  loadSanctionHistory();
}

function loadSanctionReviewQueue() {
  var sanctions = getSanctions().filter(function (s) { return s.status === 'pending-review'; });
  var tbody = document.getElementById('sanctionReviewBody');
  var countEl = document.getElementById('pendingCount');
  if (countEl) countEl.textContent = sanctions.length;
  if (!tbody) return;
  var userMap = new Map(getUsers().map(function (u) { return [u.id, u]; }));
  tbody.innerHTML = '';
  if (!sanctions.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--color-text-muted);padding:24px;">No pending sanctions to review.</td></tr>';
    return;
  }
  sanctions.forEach(function (s) {
    var student = userMap.get(s.studentId);
    var row = document.createElement('tr');
    row.innerHTML =
      '<td>' + escapeHtml(s.id) + '</td>' +
      '<td>' + escapeHtml(student ? student.name : 'Unknown') + '</td>' +
      '<td>' + escapeHtml(s.description) + '</td>' +
      '<td>' + severityBadge(s.severity) + '</td>' +
      '<td>' + formatDate(s.date) + '</td>' +
      '<td>' +
        '<button class="btn btn-sm btn-success me-1" onclick="approveSanction(\'' + escapeHtml(s.id) + '\')"><i class="bi bi-check-lg"></i> Approve</button>' +
        '<button class="btn btn-sm btn-outline-danger" onclick="rejectSanction(\'' + escapeHtml(s.id) + '\')"><i class="bi bi-x-lg"></i> Reject</button>' +
      '</td>';
    tbody.appendChild(row);
  });
}

function approveSanction(id) {
  var sanctions = getSanctions();
  var idx = sanctions.findIndex(function (s) { return s.id === id; });
  if (idx === -1) return;
  var s = sanctions[idx];

  document.getElementById('approveSanctionId').value = id;
  document.getElementById('approveSeverity').value = s.severity;
  document.getElementById('approveNotes').value = '';
  var modal = new bootstrap.Modal(document.getElementById('approveSanctionModal'));
  modal.show();
}

function confirmApproveSanction() {
  var id     = document.getElementById('approveSanctionId').value;
  var sev    = document.getElementById('approveSeverity').value;
  var notes  = document.getElementById('approveNotes').value.trim();
  var sanctions = getSanctions();
  var idx = sanctions.findIndex(function (s) { return s.id === id; });
  if (idx === -1) return;

  var user = getCurrentUser();
  sanctions[idx].severity   = sev;
  sanctions[idx].status     = 'active';
  sanctions[idx].approvedBy = user ? user.id : null;
  sanctions[idx].approvedAt = todayStr();
  sanctions[idx].reviewNotes = notes || null;
  setSanctions(sanctions);

  document.getElementById('approveSanctionModal').querySelector('.btn-close').click();
  showToast('success', 'Sanction approved.');
  loadSanctionReviewQueue();
  loadSanctionHistory();
}

function rejectSanction(id) {
  var reason = prompt('Rejection reason (required):');
  if (reason === null) return;
  if (!reason.trim()) { showToast('error', 'A reason is required to reject.'); return; }

  var sanctions = getSanctions();
  var idx = sanctions.findIndex(function (s) { return s.id === id; });
  if (idx === -1) return;

  var user = getCurrentUser();
  sanctions[idx].status          = 'rejected';
  sanctions[idx].rejectedBy      = user ? user.id : null;
  sanctions[idx].rejectedAt      = todayStr();
  sanctions[idx].rejectionReason = reason.trim();
  setSanctions(sanctions);
  showToast('success', 'Sanction rejected.');
  loadSanctionReviewQueue();
  loadSanctionHistory();
}

function loadSanctionHistory() {
  var sanctions = getSanctions().filter(function (s) { return s.status !== 'pending-review'; });
  var tbody = document.getElementById('sanctionHistoryBody');
  if (!tbody) return;
  var userMap = new Map(getUsers().map(function (u) { return [u.id, u]; }));
  tbody.innerHTML = '';
  sanctions.forEach(function (s) {
    var student = userMap.get(s.studentId);
    var statusLabel = s.status === 'active'    ? '<span class="badge bg-danger">Active</span>'
                    : s.status === 'resolved'  ? '<span class="badge bg-secondary">Resolved</span>'
                    : s.status === 'rejected'  ? '<span class="badge bg-dark">Rejected</span>'
                    : '<span class="badge bg-secondary">' + escapeHtml(s.status) + '</span>';
    var row = document.createElement('tr');
    row.innerHTML =
      '<td>' + escapeHtml(student ? student.name : 'Unknown') + '</td>' +
      '<td>' + escapeHtml(s.description) + '</td>' +
      '<td>' + severityBadge(s.severity) + '</td>' +
      '<td>' + statusLabel + '</td>' +
      '<td>' + formatDate(s.date) + '</td>';
    tbody.appendChild(row);
  });
}


/* ============================================================
   Admin — Manage Students
   ============================================================ */

function initAdminManageStudents() {
  // Grouped by Department → Course → Year Level, with filters + search.
  initGroupedStudentList({
    tbodyId: 'studentTableBody',
    countId: 'studentCount',
    departmentFilterId: 'filterDepartment',
    courseFilterId: 'filterCourse',
    yearFilterId: 'filterYear',
    searchId: 'studentSearch',
    colspan: 4,
    renderRow: function (student) {
      return '<td>' + escapeHtml(student.name) + '</td>' +
        '<td>' + escapeHtml(student.email) + '</td>' +
        '<td>' + yearBadge(student) + '</td>' +
        '<td>' +
          '<button class="btn btn-sm btn-outline-secondary me-1" onclick="editStudent(\'' + escapeHtml(student.id) + '\')"><i class="bi bi-pencil"></i> Edit</button>' +
          '<button class="btn btn-sm btn-outline-danger" onclick="deleteStudent(\'' + escapeHtml(student.id) + '\')"><i class="bi bi-trash"></i> Delete</button>' +
        '</td>';
    },
  });

  // Department → Course cascade for the Add modal.
  if (document.getElementById('studentDepartment')) {
    initOrgModalSelects('studentDepartment', 'studentCourse', 'studentYear');
  }

  var addForm = document.getElementById('addStudentForm');
  if (addForm) {
    addForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name  = document.getElementById('studentName').value.trim();
      var email = document.getElementById('studentEmail').value.trim();
      if (!name || !email) { showToast('error', 'Please fill all required fields.'); return; }
      var users = getUsers();
      if (users.some(function (u) { return u.email.toLowerCase() === email.toLowerCase(); })) {
        showToast('error', 'A user with this email already exists.'); return;
      }
      users.push({
        id: generateId('stu'),
        name: name,
        email: email,
        password: hashPassword('password123'),
        role: 'student',
        department: (document.getElementById('studentDepartment') || {}).value || '',
        course:     (document.getElementById('studentCourse') || {}).value || '',
        yearLevel:  (document.getElementById('studentYear') || {}).value || '',
      });
      setUsers(users);
      showToast('success', 'Student added.');
      refreshGroupedStudentList();
      addForm.reset();
      document.getElementById('addStudentModal').querySelector('.btn-close').click();
    });
  }

  var csvForm = document.getElementById('importCsvForm');
  if (csvForm) {
    csvForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fileInput = document.getElementById('csvFileInput');
      if (!fileInput.files.length) { showToast('error', 'Select a CSV file first.'); return; }
      var reader = new FileReader();
      reader.onload = function (ev) {
        var text = ev.target.result;
        var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
        var startIdx = 0;
        if (lines.length && lines[0].toLowerCase().match(/^(name|email|student)/)) startIdx = 1;
        var users = getUsers();
        var added = 0;
        for (var i = startIdx; i < lines.length; i++) {
          var parts = lines[i].split(',').map(function (p) { return p.trim().replace(/^"|"$/g, ''); });
          var csvName  = parts[0];
          var csvEmail = parts[1];
          if (!csvName || !csvEmail) continue;
          if (users.some(function (u) { return u.email.toLowerCase() === csvEmail.toLowerCase(); })) continue;
          users.push({
            id: generateId('stu'),
            name: csvName,
            email: csvEmail,
            password: hashPassword('password123'),
            role: 'student',
            department: parts[2] || '',
            course:     parts[3] || '',
            yearLevel:  parts[4] || '',
          });
          added++;
        }
        setUsers(users);
        showToast('success', added + ' student(s) imported.');
        refreshGroupedStudentList();
        document.getElementById('importCsvModal').querySelector('.btn-close').click();
      };
      reader.readAsText(fileInput.files[0]);
    });
  }
}

function editStudent(id) {
  var users = getUsers();
  var student = users.find(function (u) { return u.id === id; });
  if (!student) return;
  document.getElementById('editStudentId').value    = student.id;
  document.getElementById('editStudentName').value  = student.name;
  document.getElementById('editStudentEmail').value = student.email;
  // Org selects (department → course cascade) for the current student.
  initOrgModalSelects('editStudentDepartment', 'editStudentCourse', 'editStudentYear', {
    department: student.department,
    course: student.course,
    yearLevel: student.yearLevel,
  });
  var modal = new bootstrap.Modal(document.getElementById('editStudentModal'));
  modal.show();
}

function confirmEditStudent() {
  var id    = document.getElementById('editStudentId').value;
  var name  = document.getElementById('editStudentName').value.trim();
  var email = document.getElementById('editStudentEmail').value.trim();
  if (!name || !email) { showToast('error', 'Please fill all fields.'); return; }
  var users = getUsers();
  var idx = users.findIndex(function (u) { return u.id === id; });
  if (idx === -1) return;
  users[idx].name  = name;
  users[idx].email = email;
  users[idx].department = (document.getElementById('editStudentDepartment') || {}).value || '';
  users[idx].course     = (document.getElementById('editStudentCourse') || {}).value || '';
  users[idx].yearLevel  = (document.getElementById('editStudentYear') || {}).value || '';
  setUsers(users);
  document.getElementById('editStudentModal').querySelector('.btn-close').click();
  showToast('success', 'Student updated.');
  refreshGroupedStudentList();
}

function deleteStudent(id) {
  if (!confirm('Permanently delete this student?')) return;
  var users = getUsers().filter(function (u) { return u.id !== id; });
  setUsers(users);
  setAttendance(getAttendance().filter(function (a) { return a.studentId !== id; }));
  setSanctions(getSanctions().filter(function (s) { return s.studentId !== id; }));
  setBiometrics(getBiometrics().filter(function (b) { return b.studentId !== id; }));
  setBiometricAudit(getBiometricAudit().filter(function (a) { return a.studentId !== id; }));
  setAppeals(getAppeals().filter(function (a) { return a.studentId !== id; }));
  showToast('success', 'Student deleted.');
  refreshGroupedStudentList();
}


/* ============================================================
   Admin — Manage Biometric
   ============================================================ */

function initAdminManageBiometric() {
  var select = document.getElementById('biometricStudent');
  var students = getUsers().filter(function (u) { return u.role === 'student'; });
  select.innerHTML = students.length
    ? students.map(function (s) { return '<option value="' + s.id + '">' + escapeHtml(s.name) + ' (' + escapeHtml(s.id) + ')</option>'; }).join('')
    : '<option value="">No students available</option>';
  renderAdminBiometricTable();

  document.getElementById('biometricForm').addEventListener('submit', function (e) {
    e.preventDefault();
    registerAdminBiometric();
  });
}

function renderAdminBiometricTable() {
  var tbody = document.getElementById('biometricTableBody');
  if (!tbody) return;
  var users      = getUsers().filter(function (u) { return u.role === 'student'; });
  var biometrics = getBiometrics();
  tbody.innerHTML = users.map(function (student) {
    var rec = biometrics.find(function (b) { return b.studentId === student.id; });
    return '<tr>' +
      '<td>' + escapeHtml(student.name) + '</td>' +
      '<td>' + escapeHtml(student.id) + '</td>' +
      '<td>' + (rec ? formatDate(rec.registeredAt) : '<span class="text-muted">Not registered</span>') + '</td>' +
      '<td>' + (rec ? '<span class="badge bg-success">Registered</span>' : '<span class="badge bg-secondary">Pending</span>') + '</td>' +
      '</tr>';
  }).join('');
}

function registerAdminBiometric() {
  var studentId = document.getElementById('biometricStudent').value;
  var status    = document.getElementById('biometricStatus');
  var student   = getUsers().find(function (u) { return u.id === studentId; });
  if (!student) return;
  if (!document.getElementById('identityVerified').checked || !document.getElementById('consentCaptured').checked) {
    status.innerHTML = '<span class="text-danger">Verify the student identity and capture consent before enrollment.</span>';
    return;
  }

  status.innerHTML = '<span class="text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Place the student\'s finger on the connected reader...</span>';
  document.getElementById('biometricSubmit').disabled = true;

  window.setTimeout(function () {
    var quality = document.getElementById('templateQuality').value;
    var regStatus = quality === 'poor' ? 'needs-reenrollment' : 'enrolled';
    var regDate   = todayStr();
    var biometrics = getBiometrics().filter(function (b) { return b.studentId !== studentId; });
    biometrics.push({
      studentId: studentId, templateId: generateId('template'),
      registeredAt: regDate, status: regStatus, quality: quality,
      consentCaptured: true, identityVerified: true
    });
    setBiometrics(biometrics);

    var audit = getBiometricAudit();
    audit.unshift({
      id: generateId('audit'),
      action: regStatus === 'enrolled' ? 'enrollment' : 'quality-failure',
      studentId: studentId,
      adminId: getCurrentUser().id,
      date: regDate,
      device: 'Enrollment Station 01',
      quality: quality,
      result: regStatus
    });
    setBiometricAudit(audit);

    status.innerHTML = '<span class="' + (regStatus === 'enrolled' ? 'text-success' : 'text-warning') + '"><i class="bi bi-' + (regStatus === 'enrolled' ? 'check-circle' : 'exclamation-triangle') + ' me-2"></i>' + escapeHtml(student.name) + '\'s template quality is ' + escapeHtml(quality) + '. Status: ' + escapeHtml(regStatus) + '.</span>';
    document.getElementById('biometricSubmit').disabled = false;
    renderAdminBiometricTable();
    showToast('success', 'Fingerprint registration complete.');
  }, 1200);
}


/* ============================================================
   Admin — Biometric Audit
   ============================================================ */

function initAdminBiometricAudit() {
  var tbody = document.getElementById('biometricAuditBody');
  var audits = getBiometricAudit();
  var userMap = new Map(getUsers().map(function (u) { return [u.id, u]; }));
  tbody.innerHTML = audits.map(function (audit) {
    var student = userMap.get(audit.studentId);
    var admin   = userMap.get(audit.adminId);
    return '<tr>' +
      '<td>' + formatDate(audit.date) + '</td>' +
      '<td>' + escapeHtml(audit.action) + '</td>' +
      '<td>' + escapeHtml(student ? student.name : audit.studentId) + '</td>' +
      '<td>' + escapeHtml(admin ? admin.name : audit.adminId) + '</td>' +
      '<td>' + escapeHtml(audit.device) + '</td>' +
      '<td>' + escapeHtml(audit.quality) + '</td>' +
      '<td>' + escapeHtml(audit.result) + '</td>' +
      '</tr>';
  }).join('');
  toggleEmptyState('auditEmpty', audits.length > 0);
}


/* ============================================================
   Admin — Reports
   ============================================================ */

function initAdminReports() {
  populateAdminReportEventSelect();
  generateAdminAttendanceReport();
  generateAdminSanctionReport();

  if (document.getElementById('exportPdfBtn')) {
    document.getElementById('exportPdfBtn').addEventListener('click', function () { window.print(); });
  }
  if (document.getElementById('exportExcelBtn')) {
    document.getElementById('exportExcelBtn').addEventListener('click', function () {
      var sanctionPane = document.getElementById('sanctionPane');
      var isSanctionActive = sanctionPane && sanctionPane.classList.contains('active');
      if (isSanctionActive) {
        downloadCsv('sanction-report.csv', tableToCsv('sanctionReportBody', ['Student', 'Description', 'Severity', 'Status']));
      } else {
        downloadCsv('attendance-report.csv', tableToCsv('attendanceReportBody', ['Student', 'Date', 'Time', 'Status']));
      }
      showToast('success', 'Report exported.');
    });
  }
  if (document.getElementById('reportEvent')) {
    document.getElementById('reportEvent').addEventListener('change', function () {
      generateAdminAttendanceReport();
    });
  }
  if (document.getElementById('sanctionStatusFilter')) {
    document.getElementById('sanctionStatusFilter').addEventListener('change', function () {
      generateAdminSanctionReport();
    });
  }
}

function populateAdminReportEventSelect() {
  var select = document.getElementById('reportEvent');
  if (!select) return;
  select.innerHTML = '<option value="">All events</option>' + getEvents().map(function (e) {
    return '<option value="' + e.id + '">' + escapeHtml(e.name) + ' — ' + escapeHtml(e.date) + '</option>';
  }).join('');
}

function generateAdminAttendanceReport() {
  var eventId   = document.getElementById('reportEvent')?.value || '';
  var attendance = getAttendance().filter(function (a) { return !eventId || a.eventId === eventId; });
  var tbody     = document.getElementById('attendanceReportBody');
  if (!tbody) return;
  var userMap = new Map(getUsers().map(function (u) { return [u.id, u]; }));
  tbody.innerHTML = attendance.map(function (r) {
    var student = userMap.get(r.studentId);
    return '<tr>' +
      '<td>' + escapeHtml(student ? student.name : 'Unknown') + '</td>' +
      '<td>' + formatDate(r.date) + '</td>' +
      '<td>' + (r.time || '—') + '</td>' +
      '<td><span class="badge bg-' + (r.status === 'present' ? 'success' : r.status === 'late' ? 'warning text-dark' : 'danger') + '">' + escapeHtml(r.status) + '</span></td>' +
      '</tr>';
  }).join('');
}

function generateAdminSanctionReport() {
  var statusFilter = document.getElementById('sanctionStatusFilter')?.value || 'all';
  var sanctions = getSanctions().filter(function (s) { return statusFilter === 'all' || s.status === statusFilter; });
  var tbody = document.getElementById('sanctionReportBody');
  if (!tbody) return;
  var userMap = new Map(getUsers().map(function (u) { return [u.id, u]; }));
  tbody.innerHTML = sanctions.map(function (s) {
    var student = userMap.get(s.studentId);
    return '<tr>' +
      '<td>' + escapeHtml(student ? student.name : 'Unknown') + '</td>' +
      '<td>' + escapeHtml(s.description) + '</td>' +
      '<td>' + severityBadge(s.severity) + '</td>' +
      '<td><span class="badge bg-' + (s.status === 'active' ? 'danger' : 'secondary') + '">' + escapeHtml(s.status) + '</span></td>' +
      '</tr>';
  }).join('');
}


/* ============================================================
   Admin — Settings
   ============================================================ */

function initAdminSettings() {
  var policy = getSanctionPolicy();
  document.getElementById('policyMinorWarning').value    = policy.minor.warning;
  document.getElementById('policyMinorProbation').value   = policy.minor.probation;
  document.getElementById('policyMinorSuspension').value  = policy.minor.suspension;
  document.getElementById('policyMajorWarning').value     = policy.major.warning;
  document.getElementById('policyMajorProbation').value   = policy.major.probation;
  document.getElementById('policyMajorSuspension').value  = policy.major.suspension;

  document.getElementById('savePolicyBtn').addEventListener('click', function () {
    var newPolicy = {
      minor: {
        warning:    parseInt(document.getElementById('policyMinorWarning').value) || 3,
        probation:  parseInt(document.getElementById('policyMinorProbation').value) || 5,
        suspension: parseInt(document.getElementById('policyMinorSuspension').value) || 7
      },
      major: {
        warning:    parseInt(document.getElementById('policyMajorWarning').value) || 1,
        probation:  parseInt(document.getElementById('policyMajorProbation').value) || 2,
        suspension: parseInt(document.getElementById('policyMajorSuspension').value) || 3
      }
    };
    setSanctionPolicy(newPolicy);
    showToast('success', 'Sanction policy updated.');
  });

  var semester = safeGet('attendly_semester', { name: 'SY 2026–2027', term: '1st Semester', startDate: '', endDate: '' });
  document.getElementById('semesterName').value      = semester.name;
  document.getElementById('semesterTerm').value      = semester.term;
  document.getElementById('semesterStart').value     = semester.startDate;
  document.getElementById('semesterEnd').value       = semester.endDate;

  document.getElementById('saveSemesterBtn').addEventListener('click', function () {
    var newSem = {
      name:      document.getElementById('semesterName').value.trim(),
      term:      document.getElementById('semesterTerm').value.trim(),
      startDate: document.getElementById('semesterStart').value,
      endDate:   document.getElementById('semesterEnd').value
    };
    localStorage.setItem('attendly_semester', JSON.stringify(newSem));
    showToast('success', 'Semester settings saved.');
  });

  loadKioskStations();
  var stationForm = document.getElementById('addStationForm');
  if (stationForm) {
    stationForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name   = document.getElementById('stationName').value.trim();
      var device = document.getElementById('stationDevice').value.trim();
      var loc    = document.getElementById('stationLocation').value.trim();
      if (!name) { showToast('error', 'Station name is required.'); return; }
      var stations = safeGet('attendly_stations', []);
      stations.push({ id: generateId('station'), name: name, device: device || '—', location: loc || '—' });
      localStorage.setItem('attendly_stations', JSON.stringify(stations));
      loadKioskStations();
      stationForm.reset();
      showToast('success', 'Kiosk station added.');
    });
  }
}

function loadKioskStations() {
  var stations = safeGet('attendly_stations', []);
  var tbody = document.getElementById('stationTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!stations.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--color-text-muted);padding:24px;">No stations registered.</td></tr>';
    return;
  }
  stations.forEach(function (st) {
    var row = document.createElement('tr');
    row.innerHTML =
      '<td>' + escapeHtml(st.name) + '</td>' +
      '<td>' + escapeHtml(st.device) + '</td>' +
      '<td>' + escapeHtml(st.location) + '</td>' +
      '<td><button class="btn btn-sm btn-outline-danger" onclick="deleteStation(\'' + escapeHtml(st.id) + '\')"><i class="bi bi-trash"></i></button></td>';
    tbody.appendChild(row);
  });
}

function deleteStation(id) {
  if (!confirm('Remove this kiosk station?')) return;
  var stations = safeGet('attendly_stations', []).filter(function (s) { return s.id !== id; });
  localStorage.setItem('attendly_stations', JSON.stringify(stations));
  loadKioskStations();
  showToast('success', 'Station removed.');
}


/* ============================================================
   CSV export helper
   ============================================================ */

function tableToCsv(tableBodyId, headers) {
  var rows = Array.from(document.getElementById(tableBodyId).querySelectorAll('tr')).map(function (tr) {
    return Array.from(tr.children).map(function (td) {
      return '"' + td.textContent.trim().replace(/"/g, '""') + '"';
    }).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

function downloadCsv(filename, csvContent) {
  var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  var url  = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
