// TAGEX — core: the single path to data, plus permission helpers for rendering.
//
// There is no Airtable token in this file, or anywhere else in the browser. Every request
// carries the HttpOnly session cookie and nothing else.
//
// PERMISSION HELPERS ARE COSMETIC. can() and canField() decide what to RENDER. The server
// re-checks every request in api/at.js and is the only thing that actually grants anything.

(function (global) {
  'use strict';

  const TX = {};

  // ── session state, populated by /api/auth/me ─────────────────────────────
  let ME = null;

  TX.me = () => ME;
  TX.isSignedIn = () => !!ME;

  // ── event bus ────────────────────────────────────────────────────────────
  const listeners = {};
  TX.on = (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); };
  TX.emit = (evt, payload) => { (listeners[evt] || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } }); };

  // ── unsaved work guard ───────────────────────────────────────────────────
  // A 401 mid-session must not silently discard a half-captured delivery note.
  let unsavedCheck = () => false;
  TX.setUnsavedCheck = (fn) => { unsavedCheck = typeof fn === 'function' ? fn : () => false; };
  TX.hasUnsavedWork = () => { try { return !!unsavedCheck(); } catch { return false; } };

  // ── low-level fetch ──────────────────────────────────────────────────────

  class ApiError extends Error {
    constructor(status, payload) {
      super((payload && payload.detail) || `HTTP ${status}`);
      this.name = 'ApiError';
      this.status = status;
      this.reason = (payload && payload.reason) || 'error';
      this.fields = (payload && payload.fields) || null;
      this.payload = payload || {};
    }
  }
  TX.ApiError = ApiError;

  async function request(path, body, opts = {}) {
    let res;
    try {
      res = await fetch(path, {
        method: opts.method || 'POST',
        credentials: 'include',           // the session cookie, and nothing else
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (networkErr) {
      throw new ApiError(0, { reason: 'network', detail: 'No connection. Check the network and try again.' });
    }

    let payload = null;
    const text = await res.text();
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { detail: text }; }

    if (res.status === 401) {
      // Session gone. Drop to the login screen, warning first if work would be lost.
      ME = null;
      TX.emit('session:expired', {
        reason: (payload && payload.reason) || 'no_session',
        detail: (payload && payload.detail) || 'Your session has ended.',
        hasUnsavedWork: TX.hasUnsavedWork(),
      });
      throw new ApiError(401, payload);
    }

    if (!res.ok) throw new ApiError(res.status, payload);
    return payload;
  }

  TX.request = request;

  // ── the one data helper ──────────────────────────────────────────────────
  // No module reaches the Airtable REST host directly. Everything goes through /api/at, so a
  // grep of public/ for that hostname returns nothing at all.

  /**
   * @param {object} q { op, base, table, sub?, recordId?, fields?, params? }
   * @returns {Promise<{records: Array<{id,fields}>}>}
   */
  TX.api = (q) => request('/api/at', q);

  TX.list = (base, table, params, extra = {}) =>
    TX.api({ op: 'list', base, table, params: params || {}, ...extra });
  TX.get = (base, table, recordId, extra = {}) =>
    TX.api({ op: 'get', base, table, recordId, ...extra });
  TX.create = (base, table, fields, extra = {}) =>
    TX.api({ op: 'create', base, table, fields, ...extra });
  TX.update = (base, table, recordId, fields, extra = {}) =>
    TX.api({ op: 'update', base, table, recordId, fields, ...extra });
  TX.remove = (base, table, recordId, extra = {}) =>
    TX.api({ op: 'delete', base, table, recordId, ...extra });

  /** Create many records; the proxy takes one at a time, so batch here. */
  TX.createMany = async (base, table, fieldsArray) => {
    const out = [];
    for (const fields of fieldsArray) {
      const r = await TX.create(base, table, fields);
      out.push(...(r.records || []));
    }
    return out;
  };

  // ── auth ─────────────────────────────────────────────────────────────────

  TX.auth = {
    login: (email, password, mfaCode, remember) =>
      request('/api/auth/login', { email, password, mfaCode, remember }),
    logout: () => request('/api/auth/logout', {}),
    me: () => request('/api/auth/me', undefined, { method: 'GET' }),
    forgotPassword: (email) => request('/api/auth/forgot-password', { email }),
    resetPassword: (token, password) => request('/api/auth/reset-password', { token, password }),
    acceptInvite: (token, password) => request('/api/auth/accept-invite', { token, password }),
    changePassword: (currentPassword, newPassword) =>
      request('/api/auth/change-password', { currentPassword, newPassword }),
    mfa: (action, extra = {}) => request('/api/auth/mfa', { action, ...extra }),
    invite: (payload) => request('/api/auth/invite', payload),
    // Admin only: put a working password on an existing account when email is not an option.
    setPassword: (email, password) => request('/api/auth/set-password', { email, password }),
  };

  TX.dn = { reserve: (current) => request('/api/dn/reserve', { current }) };
  // Picking slip numbers are reserved the same way, and for the same reason: a number issued
  // from a partial scan is a duplicate waiting to happen.
  TX.ps = { reserve: () => request('/api/ps/reserve', {}) };

  /** Load the session. Returns null when not signed in, rather than throwing. */
  TX.loadSession = async () => {
    try {
      const r = await TX.auth.me();
      ME = r;
      TX.emit('session:loaded', ME);
      return ME;
    } catch (e) {
      ME = null;
      if (e.status === 401) return null;
      throw e;
    }
  };

  TX.clearSession = () => { ME = null; };

  // ── permission helpers (rendering only) ──────────────────────────────────

  function moduleRule(moduleKey) {
    return ME && ME.modules ? ME.modules[moduleKey] : null;
  }

  /** can('delivery_notes', 'create') */
  TX.can = (moduleKey, op) => {
    const m = moduleRule(moduleKey);
    if (!m) return false;
    if (m.provisioned === false) return false;
    return m[op] === true;
  };

  /** canField('delivery_lines', 'Unit Cost', 'read') */
  TX.canField = (moduleKey, field, mode) => {
    const m = moduleRule(moduleKey);
    if (!m) return false;
    const f = m.fields || {};
    if (mode === 'read') {
      if (!m.view) return false;
      return !(f.deny_read || []).includes(field);
    }
    if (!m.edit && !m.create) return false;
    if ((f.deny_write || []).includes(field)) return false;
    if (Array.isArray(f.allow_write)) return f.allow_write.includes(field);
    return true;
  };

  /** scopeOf('job_cards') -> 'All Records' | 'Assigned Only' | 'Own Records Only' */
  TX.scopeOf = (moduleKey) => {
    const m = moduleRule(moduleKey);
    return (m && m.scope) || (ME && ME.user && ME.user.recordScope) || 'All Records';
  };

  TX.roleName = () => (ME && ME.role && ME.role.name) || '';
  TX.userEmail = () => (ME && ME.user && ME.user.email) || '';
  TX.userName = () => (ME && ME.user && ME.user.fullName) || '';

  // ── DOM helpers ──────────────────────────────────────────────────────────
  // Nav items, buttons and fields a role cannot use are NOT RENDERED — not disabled, not
  // hidden with CSS. removeIfDenied takes them out of the document entirely.

  TX.$ = (sel, root) => (root || document).querySelector(sel);
  TX.$$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /**
   * Remove every [data-requires="module:op"] element the session may not use.
   * Call after the session loads and after any render that adds such elements.
   */
  TX.applyPermissionsToDom = (root) => {
    TX.$$('[data-requires]', root).forEach((el) => {
      const spec = el.getAttribute('data-requires') || '';
      const [moduleKey, op] = spec.split(':');
      if (!moduleKey) return;
      if (!TX.can(moduleKey, op || 'view')) el.remove();
    });
    TX.$$('[data-requires-field]', root).forEach((el) => {
      const spec = el.getAttribute('data-requires-field') || '';
      const [moduleKey, field, mode] = spec.split(':');
      if (!moduleKey || !field) return;
      if (!TX.canField(moduleKey, field, mode || 'read')) el.remove();
    });
  };

  /** Escape untrusted text before it goes anywhere near innerHTML. */
  TX.esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** Human-readable message for an ApiError, for a status banner. */
  TX.errorText = (e) => {
    if (!e) return 'Something went wrong.';
    if (e.status === 403) {
      let msg = e.detail || e.message || 'Not permitted.';
      if (Array.isArray(e.fields) && e.fields.length) {
        msg += ` (${e.fields.map((f) => f.field).join(', ')})`;
      }
      return msg;
    }
    if (e.status === 429) return 'Too many requests. Wait a moment and try again.';
    if (e.status === 0) return 'No connection. Check the network and try again.';
    return e.detail || e.message || 'Something went wrong.';
  };

  // Registers the service worker, which is what makes the app installable to a phone's home
  // screen. Absolute path so it always takes the root scope, whatever URL served the page.
  // Failure is ignored on purpose: the app works without it, and an install-time error must
  // never stop someone signing in.
  if ('serviceWorker' in navigator) {
    global.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  global.TX = TX;
})(window);
