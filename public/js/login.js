// TAGEX — login screen, invite acceptance, password reset, MFA, forced password change.
//
// Nothing on this screen mentions Airtable. Users have no idea what is behind it.
// No credential is ever stored: no token, no PAT, no password, in any browser storage.

(function () {
  'use strict';

  const $ = TX.$;
  let pendingEmail = '';
  let pendingPassword = '';   // held in memory only, for the MFA second step; cleared on success

  const views = () => TX.$$('.gate-view');

  function show(viewId) {
    views().forEach((v) => { v.hidden = v.id !== viewId; });
    const first = $('#' + viewId + ' input:not([type=hidden]):not([disabled])');
    if (first) setTimeout(() => first.focus(), 40);
  }

  function setError(viewId, message) {
    const el = $('#' + viewId + ' .gate-err');
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function setNote(viewId, message, kind) {
    const el = $('#' + viewId + ' .gate-note');
    if (!el) return;
    if (!message) { el.hidden = true; return; }
    el.textContent = message;
    el.className = 'gate-note' + (kind ? ' ' + kind : '');
    el.hidden = false;
  }

  function busy(btn, on, labelWhenBusy) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.disabled = true;
      btn.textContent = labelWhenBusy || 'Please wait…';
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  function openGate() {
    $('#gate').hidden = false;
    document.body.classList.add('gated');
  }

  function closeGate() {
    $('#gate').hidden = true;
    document.body.classList.remove('gated');
    pendingPassword = '';
  }

  // ── sign in ──────────────────────────────────────────────────────────────

  async function doLogin(mfaCode) {
    const email = $('#loginEmail').value.trim().toLowerCase();
    const password = mfaCode ? pendingPassword : $('#loginPassword').value;
    const remember = $('#loginRemember').checked;
    const btn = mfaCode ? $('#mfaSubmit') : $('#loginSubmit');
    const view = mfaCode ? 'viewMfa' : 'viewLogin';

    if (!email || !password) { setError(view, 'Enter your email and password.'); return; }

    setError(view, '');
    busy(btn, true, 'Signing in…');

    try {
      const r = await TX.auth.login(email, password, mfaCode || null, remember);

      if (r.mfaRequired) {
        pendingEmail = email;
        pendingPassword = password;
        busy(btn, false);
        setError('viewMfa', '');
        $('#mfaCode').value = '';
        show('viewMfa');
        return;
      }

      pendingPassword = '';
      $('#loginPassword').value = '';

      if (r.mustChangePassword) {
        busy(btn, false);
        setNote('viewChange', 'Your password must be changed before you can continue.', 'warn');
        show('viewChange');
        return;
      }

      const me = await TX.loadSession();

      // Signed in, but the session could not be read back. Say so plainly instead of
      // silently bouncing to a dead login form.
      if (!me) {
        setError(view, 'Signed in, but the session could not be confirmed. Please try again.');
        return;
      }

      if (r.mustEnrolMfa) {
        await startMfaEnrolment();
        return;
      }

      closeGate();
      TX.emit('auth:ready');
    } catch (e) {
      if (e.status === 423) setError(view, e.detail);
      else if (e.reason === 'invalid_mfa') setError('viewMfa', 'That code is not valid. Try the next one your app shows.');
      else setError(view, TX.errorText(e));
    } finally {
      // Always. The old code reset the button on every branch EXCEPT plain success, so any
      // failure after the login call left it stuck on "Signing in…" with no way forward.
      busy(btn, false);
    }
  }

  // ── MFA enrolment (mandatory for Admin) ──────────────────────────────────

  async function startMfaEnrolment() {
    try {
      const r = await TX.auth.mfa('begin');
      $('#enrolSecret').textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
      const link = $('#enrolLink');
      link.href = r.otpauth;
      show('viewEnrol');
    } catch (e) {
      if (e.reason === 'mfa_already_enabled') { closeGate(); TX.emit('auth:ready'); return; }
      setError('viewEnrol', TX.errorText(e));
      show('viewEnrol');
    }
  }

  async function confirmMfaEnrolment() {
    const btn = $('#enrolSubmit');
    setError('viewEnrol', '');
    busy(btn, true, 'Checking…');
    try {
      await TX.auth.mfa('enable', { code: $('#enrolCode').value.trim() });
      await TX.loadSession();
      busy(btn, false);
      closeGate();
      TX.emit('auth:ready');
    } catch (e) {
      busy(btn, false);
      setError('viewEnrol', TX.errorText(e));
    }
  }

  // ── forgot password ──────────────────────────────────────────────────────

  async function doForgot() {
    const btn = $('#forgotSubmit');
    const email = $('#forgotEmail').value.trim().toLowerCase();
    setError('viewForgot', '');
    busy(btn, true, 'Sending…');
    try {
      const r = await TX.auth.forgotPassword(email);
      busy(btn, false);
      // Deliberately the same answer whether or not the address exists.
      setNote('viewForgot', r.message, 'ok');
      $('#forgotEmail').value = '';
    } catch (e) {
      busy(btn, false);
      setError('viewForgot', TX.errorText(e));
    }
  }

  // ── set password (invite acceptance and reset share this view) ───────────

  async function doSetPassword() {
    const btn = $('#setSubmit');
    const pw = $('#setPassword').value;
    const pw2 = $('#setPassword2').value;
    const token = $('#setToken').value;
    const mode = $('#setMode').value; // 'invite' | 'reset'

    setError('viewSet', '');
    if (pw !== pw2) { setError('viewSet', 'The two passwords do not match.'); return; }
    if (pw.length < 12) { setError('viewSet', 'Password must be at least 12 characters.'); return; }

    busy(btn, true, 'Saving…');
    try {
      if (mode === 'invite') await TX.auth.acceptInvite(token, pw);
      else await TX.auth.resetPassword(token, pw);
      busy(btn, false);
      // Strip the token from the address bar so it is not left in history or a screenshot.
      history.replaceState(null, '', location.pathname);
      setNote('viewLogin', 'Password set. Sign in with it now.', 'ok');
      show('viewLogin');
    } catch (e) {
      busy(btn, false);
      setError('viewSet', TX.errorText(e));
    }
  }

  // ── forced password change (Must Change Password) ────────────────────────

  async function doForcedChange() {
    const btn = $('#changeSubmit');
    const cur = $('#changeCurrent').value;
    const pw = $('#changeNew').value;
    const pw2 = $('#changeNew2').value;

    setError('viewChange', '');
    if (pw !== pw2) { setError('viewChange', 'The two passwords do not match.'); return; }

    busy(btn, true, 'Saving…');
    try {
      await TX.auth.changePassword(cur, pw);
      const me = await TX.loadSession();
      busy(btn, false);
      if (me && me.user && me.user.mustEnrolMfa) { await startMfaEnrolment(); return; }
      closeGate();
      TX.emit('auth:ready');
    } catch (e) {
      busy(btn, false);
      setError('viewChange', TX.errorText(e));
    }
  }

  // ── sign out ─────────────────────────────────────────────────────────────

  async function doLogout(force) {
    if (!force && TX.hasUnsavedWork() &&
        !confirm('You have an unsaved delivery. Sign out and discard it?')) return;
    try { await TX.auth.logout(); } catch { /* the cookie is cleared regardless */ }
    TX.clearSession();
    TX.emit('auth:signedout');
    $('#loginPassword').value = '';
    setError('viewLogin', '');
    setNote('viewLogin', '', '');
    show('viewLogin');
    openGate();
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  function wire() {
    $('#loginSubmit').addEventListener('click', () => doLogin(null));
    $('#loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(null); });
    $('#loginEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginPassword').focus(); });

    $('#mfaSubmit').addEventListener('click', () => doLogin($('#mfaCode').value.trim()));
    $('#mfaCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin($('#mfaCode').value.trim()); });
    $('#mfaBack').addEventListener('click', () => { pendingPassword = ''; show('viewLogin'); });

    $('#enrolSubmit').addEventListener('click', confirmMfaEnrolment);
    $('#enrolCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmMfaEnrolment(); });

    $('#forgotLink').addEventListener('click', (e) => {
      e.preventDefault();
      $('#forgotEmail').value = $('#loginEmail').value.trim();
      setNote('viewForgot', '', '');
      setError('viewForgot', '');
      show('viewForgot');
    });
    $('#forgotSubmit').addEventListener('click', doForgot);
    $('#forgotEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') doForgot(); });
    $('#forgotBack').addEventListener('click', () => show('viewLogin'));

    $('#setSubmit').addEventListener('click', doSetPassword);
    $('#setPassword2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSetPassword(); });

    $('#changeSubmit').addEventListener('click', doForcedChange);
    $('#changeNew2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doForcedChange(); });

    const out = $('#btnLogout');
    if (out) out.addEventListener('click', () => doLogout(false));

    // A 401 mid-session drops cleanly back to the login screen.
    TX.on('session:expired', (info) => {
      openGate();
      show('viewLogin');
      setNote('viewLogin',
        info.hasUnsavedWork
          ? 'Your session ended. Sign in again — your unsaved delivery is still on screen behind this.'
          : (info.detail || 'Your session ended. Please sign in again.'),
        info.hasUnsavedWork ? 'warn' : '');
    });
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  async function boot() {
    wire();

    // Clear any stale credential left by the retired PAT gate. Runs on every load, for
    // every returning browser, whether or not this session ever used the old model.
    try {
      sessionStorage.removeItem('tagex_dn_pat');
      localStorage.removeItem('tagex_dn_pat');
    } catch { /* private mode — nothing to clear */ }

    const qs = new URLSearchParams(location.search);
    const invite = qs.get('invite');
    const reset = qs.get('reset');

    if (invite || reset) {
      $('#setToken').value = invite || reset;
      $('#setMode').value = invite ? 'invite' : 'reset';
      $('#setHeading').textContent = invite ? 'Set your password' : 'Choose a new password';
      openGate();
      show('viewSet');
      return;
    }

    const me = await TX.loadSession();
    if (!me) { openGate(); show('viewLogin'); return; }

    if (me.user.mustChangePassword) { openGate(); show('viewChange'); return; }
    if (me.user.mustEnrolMfa) { openGate(); await startMfaEnrolment(); return; }

    closeGate();
    TX.emit('auth:ready');
  }

  TX.login = { boot, openGate, closeGate, show, doLogout };
  document.addEventListener('DOMContentLoaded', boot);
})();
