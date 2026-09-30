# TAGEX — O&M Site Visit Scheduler

The scheduler, tickets board and dashboard for the O&M base, behind the same login and the
same permission engine as the TAGEX delivery application.

## What changed, and why it matters

The version in `legacy/` asked every user to paste an Airtable Personal Access Token into
the page. That token was kept in `localStorage` and sent straight to `api.airtable.com` from
the browser. Anyone holding it had whatever access its creator had — in practice, full
director-level access to the whole base — and nothing recorded who did what.

This version has no Airtable token in the browser at all. One service token lives in a
Vercel environment variable, on the server. The browser holds only an HttpOnly session
cookie, and every read and write is re-checked against the signed-in user's role before it
reaches Airtable.

**Do not deploy anything in `legacy/`.** It is kept for reference only and is excluded from
the deployment bundle by `.vercelignore`.

## One account, two apps

This deployment shares the **same identity base, the same user records and the same four
roles** as the delivery app. A person who can already sign in there can sign in here with
the same email and password — there is nothing extra to create.

Sessions are per-domain, because cookies are, so signing in to one app does not sign you in
to the other. That is a browser rule, not a design choice.

Users are created and disabled in one place: the delivery app's **Admin → Users** screen, or
`node scripts/manage-users.js`. Doing it there takes effect here too.

## Roles

| Role | What they see here |
|---|---|
| Admin | Everything, all records |
| Ops / PM | Everything, all records |
| Technician | Their own visits and job cards only — scope is injected server-side |
| Warehouse | No access. They get a plain "no access" panel, not an empty calendar |

A role without `site_visits` is refused by the server whatever the page decides to render.
The client-side check in `public/js/boot.js` exists only so the refusal is explained rather
than silent.

## Layout

```
api/
  at.js          the Airtable proxy — the only route that talks to Airtable
  auth.js        router: login, logout, me, invite, reset, change-password, mfa
  _lib/          tables whitelist, permission engine, session, crypto, audit
  _auth/         one file per auth action (underscore = not a Vercel function)
public/
  index.html     login gate + scheduler shell, zero inline handlers
  css/           app.css (chrome) · scheduler.css (scoped to .mod-scheduler)
  js/            core.js · login.js · mod-scheduler.js · boot.js
scripts/         check-config.js · dev-server.js · manage-users.js  (dev only)
test/            221 assertions across three suites                 (dev only)
legacy/          the pre-security original — never deploy
```

Only `api/at.js` and `api/auth.js` count against Vercel's 12-function limit. Everything under
`api/_lib` and `api/_auth` is a plain import, which is why the auth actions live behind a
router instead of one file each.

## Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**, for Production,
Preview and Development.

| Variable | Value |
|---|---|
| `AIRTABLE_PAT` | The service token. Same one as the delivery app — it already reaches all three bases |
| `JWT_SECRET` | **A different value from the delivery app.** 48+ random bytes |
| `APP_ORIGIN` | `https://<this-project>.vercel.app` |
| `AUTH_MODE` | `session` |
| `SESSION_TTL_HOURS` | `12` |
| `IDLE_TIMEOUT_MINUTES` | `60` |
| `REQUIRE_ADMIN_MFA` | `false` (set `true` to require an authenticator app for Admins) |
| `FROM_EMAIL` | Sender for invite and reset mail |
| `RESEND_API_KEY` | Optional. Without it, invite links are printed to the server log instead of emailed |

Separate `JWT_SECRET` values mean a session cookie lifted from one deployment cannot be
replayed against the other.

## Running locally

```
node scripts/check-config.js
node scripts/dev-server.js 3210
```

Then open http://localhost:3210.

`scripts/dev-server.js` reads `.env.local`, which is git-ignored. Never put a real token in
`.env.example` — that file **is** committed.

There is deliberately no `npm run dev`. A `"dev": "vercel dev"` script makes `vercel dev`
invoke itself and the process recurses until it dies.

## Tests

```
node test/verify-part-b.js
node test/verify-part-c.js
node test/verify-field-ids.js
```

221 assertions covering the permission matrix, field-level read and write rules, record
scope formulas, export limits and field-ID translation. They run entirely offline against
`test/roles.fixture.json` and touch no live data.

## Deploying

```
vercel --prod
```

The project is already linked (`.vercel/project.json` → `tagex-merged-om-scheduler`).
