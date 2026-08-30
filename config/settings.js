/**
 * settings.js
 *
 * Thin loader around the shared settings.json — the actual single source
 * of truth, also read directly by the Python backend (backend/analyze.py).
 * Keep new constants in settings.json, not here, so both sides stay in sync.
 */

const raw = require('./settings.json');

const settings = Object.assign({}, raw);

// UMD-lite: usable both as a CommonJS module (Node/Electron main process)
// and as a plain browser <script> global, since the renderer runs with
// nodeIntegration disabled and has no require().
if (typeof module !== 'undefined' && module.exports) {
  module.exports = settings;
}
if (typeof window !== 'undefined') {
  window.APP_SETTINGS = settings;
}
