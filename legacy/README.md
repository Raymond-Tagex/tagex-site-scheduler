# Legacy — the pre-security application

**Do not deploy anything in this folder.**

`index-pat-original.html` is the single-file app as it was before the access-control work. It:

- asked each user to paste an Airtable Personal Access Token into a gate screen
- kept that token in `localStorage` as `tagex_pat`
- sent it from the browser straight to `api.airtable.com`, seven call sites in all
- identified the user by a `prompt()` box whose answer was stored as `tagex_user` and written
  to `Created By` on every site visit

It has no access control of any kind. Anyone holding the token could read and write every
record in the O&M base.

Kept only so the port can be audited or compared. `.vercelignore` excludes this folder, and
`vercel.json` serves `public/` — but if you ever change either, make sure this stays
unreachable.

The zips are the original distribution archives, same content.
