/* ============================================================
   UI Utilities — toast notifications, theme, formatting, badges
   ------------------------------------------------------------
   Shared across all pages. Provides toast popups, dark/light
   theme toggling, date formatting, severity badges, and
   empty-state helpers. The escapeHtml function is critical
   for XSS prevention — always use it before injecting user
   data into innerHTML.
   ============================================================ */

/**
 * Escape HTML special characters to prevent XSS when
 * injecting user-supplied strings into innerHTML.
 *
 * @param {*} str — value to escape (coerced to string)
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(str).replace(/[&<>"']/g, ch => escapeMap[ch]);
}

/**
 * Reduce a value to a safe CSS class token.
 *
 * HTML-escaping alone is not the right tool for a class attribute. The
 * escaping stops a value from closing the attribute, but it still lets
 * arbitrary *tokens* through, so a record could inject styling classes
 * it has no business owning (layout overrides, display:none, and so on).
 * This position allowlists the exact tokens it accepts and falls back to
 * a neutral one otherwise.
 *
 * @param {*} value
 * @param {string[]} allowed - exact tokens permitted for this position
 * @returns {string}
 */
function safeToken(value, allowed) {
  return allowed.includes(value) ? value : 'unknown';
}

/**
 * Display a toast notification. Falls back to a plain DOM
 * element when Bootstrap's JS is unavailable.
 *
 * @param {'success'|'error'|'info'|'warning'} type
 * @param {string} message — plain text (not HTML)
 */
function showToast(type, message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const variantClass = type === 'success' ? 'toast-success'
                     : type === 'error'   ? 'toast-error'
                     : 'toast-info';

  const toastEl = document.createElement('div');
  toastEl.className = `toast align-items-center border-0 ${variantClass}`;
  toastEl.setAttribute('role', 'alert');
  toastEl.style.marginBottom = '0.5rem';
  toastEl.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${escapeHtml(message)}</div>
      <button type="button" class="btn-close me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>
  `;
  container.appendChild(toastEl);
  if (window.bootstrap && window.bootstrap.Toast) {
    const toast = new window.bootstrap.Toast(toastEl, { delay: 3000 });
    toast.show();
    toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
    return;
  }

  // Keep feedback working when the optional Bootstrap CDN is unavailable.
  toastEl.style.cssText += 'display:block;padding:0.75rem 1rem;border-radius:0.375rem;';
  window.setTimeout(() => toastEl.remove(), 3000);
}

/* ============================================================
   Theme Management
   ============================================================ */

/** Read the saved theme and apply it before first paint.
 * Auth screens intentionally stick to the dark campus palette by default to
 * match the last approved identity treatment. */
function initTheme() {
  const isAuthPage = /\/(login|signup)\.html$/.test(window.location.pathname);
  const savedTheme = localStorage.getItem('theme');
  const resolvedTheme = savedTheme || (isAuthPage ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', resolvedTheme);
}

/** Toggle between light and dark mode, persist the choice. */
function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  updateThemeIcons(newTheme);
}

/** Sync all theme-toggle icons (moon ↔ sun) to the current theme. */
function updateThemeIcons(theme) {
  document.querySelectorAll('[data-theme-icon]').forEach(icon => {
    icon.className = theme === 'dark' ? 'bi bi-sun' : 'bi bi-moon';
  });
}

// Initialise theme on page load.
document.addEventListener('DOMContentLoaded', function () {
  initTheme();
  updateThemeIcons(document.documentElement.getAttribute('data-theme') || 'light');

  document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
    btn.addEventListener('click', toggleTheme);
  });

  initResponsiveShell();
  initNotifications();
  initUserDropdown();
});

/**
 * Provide one keyboard-safe announcement panel for every workspace. Pages may
 * include the panel in their markup, but it is created on demand elsewhere so
 * a bell never looks actionable without actually doing something.
 */
function initNotifications() {
  const triggers = Array.from(document.querySelectorAll('[aria-label="Notifications"]'));
  if (!triggers.length) return;

  let panel = document.getElementById('notificationPanel');
  let backdrop = document.getElementById('notificationBackdrop');
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'notification-panel';
    panel.id = 'notificationPanel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'notificationPanelTitle');
    panel.innerHTML = '<div class="notification-panel-head"><div><p class="section-kicker">Campus updates</p><h2 id="notificationPanelTitle">Notifications</h2></div><button class="icon-button notification-close" type="button" aria-label="Close notifications"><i class="bi bi-x-lg"></i></button></div><div class="notification-panel-list" id="notificationList"></div>';
    document.body.appendChild(panel);
  }
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'notification-backdrop';
    backdrop.id = 'notificationBackdrop';
    backdrop.hidden = true;
    document.body.appendChild(backdrop);
  }

  const list = panel.querySelector('.notification-panel-list');
  const closeButton = panel.querySelector('.notification-close');
  let trigger = null;

  triggers.forEach(button => {
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => open(button));
  });

  function render() {
    if (!list) return;
    const announcements = typeof getAnnouncements === 'function' ? getAnnouncements() : [];
    list.replaceChildren();
    if (!announcements.length) {
      const empty = document.createElement('p');
      empty.className = 'notification-empty';
      empty.textContent = 'No announcements yet.';
      list.appendChild(empty);
      return;
    }
    announcements.forEach(item => {
      const row = document.createElement('div');
      row.className = 'announcement-item';
      const title = document.createElement('strong');
      title.textContent = item.title || 'Campus update';
      const detail = document.createElement('small');
      detail.textContent = item.detail || '';
      row.append(title, detail);
      list.appendChild(row);
    });
  }

  function open(source) {
    trigger = source || document.activeElement;
    render();
    panel.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('notification-open');
    triggers.forEach(button => button.setAttribute('aria-expanded', 'true'));
    window.setTimeout(() => closeButton && closeButton.focus(), 0);
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('notification-open');
    triggers.forEach(button => button.setAttribute('aria-expanded', 'false'));
    if (trigger && typeof trigger.focus === 'function') trigger.focus();
  }

  closeButton && closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if (panel.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(panel.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  window.openSharedNotifications = open;
}

/**
 * Turn the shared workspace sidebar into an accessible off-canvas drawer on
 * small screens. Markup is added here so every student, SSC, and administrator
 * page gets the same navigation without duplicating controls across 21 files.
 */
function initResponsiveShell() {
  const sidebar = document.querySelector('.app-sidebar, .role-sidebar, .student-sidebar');
  const topbar = document.querySelector('.app-topbar, .role-topbar, .student-topbar');
  if (!sidebar || !topbar || topbar.querySelector('.app-mobile-menu-toggle')) return;

  const mobileQuery = window.matchMedia('(max-width: 720px)');
  const sidebarId = sidebar.id || 'workspace-navigation';
  sidebar.id = sidebarId;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'icon-button app-mobile-menu-toggle';
  toggle.setAttribute('aria-label', 'Open navigation');
  toggle.setAttribute('aria-controls', sidebarId);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<i class="bi bi-list" aria-hidden="true"></i>';
  topbar.prepend(toggle);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'icon-button app-drawer-close';
  closeButton.setAttribute('aria-label', 'Close navigation');
  closeButton.innerHTML = '<i class="bi bi-x-lg" aria-hidden="true"></i>';
  sidebar.prepend(closeButton);

  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'app-nav-backdrop';
  backdrop.setAttribute('aria-label', 'Close navigation');
  backdrop.hidden = true;
  sidebar.insertAdjacentElement('afterend', backdrop);

  let restoreFocus = false;

  function setDrawer(open, options) {
    const shouldOpen = Boolean(open && mobileQuery.matches);
    const settings = options || {};

    sidebar.classList.toggle('is-open', shouldOpen);
    backdrop.classList.toggle('is-visible', shouldOpen);
    backdrop.hidden = !shouldOpen;
    document.body.classList.toggle('nav-drawer-open', shouldOpen);
    toggle.setAttribute('aria-expanded', String(shouldOpen));
    toggle.setAttribute('aria-label', shouldOpen ? 'Close navigation' : 'Open navigation');
    toggle.querySelector('i').className = shouldOpen ? 'bi bi-x-lg' : 'bi bi-list';

    if (mobileQuery.matches) {
      sidebar.inert = !shouldOpen;
      sidebar.setAttribute('aria-hidden', String(!shouldOpen));
    } else {
      sidebar.inert = false;
      sidebar.removeAttribute('aria-hidden');
    }

    if (shouldOpen) {
      restoreFocus = true;
      const activeLink = sidebar.querySelector('a.active') || sidebar.querySelector('a, button');
      if (activeLink) {
        window.setTimeout(() => {
          if (toggle.getAttribute('aria-expanded') === 'true') activeLink.focus();
        }, 80);
      }
    } else if (settings.returnFocus && restoreFocus) {
      restoreFocus = false;
      toggle.focus();
    }
  }

  toggle.addEventListener('click', () => {
    setDrawer(toggle.getAttribute('aria-expanded') !== 'true', { returnFocus: true });
  });
  closeButton.addEventListener('click', () => setDrawer(false, { returnFocus: true }));
  backdrop.addEventListener('click', () => setDrawer(false, { returnFocus: true }));
  sidebar.addEventListener('click', event => {
    if (event.target.closest('a')) setDrawer(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setDrawer(false, { returnFocus: true });
      return;
    }

    if (event.key === 'Tab' && toggle.getAttribute('aria-expanded') === 'true') {
      const focusable = Array.from(sidebar.querySelectorAll('a[href], button:not([disabled])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  mobileQuery.addEventListener('change', () => setDrawer(false));

  setDrawer(false);
}


/* ============================================================
   Date & Badge Helpers
   ============================================================ */

/**
 * Format a "YYYY-MM-DD" string into a human-readable date.
 * @param {string} dateStr
 * @returns {string} e.g. "Sep 8, 2026"
 */
function formatDate(dateStr) {
  const options = { year: 'numeric', month: 'short', day: 'numeric' };
  return new Date(dateStr).toLocaleDateString(undefined, options);
}

/**
 * Return the severity badge HTML for a sanction level.
 * @param {'warning'|'probation'|'suspension'} severity
 * @returns {string} innerHTML for a <span class="badge …">
 */
function severityBadge(severity) {
  const classMap = {
    warning:    'badge-warning-severity',
    probation:  'badge-probation-severity',
    suspension: 'badge-suspension-severity',
  };
  const cls = classMap[severity] || 'bg-secondary';
  const label = severity.charAt(0).toUpperCase() + severity.slice(1);
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

/**
 * Show or hide an empty-state container based on whether
 * data is present.
 *
 * @param {string}  containerId — DOM id of the empty-state element
 * @param {boolean} hasData     — true = hide empty state, false = show it
 */
function toggleEmptyState(containerId, hasData) {
  const empty = document.getElementById(containerId);
  if (empty) {
    empty.classList.toggle('d-none', hasData);
  }
}


/* ============================================================
   Grouped Student List (Department → Course → Year Level)
   ------------------------------------------------------------
   Shared by the SSC and Admin "Manage Students" pages. Renders the
   student table as collapsible department + course sections (Year
   Level stays a column so rows stay compact), backed by the three
   org filter dropdowns and a name/ID/email search box. Each page
   supplies a renderRow(student) callback for its own columns — the
   grouping / filter / collapse behaviour lives here.
   ============================================================ */

/**
 * Initialise the grouped, filterable student list on a manage-students
 * page: populate the filter dropdowns, wire search + collapse, render
 * into the table body. Re-render later via refreshGroupedStudentList().
 *
 * @param {object} opts
 * @param {string}   [opts.tbodyId='studentTableBody']
 * @param {string}   [opts.countId='studentCount']
 * @param {string}   [opts.departmentFilterId='filterDepartment']
 * @param {string}   [opts.courseFilterId='filterCourse']
 * @param {string}   [opts.yearFilterId='filterYear']
 * @param {string}   [opts.searchId='studentSearch']
 * @param {number}   [opts.colspan=5]
 * @param {function(object):string} opts.renderRow — returns the cell HTML for one student row
 */
function initGroupedStudentList(opts) {
  const tbody = document.getElementById(opts.tbodyId || 'studentTableBody');
  if (!tbody) return;

  const deptSel   = document.getElementById(opts.departmentFilterId || 'filterDepartment');
  const courseSel = document.getElementById(opts.courseFilterId   || 'filterCourse');
  const yearSel   = document.getElementById(opts.yearFilterId     || 'filterYear');
  const searchEl  = document.getElementById(opts.searchId         || 'studentSearch');
  const colspan   = opts.colspan || 5;
  const taxonomy  = getStudentOrgTaxonomy();

  // ── Filter dropdown options ──
  if (deptSel) {
    deptSel.innerHTML = '<option value="">All Departments</option>' +
      taxonomy.departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('') +
      `<option value="${UNASSIGNED}">${UNASSIGNED}</option>`;
  }
  if (yearSel) {
    yearSel.innerHTML = '<option value="">All Year Levels</option>' +
      taxonomy.yearLevels.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(getStudentYearLabel(y))}</option>`).join('') +
      `<option value="${UNASSIGNED}">${UNASSIGNED}</option>`;
  }

  // Course options follow the currently selected Department.
  function fillCourseOptions(selectedDept) {
    if (!courseSel) return;
    let courses;
    if (!selectedDept) {
      courses = [];
      Object.values(taxonomy.coursesByDept).forEach(list => list.forEach(c => courses.push(c)));
      courses.push(UNASSIGNED);
    } else if (selectedDept === UNASSIGNED) {
      courses = [UNASSIGNED];
    } else {
      courses = taxonomy.coursesByDept[selectedDept] || [];
    }
    courseSel.innerHTML = '<option value="">All Courses</option>' +
      courses.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  }

  function readState() {
    return {
      department: deptSel   ? deptSel.value  : '',
      course:     courseSel ? courseSel.value : '',
      yearLevel:  yearSel   ? yearSel.value  : '',
      query:      searchEl  ? searchEl.value : '',
    };
  }

  function render() {
    const state   = readState();
    const all     = getUsers().filter(u => u.role === 'student');
    const visible = applyStudentFilters(all, state, state.query);

    const countEl = document.getElementById(opts.countId || 'studentCount');
    if (countEl) countEl.textContent = `${visible.length} of ${all.length} students`;

    tbody.innerHTML = '';

    if (!visible.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="${colspan}" class="text-center text-muted py-4">` +
        '<i class="bi bi-people fs-5 me-2"></i>No students match the current filters.</td>';
      tbody.appendChild(tr);
      return;
    }

    groupStudentsByOrg(visible).forEach(group => {
      const studentCount = group.courses.reduce((n, c) => n + c.students.length, 0);
      tbody.appendChild(makeOrgHeadRow(group.department, `${group.courses.length} course${group.courses.length === 1 ? '' : 's'} · ${studentCount} student${studentCount === 1 ? '' : 's'}`, colspan, 'dept'));
      group.courses.forEach(courseGroup => {
        tbody.appendChild(makeOrgHeadRow(courseGroup.course, `${courseGroup.students.length} student${courseGroup.students.length === 1 ? '' : 's'}`, colspan, 'course'));
        courseGroup.students.forEach(student => {
          const tr = document.createElement('tr');
          tr.dataset.kind = 'student';
          tr.innerHTML = opts.renderRow(student);
          tbody.appendChild(tr);
        });
      });
    });
  }

  // Collapse/expand everything below a department or course header.
  function toggleGroup(headRow) {
    const level = headRow.dataset.level; // 'dept' | 'course'
    const willCollapse = !headRow.classList.contains('org-group-collapsed');
    headRow.classList.toggle('org-group-collapsed', willCollapse);
    headRow.setAttribute('aria-expanded', String(!willCollapse));
    let node = headRow.nextElementSibling;
    while (node) {
      if (node.dataset.kind === 'org-head') {
        // Stop at the next department head (after a dept header) or the
        // next course/department head (after a course header).
        if (level === 'course' || node.dataset.level === 'dept') break;
      }
      node.classList.toggle('org-group-hidden', willCollapse);
      node = node.nextElementSibling;
    }
  }

  tbody.addEventListener('click', (e) => {
    const head = e.target.closest && e.target.closest('.org-group-head');
    if (head) toggleGroup(head);
  });
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = e.target.closest && e.target.closest('.org-group-head');
    if (head) { e.preventDefault(); toggleGroup(head); }
  });

  // ── Filter + search wiring ──
  if (deptSel) deptSel.addEventListener('change', () => {
    fillCourseOptions(deptSel.value);
    // A course picked under the previous department may no longer exist.
    if (courseSel && courseSel.value && !courseSel.querySelector(`option[value="${courseSel.value}"]`)) {
      courseSel.value = '';
    }
    render();
  });
  if (courseSel) courseSel.addEventListener('change', render);
  if (yearSel)   yearSel.addEventListener('change', render);
  if (searchEl)  searchEl.addEventListener('input', render);

  fillCourseOptions(deptSel ? deptSel.value : '');
  render();

  // Expose a re-render hook so add/edit/delete handlers can refresh.
  window.__refreshStudentList = render;
}

/** Re-render the grouped student list with the current filter state. */
function refreshGroupedStudentList() {
  if (typeof window.__refreshStudentList === 'function') window.__refreshStudentList();
}

/**
 * Build a collapsible department (level 'dept') or course (level
 * 'course') header row spanning every column.
 */
function makeOrgHeadRow(title, pillText, colspan, level) {
  const tr = document.createElement('tr');
  tr.dataset.kind  = 'org-head';
  tr.dataset.level = level;
  tr.className = 'org-group-head ' + (level === 'dept' ? 'org-group-head-dept' : 'org-group-head-course');
  tr.setAttribute('role', 'button');
  tr.setAttribute('tabindex', '0');
  tr.setAttribute('aria-expanded', 'true');
  const icon = level === 'dept' ? 'bi-buildings-fill' : 'bi-journal-text';
  tr.innerHTML =
    `<td colspan="${colspan}">` +
      '<div class="org-group-label">' +
        '<span class="org-group-chevron"><i class="bi bi-chevron-down"></i></span>' +
        `<i class="bi ${icon} org-group-icon"></i>` +
        `<span class="org-group-title">${escapeHtml(title)}</span>` +
        `<span class="org-group-pill">${escapeHtml(pillText)}</span>` +
      '</div>' +
    '</td>';
  return tr;
}

/**
 * Populate the Department/Course/Year selects inside Add/Edit student
 * modals; the course options follow the selected department. Pass an
 * optional `initial` record to pre-fill existing values for editing.
 *
 * @returns {{ deptSel: HTMLSelectElement, courseSel: HTMLSelectElement, yearSel: HTMLSelectElement }}
 */
function initOrgModalSelects(deptId, courseId, yearId, initial) {
  const deptSel   = document.getElementById(deptId);
  const courseSel = courseId ? document.getElementById(courseId) : null;
  const yearSel   = document.getElementById(yearId);
  const init      = initial || {};
  const taxonomy  = getStudentOrgTaxonomy();

  function fillDepartment(value) {
    if (!deptSel) return;
    deptSel.innerHTML = '<option value="">Select department…</option>' +
      taxonomy.departments.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('') +
      `<option value="${UNASSIGNED}">${UNASSIGNED}</option>`;
    deptSel.value = value || '';
  }

  function fillCourse(department, value) {
    if (!courseSel) return;
    const courses = department
      ? (department === UNASSIGNED ? [UNASSIGNED] : (taxonomy.coursesByDept[department] || []))
      : [];
    courseSel.innerHTML = '<option value="">Select course…</option>' +
      courses.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    courseSel.value = value || '';
  }

  function fillYear(value) {
    if (!yearSel) return;
    yearSel.innerHTML = '<option value="">Select year…</option>' +
      taxonomy.yearLevels.map(y => `<option value="${escapeHtml(y)}">${escapeHtml(getStudentYearLabel(y))}</option>`).join('');
    yearSel.value = value || '';
  }

  fillDepartment(init.department);
  fillCourse(init.department, init.course);
  fillYear(init.yearLevel);

  if (deptSel && courseSel) {
    deptSel.addEventListener('change', () => { courseSel.value = ''; fillCourse(deptSel.value); });
  }

  return { deptSel, courseSel, yearSel };
}

/**
 * Year Level badge HTML for a student row in a grouped list.
 * @returns {string}
 */
function yearBadge(student) {
  const org      = normalizeStudentOrg(student);
  const assigned = org.yearLevel !== UNASSIGNED;
  const cls      = assigned ? 'year-badge' : 'year-badge year-unassigned';
  const label    = assigned ? getStudentYearLabel(org.yearLevel) : UNASSIGNED;
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}


/* ============================================================
   User Account Dropdown
   ------------------------------------------------------------
   Shared open/close behaviour for the account menu in the topbar.
   Every role dashboard ships the same markup, so the wiring lives
   here instead of being copied into each page.
   ============================================================ */

/**
 * Wire the topbar account dropdown: the toggle opens and closes the
 * menu, a click anywhere outside dismisses it, and Escape closes it
 * and returns focus to the toggle.
 */
function initUserDropdown() {
  const toggle = document.getElementById('userDropdownToggle');
  const menu = document.getElementById('userDropdownMenu');
  if (!toggle || !menu) return;

  toggle.addEventListener('click', function (event) {
    event.stopPropagation();
    const open = menu.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', function () {
    menu.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  });

  menu.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    menu.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  });
}


/* ============================================================
   Global Search
   ------------------------------------------------------------
   Cross-entity search over the topbar search box. The markup and
   styling are shared; only the destination for each result group is
   role-specific, so callers pass a links map.
   ============================================================ */

/**
 * Wire the global search box and render grouped results.
 *
 * @param {Object} links — role-specific destinations, e.g.
 *   { students: 'admin-manage-students.html', events: 'admin-reports.html' }
 */
function initGlobalSearch(links) {
  const input = document.getElementById('globalSearchInput');
  const results = document.getElementById('searchResults');
  const clear = document.getElementById('searchClear');
  const wrap = document.getElementById('globalSearch');
  if (!input || !results) return;

  const targets = Object.assign({
    students: '#',
    officers: '#',
    events: '#',
    sanctions: '#',
  }, links || {});

  function close() {
    results.classList.remove('open');
  }

  function render(query) {
    const users = getUsers();
    const events = getEvents();
    const sanctions = getSanctions();
    let html = '';

    const students = users.filter(u => u.role === 'student'
      && (u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query)));
    if (students.length) {
      html += '<div class="search-result-group"><i class="bi bi-people"></i> Students</div>';
      students.slice(0, 5).forEach(s => {
        html += '<a class="search-result-item" href="' + escapeHtml(targets.students) + '"><i class="bi bi-person"></i> '
          + escapeHtml(s.name)
          + ' <small style="color:var(--color-text-muted);margin-left:auto">' + escapeHtml(s.email) + '</small></a>';
      });
    }

    const officers = users.filter(u => u.role === 'ssc-officer'
      && (u.name.toLowerCase().includes(query) || u.email.toLowerCase().includes(query)));
    if (officers.length) {
      html += '<div class="search-result-group"><i class="bi bi-person-badge"></i> Officers</div>';
      officers.slice(0, 5).forEach(o => {
        html += '<a class="search-result-item" href="' + escapeHtml(targets.officers) + '"><i class="bi bi-person-badge"></i> '
          + escapeHtml(o.name)
          + ' <small style="color:var(--color-text-muted);margin-left:auto">' + escapeHtml(o.email) + '</small></a>';
      });
    }

    const matchedEvents = events.filter(e => e.name.toLowerCase().includes(query)
      || e.location.toLowerCase().includes(query));
    if (matchedEvents.length) {
      html += '<div class="search-result-group"><i class="bi bi-calendar-event"></i> Events</div>';
      matchedEvents.slice(0, 5).forEach(ev => {
        html += '<a class="search-result-item" href="' + escapeHtml(targets.events) + '"><i class="bi bi-calendar-event"></i> '
          + escapeHtml(ev.name)
          + ' <small style="color:var(--color-text-muted);margin-left:auto">' + escapeHtml(ev.date) + '</small></a>';
      });
    }

    const matchedSanctions = sanctions.filter(s => {
      const student = users.find(u => u.id === s.studentId);
      const name = student ? student.name.toLowerCase() : '';
      return name.includes(query)
        || s.description.toLowerCase().includes(query)
        || s.severity.toLowerCase().includes(query);
    });
    if (matchedSanctions.length) {
      html += '<div class="search-result-group"><i class="bi bi-shield-exclamation"></i> Sanctions</div>';
      matchedSanctions.slice(0, 5).forEach(s => {
        const student = users.find(u => u.id === s.studentId);
        html += '<a class="search-result-item" href="' + escapeHtml(targets.sanctions) + '"><i class="bi bi-shield-exclamation"></i> '
          + escapeHtml(student ? student.name : 'Unknown') + ' — ' + escapeHtml(s.description)
          + ' <small style="color:var(--color-text-muted);margin-left:auto">' + escapeHtml(s.severity) + '</small></a>';
      });
    }

    if (!html) html = '<div class="search-no-results">No results found for "' + escapeHtml(query) + '"</div>';
    results.innerHTML = html;
    results.classList.add('open');
  }

  input.addEventListener('input', function () {
    const query = this.value.trim().toLowerCase();
    if (clear) clear.classList.toggle('visible', query.length > 0);
    if (query.length < 2) { close(); return; }
    render(query);
  });

  input.addEventListener('focus', function () {
    if (this.value.trim().length >= 2) results.classList.add('open');
  });

  document.addEventListener('click', function (event) {
    if (wrap && !wrap.contains(event.target)) close();
  });

  if (clear) {
    clear.addEventListener('click', function () {
      input.value = '';
      close();
      this.classList.remove('visible');
      input.focus();
    });
  }
}
