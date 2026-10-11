/* ============================================================
   Kiosk — flagship self-service event check-in (no login required)
   ------------------------------------------------------------
   State machine: idle → scanning → processing → (success | error)
   Identity comes from FingerprintScanner (simulated until the real
   device is wired in). Attendance is recorded only after a verified
   scan, matching BR-007.

   Enhancements over the base flow:
   • Explicit "Tap to scan" button (ring + button both trigger scan).
   • Live event countdown (starts in / in progress / closes).
   • 3-tile live counts (checked-in / enrolled / attendance %).
   • "Recent check-ins" ticker — last N successful scans.
   • Richer result overlay (avatar initials on success).

   Security: all user-supplied strings are escaped via escapeHtml()
   before being injected into innerHTML. The manual entry form
   accepts student ID or email — both are validated server-side
   in production, here we just match against the users collection.
   ============================================================ */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Kiosk UI element references
  let els = {};
  let currentEventId = null;
  let busy = false; // true while a scan is in flight — blocks input
  const CHECKIN_EARLY_MS = 30 * 60 * 1000;
  const CHECKIN_WINDOW_MS = 6 * 60 * 60 * 1000;

  // ── Event loading ──
  function loadKioskEvents() {
    const events = (getEvents() || []).filter((e) => (e.status || 'scheduled') !== 'cancelled');
    const select = els.event;
    select.innerHTML = events.length
      ? events.map((event) =>
          `<option value="${escapeHtml(event.id)}">${escapeHtml(event.name)} · ${formatDate(event.date)} · ${escapeHtml(event.time)}</option>`
        ).join('')
      : '<option value="">No events available</option>';

    if (events.length) {
      currentEventId = events[0].id;
      select.value = currentEventId;
    } else {
      currentEventId = null;
    }
    renderEventHeader();
    updateCounts();
    renderTicker();
  }

  function renderEventHeader() {
    const event = getEvents().find((e) => e.id === currentEventId);
    if (!event) {
      els.eventName.textContent = 'Select an event to begin';
      els.eventMeta.textContent = 'Create an event in the SSC dashboard, then return here.';
      els.statusChip.textContent = 'No event';
      els.statusChip.className = 'kiosk-status-badge is-closed';
      setScanAvailability(false, 'Select an event', 'Choose an active event first.');
      hideCountdown();
      return;
    }

    const phase = getEventPhase(event);
    els.eventName.textContent = event.name;

    const parts = [`${formatDate(event.date)} · ${event.time}`];
    if (event.location) parts.push(event.location);
    if (event.mandatory) parts.push('Mandatory');
    else parts.push('Optional');
    els.eventMeta.textContent = parts.join(' · ');

    const statusChip = els.statusChip;
    statusChip.className = 'kiosk-status-badge is-' + phase;
    statusChip.textContent = phase === 'live' ? 'Check-in open'
      : phase === 'upcoming' ? 'Upcoming'
      : phase === 'cancelled' ? 'Cancelled'
      : 'Closed';

    setScanAvailability(
      phase === 'live',
      phase === 'live' ? 'Touch to scan' : phase === 'upcoming' ? 'Check-in opens soon' : 'Check-in unavailable',
      phase === 'live' ? 'Fingerprint reader ready' : phase === 'upcoming' ? 'Please wait for the check-in window.' : 'Choose another active event.'
    );
    if (!busy) {
      setStatus(
        'idle',
        phase === 'live' ? 'Ready for check-in' : phase === 'upcoming' ? 'Check-in not open yet' : 'Check-in unavailable',
        phase === 'live' ? 'Place one finger flat on the reader.' : phase === 'upcoming' ? 'This station will unlock when check-in opens.' : 'Choose another active event.'
      );
    }
    renderCountdown(event, phase);
  }

  // ── Live countdown (updates every 20s) ──
  function hideCountdown() {
    els.countdown.hidden = true;
    els.countdown.innerHTML = '';
  }

  function getEventPhase(event) {
    if (!event || event.status === 'cancelled') return 'cancelled';
    if (event.status === 'completed') return 'closed';
    const start = parseEventDateTime(event.date, event.time);
    const now = new Date();
    if (now < start - CHECKIN_EARLY_MS) return 'upcoming';
    if (now > start.getTime() + CHECKIN_WINDOW_MS) return 'closed';
    return 'live';
  }

  function setScanAvailability(enabled, title, detail) {
    els.scanBtn.disabled = !enabled;
    els.scanBtn.setAttribute('aria-label', title);
    if (els.scanCtaTitle) els.scanCtaTitle.textContent = title;
    if (els.scanCtaDetail) els.scanCtaDetail.textContent = detail;
    if (els.manualInput) els.manualInput.disabled = !enabled;
    if (els.manualSubmit) els.manualSubmit.disabled = !enabled;
  }

  function renderCountdown(event, phase) {
    const el = els.countdown;
    el.hidden = false;
    const start = parseEventDateTime(event.date, event.time);
    const now = new Date();

    if (phase === 'cancelled') {
      el.innerHTML = '<i class="bi bi-x-circle"></i> This event has been cancelled';
    } else if (phase === 'closed') {
      el.innerHTML = '<i class="bi bi-lock"></i> Check-in window has closed';
    } else if (phase === 'upcoming') {
      const diff = Math.max(0, start - CHECKIN_EARLY_MS - now);
      const days = Math.ceil(diff / 86400000);
      const label = diff > 86400000 ? (days + (days === 1 ? ' day' : ' days')) : formatCountdown(diff);
      el.innerHTML = `<i class="bi bi-hourglass-split"></i> Check-in opens in ${label}`;
    } else {
      const remaining = start.getTime() + CHECKIN_WINDOW_MS - now;
      el.innerHTML = `<i class="bi bi-broadcast"></i> Open now · closes in ${formatCountdown(remaining)}`;
    }
  }

  /** "HH:MM" (local) + "YYYY-MM-DD" -> Date */
  function parseEventDateTime(dateStr, timeStr) {
    const d = new Date(dateStr + 'T' + timeStr);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  function formatCountdown(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  // ── Live counts — checked-in / enrolled / attendance % ──
  function updateCounts() {
    const attendance = getAttendance();
    const checkedIn = currentEventId
      ? attendance.filter((a) => a.eventId === currentEventId && (a.status === 'present' || a.status === 'late')).length
      : 0;

    els.count.textContent = checkedIn;

    const enrolled = (getBiometrics() || []).filter((b) => b.status === 'enrolled').length;
    const estimate = enrolled || getUsers().filter((u) => u.role === 'student').length;
    els.listCount.textContent = estimate;

    // Attendance % = checked-in / enrolled (only meaningful when enrollees > 0).
    const denom = estimate || 1;
    els.attendancePct.textContent = denom ? Math.round((checkedIn / denom) * 100) + '%' : '0%';
  }

  // ── Recent check-ins ticker (last N successful scans for this event) ──
  const TICKER_MAX = 4;

  function renderTicker() {
    if (!els.ticker) return;
    const attendance = getAttendance();
    const recent = currentEventId
      ? attendance.filter((a) => a.eventId === currentEventId && (a.status === 'present' || a.status === 'late'))
      : [];
    // Seed data may have no time; newest first.
    const sorted = recent.slice().sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    const latest = sorted.slice(0, TICKER_MAX);

    if (!latest.length) {
      els.ticker.hidden = true;
      return;
    }
    els.ticker.hidden = false;

    const users = getUsers();
    els.tickerList.innerHTML = latest.map((a) => {
      const student = users.find((u) => u.id === a.studentId);
      const name = student ? student.name : 'Student';
      const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
      const firstName = name.split(' ')[0];
      return (
        `<div class="kiosk-ticker-item">` +
          `<span class="kiosk-ticker-avatar">${escapeHtml(initials)}</span>` +
          `<span class="kiosk-ticker-info">` +
            `<span class="kiosk-ticker-name">${escapeHtml(firstName)} checked in</span>` +
            `<span class="kiosk-ticker-time">${escapeHtml(a.time || 'now')}</span>` +
          `</span>` +
          `<i class="bi bi-check-circle-fill kiosk-ticker-check" aria-hidden="true"></i>` +
        `</div>`
      );
    }).join('');
  }

  // ── Status rendering — drives the kiosk scan panel ──
  function setStatus(state, text, hint) {
    const scanner = els.scanner;
    scanner.dataset.state = state;
    scanner.setAttribute('aria-busy', String(state === 'scanning' || state === 'processing'));
    if (text !== undefined) els.statusText.textContent = text;
    if (hint !== undefined) els.scanHint.textContent = hint;
  }

  // ── Recording attendance (FR-005/006, BR-007/008) ──
  async function recordAttendance(student) {
    const event = getEvents().find((item) => item.id === currentEventId);
    if (getEventPhase(event) !== 'live') return 'unavailable';
    const attendance = getAttendance();
    const already = attendance.some((a) => a.studentId === student.id && a.eventId === currentEventId);
    if (already) return 'duplicate';

    const now = new Date();

    // Backend mode: the server is the source of truth. Post first and only
    // record locally once it agrees, so a rejected check-in never shows the
    // student a success screen. Only numeric ids exist server-side, so a
    // local (string) id means we are still on demo data.
    let record;
    if (isApiEnabled() && typeof currentEventId === 'number' && typeof student.id === 'number') {
      try {
        record = await api.checkIn(currentEventId, student.id, 'fingerprint');
      } catch (err) {
        if (err.code === 'duplicate_checkin') return 'duplicate';
        return 'server-error';
      }
    }

    // The server row already carries id/date/time/status in the shapes the
    // reports expect, so reuse it and keep the two flag fields demo-only.
    attendance.push(Object.assign({
      excused: false,
      excuseReason: ''
    }, record || {
      id: generateId('att'),
      date: todayStr(),               // local date, not UTC
      time: now.toTimeString().slice(0, 5),
      status: 'present'
    }, {
      studentId: student.id,
      eventId: currentEventId
    }));
    setAttendance(attendance);
    return 'ok';
  }

  // ── Result overlay (success / error) ──
  const RESULT_ICONS = {
    success:       'check-circle-fill',
    'already':     'exclamation-triangle-fill',
    'no-match':    'x-circle-fill',
    'not-enrolled': 'x-circle-fill',
'device-error': 'x-circle-fill',
    'server-error': 'x-circle-fill',
    'no-event':    'info-circle-fill',
  };

  function showResult(type, title, message, meta) {
    // Set the state class on the wrapper (drives gradient disc colors)
    // and a stable icon class on the inner <i> (drives glyph + white text).
    const wrap = els.resultIconWrap || els.resultIcon.parentElement;
    wrap.className = `kiosk-result-icon-wrap is-${type}`;
    els.resultIcon.className = `bi bi-${RESULT_ICONS[type] || 'info-circle-fill'} kiosk-result-icon`;
    els.resultTitle.textContent = title;
    els.resultMessage.textContent = message;
    // meta is controlled HTML from our code — safe to use innerHTML
    els.resultMeta.innerHTML = meta || '';
    els.resultOverlay.hidden = false;
    els.resultDone.focus();
  }

  // ── Fingerprint check-in flow ──
  async function runFingerprintScan() {
    if (busy) return;
    const event = getEvents().find((e) => e.id === currentEventId);
    if (!event) {
      showResult('no-event', 'No event selected', 'Choose an event before scanning.', '');
      return;
    }
    if (getEventPhase(event) !== 'live') {
      showResult('no-event', 'Check-in unavailable', 'This event is not accepting check-ins right now.', 'Choose an event marked “Check-in open”.');
      return;
    }

    busy = true;
    setStatus('scanning', 'Scanning…', 'Place your finger on the reader and hold it there.');
    els.resultOverlay.hidden = true;

    const scanner = window.FingerprintScanner;
    let result = null;

    try {
      result = await scanner.scan();
      setStatus('processing', 'Verifying fingerprint…', 'Matching your template. Hold still.');

      // Small beat so the "processing" state is perceivable (~0.6s).
      await sleep(650);

      const student = getUsers().find((u) => u.id === result.studentId);
      if (!student) {
        showResult('no-match', 'No record found', 'This fingerprint did not match an enrolled student.', '');
        setStatus('error', 'Verification failed', 'Please try again.');
        return;
      }

      const outcome = await recordAttendance(student);
      if (outcome === 'unavailable') {
        showResult('no-event', 'Check-in unavailable', 'This event is not accepting check-ins right now.', 'Choose an event marked “Check-in open”.');
        setStatus('attention', 'Check-in unavailable', 'Choose another active event.');
        return;
      }
      if (outcome === 'duplicate') {
        showResult('already', 'Already checked in', `${student.name} is already present for this event.`, '');
        setStatus('attention', 'Already checked in', 'No action needed.');
      } else if (outcome === 'server-error') {
        showResult('server-error', 'Server unreachable', 'The attendance server did not accept this check-in. Please retry, or see the SSC booth.', '');
        setStatus('error', 'Not recorded', 'The server did not confirm this check-in.');
      } else {
        showResult(
          'success',
          `Welcome, ${student.name.split(' ')[0]}!`,
          'Attendance recorded.',
          `<strong>${escapeHtml(event.name)}</strong> · ${new Date().toLocaleTimeString()}`
        );
        setStatus('success', 'Checked in', 'Attendance saved. You can go ahead.');
        updateCounts();
        renderTicker();
      }
    } catch (err) {
      const code = err.code || 'device-error';
      const map = {
        'no-match':       ['Cannot identify you', 'Try again with another finger or contact the SSC booth.'],
        'not-enrolled':   ['Not enrolled', 'Your fingerprint is not on file. Visit the SSC booth for enrollment or use manual entry.'],
        'device-error':   ['Scanner unavailable', 'The reader is offline. Use manual entry or try again shortly.']
      };
      const [title, message] = map[code] || ['Scan failed', 'Something went wrong. Try again.'];
      showResult(code === 'no-match' ? 'no-match' : code, title, message, '');
      setStatus('error', title, message);
    } finally {
      busy = false;
    }
  }

  // ── Manual override (fallback when no enrolled fingerprint) ──
  async function runManualEntry(rawId) {
    const id = (rawId || '').trim();
    const event = getEvents().find((e) => e.id === currentEventId);
    if (!event || !id) return;
    if (getEventPhase(event) !== 'live') {
      showToast('warning', 'This event is not accepting check-ins right now.');
      return;
    }

    const student = getUsers().find((u) => u.role === 'student' && (u.id === id || u.email === id));
    if (!student) {
      showToast('error', 'Student not found.');
      return;
    }
    const outcome = await recordAttendance(student);
    if (outcome === 'duplicate') {
      showToast('warning', `${student.name} is already checked in.`);
      showResult('already', 'Already checked in', `${student.name} is already present for this event.`, '');
    } else if (outcome === 'server-error') {
      showToast('error', 'The server did not record this check-in. Please retry.');
      showResult('server-error', 'Server unreachable', 'The attendance server did not accept this check-in. Please retry, or see the SSC booth.', '');
    } else {
      showResult(
        'success',
        `Welcome, ${student.name.split(' ')[0]}!`,
        'Manual attendance recorded.',
        `<strong>${escapeHtml(event.name)}</strong> · ${new Date().toLocaleTimeString()}`
      );
      showToast('success', `${student.name} checked in.`);
      updateCounts();
      renderTicker();
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── Clock ──
  function tickClock() {
    const now = new Date();
    els.clockTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    els.clockDate.textContent = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // ── Boot ──
  function init() {
    els = {
      event:        $('kioskEvent'),
      eventName:    $('kioskEventName'),
      eventMeta:    $('kioskEventMeta'),
      countdown:    $('kioskCountdown'),
      statusChip:   $('kioskStatusBadge'),
      scanner:      $('kioskScanner'),
      statusText:   $('kioskStatusText'),
      scanHint:     $('kioskScanHint'),
      scanBtn:      $('kioskScanBtn'),
      scanCtaTitle: document.querySelector('.kiosk-scan-cta strong'),
      scanCtaDetail: document.querySelector('.kiosk-scan-cta small'),
      count:        $('kioskCount'),
      listCount:    $('kioskListCount'),
      attendancePct: $('kioskAttendancePct'),
      ticker:       $('kioskTicker'),
      tickerList:   $('kioskTickerList'),
      resultOverlay: $('resultOverlay'),
      resultIconWrap: $('resultIconWrap'),
      resultIcon:   $('resultIcon'),
      resultTitle:  $('resultTitle'),
      resultMessage: $('resultMessage'),
      resultMeta:   $('resultMeta'),
      resultDone:   $('resultDone'),
      manualToggle: $('manualToggle'),
      manualBody:   $('manualBody'),
      manualForm:   $('kioskManualForm'),
      manualId:     $('manualStudentId'),
      manualInput:  $('manualStudentId'),
      manualSubmit: document.querySelector('#kioskManualForm button[type="submit"]'),
      clockTime:    $('kioskClockTime'),
      clockDate:    $('kioskClockDate')
    };

    loadKioskEvents();

    els.event.addEventListener('change', () => {
      currentEventId = els.event.value;
      renderEventHeader();
      updateCounts();
      renderTicker();
    });

    if (els.scanBtn) {
      els.scanBtn.addEventListener('click', (e) => {
        if (!busy) runFingerprintScan();
      });
    }

    // Manual entry collapse
    if (els.manualToggle) {
      els.manualToggle.addEventListener('click', () => {
        const expanded = els.manualToggle.getAttribute('aria-expanded') === 'true';
        els.manualToggle.setAttribute('aria-expanded', String(!expanded));
        els.manualBody.hidden = expanded;
      });
    }

    if (els.manualForm) {
      els.manualForm.addEventListener('submit', (e) => {
        e.preventDefault();
        // Awaited via .catch so a rejected server call surfaces on the
        // kiosk rather than as an unhandled promise rejection.
        runManualEntry(els.manualId.value).catch((err) => {
          showToast('error', 'The server did not record this check-in. Please retry.');
          showResult('server-error', 'Server unreachable', 'The attendance server did not accept this check-in. Please retry, or see the SSC booth.', '');
        });
        els.manualId.value = '';
      });
    }

    if (els.resultDone) {
      els.resultDone.addEventListener('click', () => {
        els.resultOverlay.hidden = true;
        setStatus('idle', 'Waiting for scan', 'Place your finger on the reader to check in.');
        els.scanBtn.focus();
      });
    }

    // Auto-start fingerprint device when available (no-op in simulation).
    if (window.FingerprintScanner) {
      window.FingerprintScanner.start().catch(() => {});
    }

    tickClock();
    setInterval(tickClock, 1000);

    // Refresh the countdown periodically.
    setInterval(() => renderEventHeader(), 20000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();