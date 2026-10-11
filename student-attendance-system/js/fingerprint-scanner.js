/* ============================================================
   FingerprintScanner — hardware abstraction for the event kiosk
   ------------------------------------------------------------
   The kiosk speaks ONLY to this tiny interface. It never deals
   with scanner vendor specifics. When a physical fingerprint
   reader arrives, implement the `scan()` contract against its
   SDK here (or against a backend endpoint that verifies a
   template) — nothing downstream in kiosk.js changes.

   Contract
   --------
   FingerprintScanner.scan()
     -> Promise<{ studentId, templateId }>   identity verified
     -> rejects with an Error carrying `code`:
          'no-match'   finger scanned but matched no registered template
          'not-enrolled' student has no enrolled template on file
          'device-error' hardware / service unavailable
   FingerprintScanner.start() / .stop()  — acquire/release the device.
   ============================================================ */

const FingerprintScanner = (function () {
  // ── Simulation configuration (remove once the real device is wired in) ──
  // In production this flag is false and `scan()` proxies to the scanner SDK
  // or a Verify endpoint. SIMULATION_MS lets the kiosk preview the full
  // scan/process/result flow without hardware.
  const SIMULATION_SCAN_MS = 1000;    // finger-placement window
  const SIMULATION_VERIFY_MS = 1500;  // template acquisition + match window
  const SIMULATION_FAULT_RATE = 0.12; // demo: ~12% of scans "fail" to match

  let device = null;
  let rotateIndex = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Simulated enrollment store lookup. In production the scanner returns a
   * captured template and the backend matches it against registered ones;
   * here we "match" against the prototype's biometrics registry.
   *
   * The simulator rotates through enrolled students so successive scans
   * (or simulated scans on the kiosk) produce different identities,
   * exercising the full attendance flow rather than always hitting the
   * first student in the list.
   */
  function loadBiometricRegistry() {
    // IMPORTANT: this key must match STORAGE_KEYS.biometrics in data.js
    // ('attendly_biometrics'). The legacy 'sass_biometrics' fallback covers
    // storage seeded before the key rename.
    const raw = localStorage.getItem('attendly_biometrics')
      || localStorage.getItem('sass_biometrics')
      || '[]';
    return JSON.parse(raw);
  }

  function matchRegisteredStudent() {
    const biometrics = loadBiometricRegistry();
    const enrolled = biometrics.filter((b) => b.status === 'enrolled');
    // No enrolled students at all -> a scanned finger can never be matched.
    if (enrolled.length === 0) return null;
    const matched = enrolled[rotateIndex % enrolled.length].studentId;
    rotateIndex = (rotateIndex + 1) % enrolled.length;
    return matched;
  }

  async function scan() {
    if (!device) {
      const err = new Error('Fingerprint scanner not connected.');
      err.code = 'device-error';
      throw err;
    }

    // Phase 1 — finger placement. The UI drives its "scanning" animation
    // during this window; resolving it just advances the state machine.
    await sleep(SIMULATION_SCAN_MS);

    // Phase 2 — acquisition + simulated template extraction/verify.
    const studentId = matchRegisteredStudent();
    if (studentId === null) {
      const err = new Error('No enrolled fingerprint template is on file for any student.');
      err.code = 'not-enrolled';
      throw err;
    }

    await sleep(SIMULATION_VERIFY_MS);

    if (Math.random() < SIMULATION_FAULT_RATE) {
      const err = new Error('Fingerprint did not match any registered template.');
      err.code = 'no-match';
      throw err;
    }

    return { studentId, templateId: 'simulated-template-' + studentId };
  }

  return {
    /** Acquire the fingerprint device. No-op in simulation. */
    async start() {
      device = { simulate: true };
      return device;
    },

    /** Release the fingerprint device. No-op in simulation. */
    async stop() {
      device = null;
    },

    /** Verify identity by fingerprint. See contract above. */
    scan,
  };
})();

// Expose for the kiosk page.
if (typeof window !== 'undefined') {
  window.FingerprintScanner = FingerprintScanner;
}