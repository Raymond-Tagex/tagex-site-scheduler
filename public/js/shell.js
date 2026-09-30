// TAGEX O&M — module shell.
//
// The deployment used to host exactly one module, so boot.js started the scheduler and there was
// no way to reach anything else. Site Information is a second module, so the shell owns the
// top-level switch between them.
//
// Modules are started LAZILY, the first time their tab is opened. Site Information reads two
// tables across two bases; someone who only ever looks at the calendar should not wait for that.
//
// Every permission decision here is cosmetic. A tab hidden from a role is a courtesy; the proxy
// re-checks each request against the role's Permissions JSON and refuses regardless.

(function () {
  'use strict';

  const TABS = [
    { key: 'scheduler', label: 'Scheduler', panel: 'modScheduler',
      requires: ['site_visits', 'view'], start: () => TX.scheduler && TX.scheduler.start() },
    { key: 'siteinfo', label: 'Site Information', panel: 'modSiteInfo',
      requires: ['site_information', 'view'], start: () => TX.siteinfo && TX.siteinfo.start() },
  ];

  const started = Object.create(null);
  let current = null;

  function available() {
    return TABS.filter((t) => TX.can(t.requires[0], t.requires[1]));
  }

  function show(key) {
    const tabs = available();
    const tab = tabs.find((t) => t.key === key) || tabs[0];
    if (!tab) return;

    for (const t of TABS) {
      const panel = document.getElementById(t.panel);
      if (panel) panel.hidden = t.key !== tab.key;
    }
    document.querySelectorAll('#shellTabs [data-shell-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.shellTab === tab.key);
      b.setAttribute('aria-selected', String(b.dataset.shellTab === tab.key));
    });

    current = tab.key;
    if (!started[tab.key]) {
      started[tab.key] = true;
      try { tab.start(); } catch (e) { console.error(e); }
    }
  }

  function paint() {
    const host = document.getElementById('shellTabs');
    if (!host) return;
    const tabs = available();

    // One module reachable means the switch is noise; hide the strip entirely. Logged, because
    // a missing tab is otherwise indistinguishable from a tab that was never built — which cost
    // a round of "where is the Site Information tab?" when a stale page was the real answer.
    host.hidden = tabs.length < 2;
    if (tabs.length < 2) {
      const missing = TABS.filter((t) => !TX.can(t.requires[0], t.requires[1]))
        .map((t) => t.label + ' (needs ' + t.requires.join(':') + ')');
      if (missing.length) {
        console.info('TAGEX shell: hiding the module strip. Not available to this role: '
          + missing.join(', ') + '. Reload if a module was added since this page loaded.');
      }
    }
    host.innerHTML = tabs.map((t) => (
      '<button type="button" role="tab" data-shell-tab="' + t.key + '">'
      + TX.esc(t.label) + '</button>'
    )).join('');
  }

  function start() {
    const me = TX.me();
    if (!me) return;
    const name = document.getElementById('hdrName');
    const role = document.getElementById('hdrRole');
    if (name) name.textContent = me.user.fullName || me.user.email;
    if (role) { role.textContent = me.role.name || ''; role.hidden = false; }

    const denied = document.getElementById('noAccess');
    const tabs = available();
    if (!tabs.length) {
      for (const t of TABS) {
        const p = document.getElementById(t.panel);
        if (p) p.hidden = true;
      }
      if (denied) denied.hidden = false;
      paint();
      return;
    }
    if (denied) denied.hidden = true;

    paint();
    TX.applyPermissionsToDom(document);
    show(current || tabs[0].key);
  }

  function stop() {
    for (const t of TABS) {
      const p = document.getElementById(t.panel);
      if (p) p.hidden = true;
    }
    const host = document.getElementById('shellTabs');
    if (host) { host.innerHTML = ''; host.hidden = true; }
    for (const k of Object.keys(started)) delete started[k];
    current = null;
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-shell-tab]');
    if (b) show(b.dataset.shellTab);
  });

  TX.shell = { show, start };
  TX.on('auth:ready', start);
  TX.on('auth:signedout', stop);
})();
