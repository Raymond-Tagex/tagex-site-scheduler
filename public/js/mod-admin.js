// TAGEX — Admin module: users, role editor, audit log viewer.
//
// Rendered ONLY for a session whose role can manage users. Not hidden with CSS, not disabled —
// if the session is not an Admin the panel and its trigger are never inserted into the document.
// And it does not matter either way: every action here goes through /api/at, which re-checks
// permissions and enforces the lockout invariants in api/_lib/guards.js server-side.

(function () {
  'use strict';

  const $ = TX.$, $$ = TX.$$, esc = TX.esc;

  // Every module key the server knows, in the order the work actually happens: a picking slip
  // is raised, the warehouse signs it, a delivery note comes off it, and three signatures close
  // it. A key missing from this list has no checkbox, which used to mean a Save silently revoked
  // it -- see the carry-forward in the save handler.
  const MODULES = [
    'dashboard', 'job_cards', 'clients', 'documents', 'restricted_personal',
    'picking_slips', 'picking_slip_items',
    'delivery_notes', 'delivery_lines', 'signatures',
    'site_information', 'site_equipment',
    'stock_items', 'site_visits', 'activity_log',
    'costing', 'people', 'users', 'access_levels', 'audit_log', 'sessions', 'reports',
    'systems', 'contracts', 'slas', 'warranty_register', 'tickets',
    'error_criteria', 'second_hand_parts', 'support_requests', 'response_templates',
  ];
  const OPS = ['view', 'create', 'edit', 'delete', 'export'];
  const NOT_PROVISIONED = new Set([
    'systems', 'contracts', 'slas', 'warranty_register', 'tickets',
    'error_criteria', 'second_hand_parts', 'support_requests', 'response_templates',
  ]);

  let USERS = [], ROLES = [], AUDIT = [];
  let panel = null;
  let currentTab = 'users';

  // ── shell ────────────────────────────────────────────────────────────────

  function buildPanel() {
    panel = document.createElement('div');
    panel.className = 'admin-panel';
    panel.id = 'adminPanel';
    panel.hidden = true;
    panel.innerHTML =
      '<div class="admin-head">'
      + '<div class="admin-title">Administration</div>'
      + '<div class="admin-tabs">'
      + '<button class="admin-tab is-on" data-tab="users" type="button">Users</button>'
      + '<button class="admin-tab" data-tab="roles" type="button">Access levels</button>'
      + '<button class="admin-tab" data-tab="audit" type="button">Audit log</button>'
      + '</div>'
      + '<button class="admin-close" id="adminClose" type="button">✕ Close</button>'
      + '</div>'
      + '<div class="admin-body" id="adminBody"></div>';
    document.body.appendChild(panel);

    $('#adminClose').addEventListener('click', close);
    $$('.admin-tab', panel).forEach((b) => {
      b.addEventListener('click', () => {
        currentTab = b.dataset.tab;
        $$('.admin-tab', panel).forEach((x) => x.classList.toggle('is-on', x === b));
        renderTab();
      });
    });
  }

  function open() { panel.hidden = false; document.body.classList.add('gated'); renderTab(); }
  function close() { panel.hidden = true; document.body.classList.remove('gated'); }

  const body = () => $('#adminBody');
  const busy = (msg) => { body().innerHTML = '<div class="admin-empty">' + esc(msg || 'Loading…') + '</div>'; };
  const oops = (e) => { body().innerHTML = '<div class="admin-empty err">' + esc(TX.errorText(e)) + '</div>'; };

  function renderTab() {
    if (currentTab === 'users') return renderUsers();
    if (currentTab === 'roles') return renderRoles();
    return renderAudit();
  }

  // ── users ────────────────────────────────────────────────────────────────

  async function loadUsers() {
    const [u, r] = await Promise.all([
      TX.list('IAM', 'users', {
        fields: ['Email', 'Full Name', 'Status', 'Job Title / Department', 'Record Scope',
          'Last Login At', 'Can View Restricted Documents', 'MFA Enabled', 'Access Level',
          'Must Change Password', 'Approval Limit (R)', 'Integrity Check'],
        sort: [{ field: 'Email', direction: 'asc' }],
      }),
      TX.list('IAM', 'access_levels', { fields: ['Role Name', 'Active', 'Can Manage Users'] }),
    ]);
    USERS = u.records || [];
    ROLES = r.records || [];
  }

  const roleNameFor = (rec) => {
    const links = rec.fields['Access Level'];
    if (!Array.isArray(links) || !links.length) return '—';
    const role = ROLES.find((x) => x.id === links[0]);
    return role ? role.fields['Role Name'] : '—';
  };

  async function renderUsers() {
    busy('Loading users…');
    try { await loadUsers(); } catch (e) { return oops(e); }

    body().innerHTML =
      '<div class="admin-bar">'
      + '<input type="search" id="uSearch" placeholder="Search name, email or role…">'
      + '<select id="uStatus"><option value="">All statuses</option>'
      + ['Invited', 'Active', 'Suspended', 'Disabled'].map((s) => '<option>' + s + '</option>').join('')
      + '</select>'
      + '<button class="admin-btn primary" id="uInvite" type="button">+ Invite user</button>'
      + '</div>'
      + '<div id="uList"></div>';

    $('#uSearch').addEventListener('input', paintUsers);
    $('#uStatus').addEventListener('change', paintUsers);
    $('#uInvite').addEventListener('click', inviteDialog);
    paintUsers();
  }

  function paintUsers() {
    const q = ($('#uSearch').value || '').toLowerCase().trim();
    const status = $('#uStatus').value;
    const rows = USERS.filter((u) => {
      const f = u.fields;
      if (status && f.Status !== status) return false;
      if (!q) return true;
      return [f.Email, f['Full Name'], roleNameFor(u)].join(' ').toLowerCase().includes(q);
    });

    if (!rows.length) { $('#uList').innerHTML = '<div class="admin-empty">No users match.</div>'; return; }

    $('#uList').innerHTML = rows.map((u) => {
      const f = u.fields;
      const integrity = f['Integrity Check'];
      return '<div class="admin-row" data-id="' + u.id + '">'
        + '<div class="admin-row-main">'
        + '<div class="admin-row-name">' + esc(f['Full Name'] || '(no name)')
        + ' <span class="admin-pill ' + statusClass(f.Status) + '">' + esc(f.Status || '?') + '</span>'
        + (f['MFA Enabled'] ? ' <span class="admin-pill ok">MFA</span>' : '')
        + (f['Can View Restricted Documents'] ? ' <span class="admin-pill danger">FICA</span>' : '')
        + '</div>'
        + '<div class="admin-row-meta">' + esc(f.Email || '') + ' · ' + esc(roleNameFor(u))
        + ' · ' + esc(f['Record Scope'] || '—')
        + (f['Last Login At'] ? ' · last in ' + esc(String(f['Last Login At']).slice(0, 16).replace('T', ' ')) : ' · never signed in')
        + '</div>'
        + (integrity && integrity !== 'OK'
          ? '<div class="admin-row-warn">⚠ ' + esc(integrity) + '</div>' : '')
        + '</div>'
        + '<button class="admin-btn" data-act="edit" type="button">Manage</button>'
        + '</div>';
    }).join('');

    $$('#uList [data-act="edit"]').forEach((b) => {
      b.addEventListener('click', () => userDetail(b.closest('.admin-row').dataset.id));
    });
  }

  const statusClass = (s) => s === 'Active' ? 'ok' : s === 'Invited' ? 'warn' : 'danger';

  // ── user detail ──────────────────────────────────────────────────────────

  async function userDetail(id) {
    const u = USERS.find((x) => x.id === id);
    if (!u) return;
    const f = u.fields;
    const isSelf = String(f.Email || '').toLowerCase() === TX.userEmail();

    busy('Loading…');

    let sessions = [];
    let trail = [];
    try {
      const [s, a] = await Promise.all([
        TX.list('IAM', 'sessions', {
          fields: ['Session ID', 'User Email', 'Issued At', 'Last Seen', 'IP', 'Revoked'],
          filterByFormula: 'AND(LOWER({User Email}) = "' + fesc(String(f.Email).toLowerCase()) + '", NOT({Revoked}))',
        }),
        TX.list('IAM', 'audit_log', {
          fields: ['Event', 'Timestamp', 'Action', 'Module', 'Result', 'Denial Reason', 'IP Address'],
          filterByFormula: 'LOWER({User Email}) = "' + fesc(String(f.Email).toLowerCase()) + '"',
          sort: [{ field: 'Timestamp', direction: 'desc' }],
          pageSize: 25, maxRecords: 25,
        }),
      ]);
      sessions = s.records || [];
      trail = a.records || [];
    } catch (e) { /* detail still renders without them */ }

    body().innerHTML =
      '<button class="admin-btn" id="uBack" type="button">← All users</button>'
      + '<h2 class="admin-h2">' + esc(f['Full Name'] || f.Email) + '</h2>'
      + '<div class="admin-sub">' + esc(f.Email) + (isSelf ? ' · <strong>this is you</strong>' : '') + '</div>'
      + '<div id="uMsg"></div>'

      + '<div class="admin-grid">'
      + field('Access level', selectHtml('dRole', ROLES.filter((r) => r.fields.Active !== false)
          .map((r) => r.fields['Role Name']), roleNameFor(u)))
      + field('Status', selectHtml('dStatus', ['Invited', 'Active', 'Suspended', 'Disabled'], f.Status))
      + field('Record scope', selectHtml('dScope', ['All Records', 'Assigned Only', 'Own Records Only'], f['Record Scope']))
      + field('Approval limit (R)', '<input id="dLimit" type="number" step="0.01" value="' + esc(f['Approval Limit (R)'] || 0) + '">')
      + field('Assigned clients (one per line)', '<textarea id="dClients" rows="3">'
          + esc((TX.me() && parseList(f['Assigned Clients'])).join('\n')) + '</textarea>')
      + field('Assigned sites (one per line)', '<textarea id="dSites" rows="3">'
          + esc(parseList(f['Assigned Sites']).join('\n')) + '</textarea>')
      + '</div>'

      + '<label class="admin-check"><input type="checkbox" id="dRestricted"'
      + (f['Can View Restricted Documents'] ? ' checked' : '') + '>'
      + '<span>Can view restricted documents (FICA / personal data). Requires an admin role as well — '
      + 'this flag alone grants nothing, and every access is logged.</span></label>'

      + '<div class="admin-actions">'
      + '<button class="admin-btn primary" id="dSave" type="button">Save changes</button>'
      + '<button class="admin-btn" id="dForceReset" type="button">Force password reset</button>'
      + '<button class="admin-btn" id="dRevoke" type="button">Revoke sessions ('
      + sessions.length + ')</button>'
      + '<button class="admin-btn" id="dSetPw" type="button">Set a password</button>'
      + '</div>'
      + '<div id="dPwPanel" class="admin-panelbox" hidden>'
      + '<div class="admin-pwtitle">Set a password for ' + esc(f['Full Name'] || f.Email) + '</div>'
      + '<div class="admin-hint">Use this when email is not reaching them. Give the password to '
      + 'them directly &mdash; they are asked to change it at first sign-in, which retires your '
      + 'copy. All their current sessions are ended.</div>'
      + '<div class="admin-pwrow">'
      + '<input id="dPw" type="text" autocomplete="new-password" spellcheck="false" placeholder="New password">'
      + '<button type="button" class="admin-btn" id="dPwGen">Suggest one</button>'
      + '<button type="button" class="admin-btn primary" id="dPwSave">Set password</button>'
      + '</div>'
      + '<div id="dPwMsg"></div>'
      + '</div>'

      + '<h3 class="admin-h3">Recent activity</h3>'
      + (trail.length
        ? '<div class="admin-trail">' + trail.map((t) => {
            const tf = t.fields;
            return '<div class="admin-trail-row ' + (tf.Result === 'Denied' ? 'denied' : '') + '">'
              + '<span class="t">' + esc(String(tf.Timestamp || '').slice(0, 16).replace('T', ' ')) + '</span>'
              + '<span class="a">' + esc(tf.Action || '') + '</span>'
              + '<span class="m">' + esc(tf.Module || '') + '</span>'
              + '<span class="r">' + esc(tf.Result || '') + (tf['Denial Reason'] ? ' · ' + esc(tf['Denial Reason']) : '') + '</span>'
              + '</div>';
          }).join('') + '</div>'
        : '<div class="admin-empty">No activity recorded.</div>');

    $('#uBack').addEventListener('click', renderUsers);
    $('#dSave').addEventListener('click', () => saveUser(u));
    $('#dForceReset').addEventListener('click', () => forceReset(u));
    $('#dRevoke').addEventListener('click', () => revokeSessions(u, sessions));
    $('#dSetPw').addEventListener('click', () => {
      const box = $('#dPwPanel');
      box.hidden = !box.hidden;
      if (!box.hidden) $('#dPw').focus();
    });
    $('#dPwGen').addEventListener('click', () => { $('#dPw').value = suggestPassword(); });
    $('#dPwSave').addEventListener('click', async () => {
      const btn = $('#dPwSave');
      const out = $('#dPwMsg');
      btn.disabled = true; btn.textContent = 'Setting…';
      try {
        const r = await TX.auth.setPassword(String(f.Email || '').toLowerCase(), $('#dPw').value);
        out.innerHTML = '<div class="admin-msg ok">' + esc(r.message)
          + (r.sessionsRevoked ? ' ' + r.sessionsRevoked + ' open session'
             + (r.sessionsRevoked === 1 ? '' : 's') + ' ended.' : '')
          + '</div>';
        // The password stays on screen: the Admin still has to read it out.
      } catch (e) {
        out.innerHTML = '<div class="admin-msg err">' + esc(TX.errorText(e)) + '</div>';
      }
      btn.disabled = false; btn.textContent = 'Set password';
    });
  }

  const parseList = (raw) => {
    try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  const toList = (text) => String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const fesc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const field = (label, inner) =>
    '<div class="admin-field"><label>' + esc(label) + '</label>' + inner + '</div>';
  const selectHtml = (id, options, current) =>
    '<select id="' + id + '">' + options.map((o) =>
      '<option' + (o === current ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';

  function msg(kind, text) {
    $('#uMsg').innerHTML = '<div class="admin-msg ' + kind + '">' + esc(text) + '</div>';
  }

  async function saveUser(u) {
    const roleName = $('#dRole').value;
    const role = ROLES.find((r) => r.fields['Role Name'] === roleName);
    const fields = {
      Status: $('#dStatus').value,
      'Record Scope': $('#dScope').value,
      'Approval Limit (R)': parseFloat($('#dLimit').value) || 0,
      'Can View Restricted Documents': $('#dRestricted').checked,
      'Assigned Clients': JSON.stringify(toList($('#dClients').value)),
      'Assigned Sites': JSON.stringify(toList($('#dSites').value)),
    };
    if (role) fields['Access Level'] = [role.id];

    try {
      await TX.update('IAM', 'users', u.id, fields);
      msg('ok', 'Saved.');
      await loadUsers();
    } catch (e) {
      // The server refuses self-demotion and last-admin removal. Show exactly why.
      msg('err', TX.errorText(e));
    }
  }

  async function forceReset(u) {
    if (!confirm('Force ' + (u.fields.Email) + ' to set a new password at next sign-in?')) return;
    try {
      await TX.update('IAM', 'users', u.id, { 'Must Change Password': true });
      msg('ok', 'They will be asked to change their password next time they sign in.');
    } catch (e) { msg('err', TX.errorText(e)); }
  }

  async function revokeSessions(u, sessions) {
    if (!sessions.length) { msg('ok', 'No live sessions to revoke.'); return; }
    if (!confirm('Sign ' + u.fields.Email + ' out of ' + sessions.length + ' device(s)?')) return;
    let n = 0;
    for (const s of sessions) {
      try {
        await TX.update('IAM', 'sessions', s.id, {
          Revoked: true, 'Revoked By': TX.userEmail(), 'Revoked At': new Date().toISOString(),
        });
        n++;
      } catch (e) { /* keep going; report the total */ }
    }
    msg(n === sessions.length ? 'ok' : 'err', 'Revoked ' + n + ' of ' + sessions.length + ' session(s).');
  }

  // Builds a password that satisfies the server's rules first time, using crypto randomness
  // rather than Math.random. Grouped into readable blocks because someone has to say it out
  // loud over a phone; the ambiguous characters (O/0, l/1/I) are left out for the same reason.
  function suggestPassword() {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digit = '23456789';
    const pick = (set, n) => {
      const r = new Uint32Array(n);
      crypto.getRandomValues(r);
      return [...r].map((x) => set[x % set.length]).join('');
    };
    return `${pick(upper, 1)}${pick(lower, 3)}-${pick(lower, 4)}-${pick(lower, 3)}${pick(digit, 3)}`;
  }

  // ── invite ───────────────────────────────────────────────────────────────

  function inviteDialog() {
    body().innerHTML =
      '<button class="admin-btn" id="iBack" type="button">← All users</button>'
      + '<h2 class="admin-h2">Add a user</h2>'
      + '<div class="admin-sub">Two ways in. Emailing a link is the better one when mail is working '
      + '&mdash; the password is then known only to them. Setting one yourself is for when it is not.</div>'
      + '<div id="uMsg"></div>'
      + '<div class="admin-grid">'
      + field('Email', '<input id="iEmail" type="email" autocomplete="off" spellcheck="false">')
      + field('Full name', '<input id="iName" type="text">')
      + field('Access level', selectHtml('iRole', ROLES.filter((r) => r.fields.Active !== false)
          .map((r) => r.fields['Role Name']), 'Warehouse / Stores'))
      + field('Job title / department', '<input id="iJob" type="text">')
      + field('Mobile number', '<input id="iMobile" type="tel">')
      + field('Record scope', selectHtml('iScope', ['All Records', 'Assigned Only', 'Own Records Only'], 'All Records'))
      + '</div>'
      + '<div class="admin-choice">'
      + '<label><input type="radio" name="iHow" value="email" checked> '
      + '<strong>Email them a link</strong><span>They choose their own password. Valid 72 hours.</span></label>'
      + '<label><input type="radio" name="iHow" value="password"> '
      + '<strong>Set a password now</strong><span>For when email is not working. Give it to them '
      + 'directly &mdash; they must change it at first sign-in.</span></label>'
      + '</div>'
      + '<div id="iPwWrap" hidden>'
      + field('Initial password', '<input id="iPw" type="text" autocomplete="new-password" spellcheck="false">'
        + '<div class="admin-hint">At least 12 characters, with an uppercase letter, a lowercase letter '
        + 'and a digit. Shown as you type so you can read it out accurately. '
        + '<button type="button" class="admin-link" id="iPwGen">Suggest one</button></div>')
      + '</div>'
      + '<div class="admin-actions"><button class="admin-btn primary" id="iSend" type="button">Send invitation</button></div>';

    $('#iBack').addEventListener('click', renderUsers);

    const howEmail = () => $$('input[name="iHow"]').find((r) => r.checked).value === 'email';
    function paintHow() {
      $('#iPwWrap').hidden = howEmail();
      $('#iSend').textContent = howEmail() ? 'Send invitation' : 'Create account';
    }
    $$('input[name="iHow"]').forEach((r) => r.addEventListener('change', paintHow));
    $('#iPwGen').addEventListener('click', () => { $('#iPw').value = suggestPassword(); });
    paintHow();

    $('#iSend').addEventListener('click', async () => {
      const btn = $('#iSend');
      const withPw = !howEmail();
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = withPw ? 'Creating…' : 'Sending…';
      try {
        const payload = {
          email: $('#iEmail').value.trim().toLowerCase(),
          fullName: $('#iName').value.trim(),
          roleName: $('#iRole').value,
          jobTitle: $('#iJob').value.trim(),
          mobile: $('#iMobile').value.trim(),
          recordScope: $('#iScope').value,
        };
        if (withPw) payload.initialPassword = $('#iPw').value;

        const r = await TX.auth.invite(payload);
        if (r.passwordSet) {
          msg('ok', r.message);
          // Deliberately not cleared: the Admin still has to read it out.
        } else {
          msg(r.emailSent ? 'ok' : 'err',
            r.emailSent ? 'Invitation sent. It expires in 72 hours.' : (r.warning || 'Created, but the email failed.'));
          if (r.emailSent) setTimeout(renderUsers, 1400);
        }
      } catch (e) {
        msg('err', TX.errorText(e));
      }
      btn.disabled = false; btn.textContent = label;
    });
  }

  // ── role editor ──────────────────────────────────────────────────────────

  async function renderRoles() {
    busy('Loading access levels…');
    let roles;
    try {
      const r = await TX.list('IAM', 'access_levels', {
        fields: ['Role Name', 'Description', 'Permissions', 'Default Record Scope', 'Active',
          'Can View Restricted Documents', 'Can Delete Records', 'Can Export Data',
          'Can Manage Users', 'Can Edit Permissions', 'Approval Limit (R)'],
        sort: [{ field: 'Role Name', direction: 'asc' }],
      });
      roles = r.records || [];
      ROLES = roles;
    } catch (e) { return oops(e); }

    body().innerHTML =
      '<div class="admin-sub">Ticking a box writes the role\'s Permissions JSON, which the server '
      + 'reads on every request. A module with nothing ticked is denied outright.</div>'
      + '<div class="admin-bar"><select id="rPick">'
      + roles.map((r) => '<option value="' + r.id + '">' + esc(r.fields['Role Name']) + '</option>').join('')
      + '</select></div><div id="rEditor"></div>';

    $('#rPick').addEventListener('change', () => paintRole($('#rPick').value, roles));
    paintRole(roles[0] && roles[0].id, roles);
  }

  function paintRole(roleId, roles) {
    const role = roles.find((r) => r.id === roleId);
    if (!role) return;
    let perms = {};
    try { perms = JSON.parse(role.fields.Permissions || '{}'); } catch { perms = {}; }

    const grid = '<table class="admin-matrix"><thead><tr><th>Module</th>'
      + OPS.map((o) => '<th>' + o[0].toUpperCase() + o.slice(1) + '</th>').join('')
      + '</tr></thead><tbody>'
      + MODULES.map((m) => {
        const rule = perms[m] || {};
        const unprov = NOT_PROVISIONED.has(m);
        return '<tr' + (unprov ? ' class="unprov"' : '') + '><td>' + esc(m)
          + (unprov ? ' <span class="admin-pill">no table yet</span>' : '') + '</td>'
          + OPS.map((o) =>
            '<td><input type="checkbox" data-m="' + m + '" data-o="' + o + '"'
            + (rule[o] === true ? ' checked' : '') + '></td>').join('')
          + '</tr>';
      }).join('')
      + '</tbody></table>';

    $('#rEditor').innerHTML =
      '<div class="admin-msg warn">' + esc(role.fields.Description || '') + '</div>'
      + grid
      + '<div id="rSummary" class="admin-summary"></div>'
      + '<div class="admin-actions">'
      + '<button class="admin-btn primary" id="rSave" type="button">Save permissions</button>'
      + '</div><div id="uMsg"></div>';

    const recompute = () => {
      const granted = {};
      $$('#rEditor input[type=checkbox]').forEach((cb) => {
        if (!cb.checked) return;
        (granted[cb.dataset.m] = granted[cb.dataset.m] || []).push(cb.dataset.o);
      });
      const keys = Object.keys(granted);
      // A live "what this role can do" summary, so an Admin cannot misconfigure blind.
      $('#rSummary').innerHTML = keys.length
        ? '<strong>This role can:</strong><ul>' + keys.map((k) =>
            '<li>' + esc(k) + ' — ' + granted[k].join(', ')
            + (NOT_PROVISIONED.has(k) ? ' <em>(no table yet; denied until built)</em>' : '') + '</li>').join('') + '</ul>'
        : '<strong>This role can do nothing.</strong> Every module is denied.';
    };
    $$('#rEditor input[type=checkbox]').forEach((cb) => cb.addEventListener('change', recompute));
    recompute();

    $('#rSave').addEventListener('click', async () => {
      const next = {};
      $$('#rEditor input[type=checkbox]').forEach((cb) => {
        const m = cb.dataset.m, o = cb.dataset.o;
        if (!cb.checked) return;
        next[m] = next[m] || Object.assign({}, perms[m] || {});
        next[m][o] = true;
      });
      // Preserve field rules and sensitivity caps that the grid does not express.
      for (const [m, rule] of Object.entries(next)) {
        const old = perms[m] || {};
        if (old.fields) rule.fields = old.fields;
        if (old.sensitivity_max) rule.sensitivity_max = old.sensitivity_max;
        if (old.export_sensitivity_max) rule.export_sensitivity_max = old.export_sensitivity_max;
        if (old.scope) rule.scope = old.scope;
        for (const flag of ['require_user_flag', 'audit_every_read', 'list_view']) {
          if (flag in old) rule[flag] = old[flag];
        }
        for (const o of OPS) if (!(o in rule)) rule[o] = false;
      }
      // Carry forward any module this grid does not render. The editor rebuilds Permissions
      // from its checkboxes alone, so a key with no checkbox was being dropped on every save --
      // which, under deny-by-default, revoked it. This app shares the Identity & Access base
      // with the delivery application, so a save here could revoke ITS modules.
      const rendered = new Set(MODULES);
      for (const [m, rule] of Object.entries(perms)) {
        if (!rendered.has(m) && !(m in next)) next[m] = rule;
      }

      try {
        await TX.update('IAM', 'access_levels', role.id, {
          Permissions: JSON.stringify(next, null, 1),
          'Last Modified By': TX.userEmail(),
          'Last Modified Date': new Date().toISOString(),
        });
        msg('ok', 'Permissions saved. Sessions pick this up within a minute.');
      } catch (e) { msg('err', TX.errorText(e)); }
    });
  }

  // ── audit log ────────────────────────────────────────────────────────────

  async function renderAudit() {
    body().innerHTML =
      '<div class="admin-bar">'
      + '<input type="search" id="aSearch" placeholder="Filter by user, module or reason…">'
      + '<select id="aResult"><option value="">All results</option><option>Allowed</option><option>Denied</option></select>'
      + '<select id="aAction"><option value="">All actions</option>'
      + ['Login', 'Login Failed', 'Logout', 'Password Reset', 'View', 'Create', 'Update', 'Delete',
         'Export', 'Print', 'Permission Change', 'Restricted Document Viewed']
        .map((a) => '<option>' + a + '</option>').join('')
      + '</select>'
      + '<button class="admin-btn" id="aRestricted" type="button">Restricted access only</button>'
      + '<button class="admin-btn" id="aReload" type="button">Reload</button>'
      + '<button class="admin-btn" id="aCsv" type="button">Export CSV</button>'
      + '</div><div id="aList"><div class="admin-empty">Loading…</div></div>';

    $('#aSearch').addEventListener('input', paintAudit);
    $('#aResult').addEventListener('change', paintAudit);
    $('#aAction').addEventListener('change', paintAudit);
    $('#aReload').addEventListener('click', () => loadAudit().then(paintAudit).catch(oops));
    $('#aRestricted').addEventListener('click', () => {
      $('#aAction').value = 'Restricted Document Viewed';
      paintAudit();
    });
    $('#aCsv').addEventListener('click', exportCsv);

    try { await loadAudit(); paintAudit(); } catch (e) { oops(e); }
  }

  async function loadAudit() {
    const r = await TX.list('IAM', 'audit_log', {
      fields: ['Event', 'Timestamp', 'User Email', 'Action', 'Module', 'Table', 'Record ID',
        'Field', 'Result', 'Denial Reason', 'IP Address', 'Session ID', 'Request Count', 'Aggregated'],
      sort: [{ field: 'Timestamp', direction: 'desc' }],
      pageSize: 100, maxRecords: 500,
    });
    AUDIT = r.records || [];
  }

  function filteredAudit() {
    const q = ($('#aSearch').value || '').toLowerCase().trim();
    const result = $('#aResult').value;
    const action = $('#aAction').value;
    return AUDIT.filter((a) => {
      const f = a.fields;
      if (result && f.Result !== result) return false;
      if (action && f.Action !== action) return false;
      if (!q) return true;
      return [f['User Email'], f.Module, f['Denial Reason'], f.Table, f['IP Address']]
        .join(' ').toLowerCase().includes(q);
    });
  }

  function paintAudit() {
    const rows = filteredAudit();
    if (!rows.length) { $('#aList').innerHTML = '<div class="admin-empty">Nothing matches.</div>'; return; }
    $('#aList').innerHTML = '<div class="admin-sub">' + rows.length + ' entries</div>'
      + rows.map((a) => {
        const f = a.fields;
        const denied = f.Result === 'Denied';
        const restricted = f.Action === 'Restricted Document Viewed';
        return '<div class="admin-trail-row ' + (denied ? 'denied' : '') + (restricted ? ' restricted' : '') + '">'
          + '<span class="t">' + esc(String(f.Timestamp || '').slice(0, 16).replace('T', ' ')) + '</span>'
          + '<span class="u">' + esc(f['User Email'] || '—') + '</span>'
          + '<span class="a">' + esc(f.Action || '') + '</span>'
          + '<span class="m">' + esc(f.Module || '') + (f.Field ? ' · ' + esc(f.Field) : '') + '</span>'
          + '<span class="r">' + esc(f.Result || '')
          + (f['Denial Reason'] ? ' · ' + esc(f['Denial Reason']) : '')
          + (f.Aggregated ? ' · ×' + esc(f['Request Count'] || 1) : '') + '</span>'
          + '</div>';
      }).join('');
  }

  function exportCsv() {
    const rows = filteredAudit();
    const cols = ['Timestamp', 'User Email', 'Action', 'Module', 'Table', 'Record ID', 'Field',
      'Result', 'Denial Reason', 'IP Address', 'Session ID', 'Request Count'];
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = [cols.join(',')]
      .concat(rows.map((r) => cols.map((c) => q(r.fields[c])).join(',')))
      .join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tagex-audit-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  TX.on('auth:ready', () => {
    const me = TX.me();
    if (!me || !me.role || !me.role.canManageUsers) return;   // not rendered at all
    if (!panel) buildPanel();

    if (!$('#btnAdmin')) {
      const btn = document.createElement('button');
      btn.className = 'hdr-disconnect';
      btn.id = 'btnAdmin';
      btn.type = 'button';
      btn.textContent = 'Admin';
      btn.addEventListener('click', open);
      const logout = $('#btnLogout');
      logout.parentNode.insertBefore(btn, logout);
    }
  });

  TX.on('auth:signedout', () => {
    if (panel) { panel.remove(); panel = null; }
    const b = $('#btnAdmin');
    if (b) b.remove();
  });
})();
