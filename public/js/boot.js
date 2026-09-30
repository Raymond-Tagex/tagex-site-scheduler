// TAGEX O&M — boot.
//
// This file used to start the scheduler directly, because the deployment hosted exactly one
// module. It now hosts two — the Scheduler and Site Information — so js/shell.js owns the
// top-level switch, the header, the no-access state and the lazy start of each module.
//
// Boot is kept as a separate file rather than folded into the shell so that the load order in
// index.html still reads as: platform (core, login) → modules → shell → boot. Anything that has
// to happen once, before or after the shell, belongs here.
//
// The permission checks in the shell are for the user's benefit only. The real control is
// server-side: every request to /api/at is re-checked against the role's Permissions JSON, so a
// role without site_visits or site_information is refused whatever the browser renders.

(function () {
  'use strict';

  // Nothing to do on its own account yet. The shell listens for auth:ready and auth:signedout
  // itself; duplicating those here would start each module twice.
  TX.on('auth:ready', () => {
    if (!TX.shell) console.error('shell.js did not load — no module can be shown.');
  });
})();
