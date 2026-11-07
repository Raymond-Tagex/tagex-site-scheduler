// /api/client-register — the one client register (TAGEX Clients base), as this app sees it.
//
//   { op:'list',   base }                                  -> { clients:[…] }
//   { op:'ensure', base, clientId }                        -> { mirrorId, created }
//   { op:'create', base, name, contact?, mobile?, email?, sites? } -> { clientId, mirrorId }
//   { op:'update', base, clientId, contact?, mobile?, email?, sites? } -> { client }
//
// WHY AN ENDPOINT AND NOT THE PROXY. A job card or ticket can only link to a Clients row in its
// own base -- Airtable links do not cross bases -- so every base keeps a mirror of each client it
// uses, named by "Master Client ID" (CLAUDE.md, "One client register"). Choosing a client the
// base has no copy of means writing to two bases in step: the mirror, and the register's note of
// where its copies are. That is one operation, so it lives here, and the register base stays
// closed to /api/at: it is not in the TABLES whitelist at all (T.CLIENT_REGISTER), so the proxy
// cannot even resolve it, and the role editor has no switch that could open it.
//
// Governed by the role's 'clients' rule in the base named, exactly as /api/at would apply it:
// the account gates, field denies (a denied field is neither returned nor written), and record
// scope. A role scoped to assigned clients sees only the register clients whose copy in this
// base it could see through the proxy, and may not create clients at all -- a new client is
// assigned to nobody yet, so the scope cannot be honoured.
//
// Base: an operations base (CI, OM, RES); none named = OM.

'use strict';

const at = require('./_lib/airtable.js');
const S = require('./_lib/session.js');
const H = require('./_lib/http.js');
const A = require('./_lib/audit.js');
const T = require('./_lib/tables.js');
const P = require('./_lib/permissions.js');

const DETAILS = ['Contact Person', 'Mobile Number', 'Email', 'Sites'];
const LIMITS = { 'Client Name': 200, 'Contact Person': 200, 'Mobile Number': 40, 'Email': 200, 'Sites': 2000,
  'Phone': 40, 'Postal / Billing Address': 1000 };
const REC_RE = /^rec[A-Za-z0-9]{14}$/;
const REFUSED = Object.freeze({ refused: true });

const recIds = (v) => String(v || '').split(/,\s*/).map((s) => s.trim()).filter((s) => REC_RE.test(s));
const str = (v) => (v == null ? '' : String(v).trim());
/** The compared form of a name, as load-client-register.js compares them. */
const key = (s) => str(s).toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '');

/** Every row of a table, through the airtable helper. */
const listAll = (baseId, tableId, params) => at.list(baseId, tableId, params || {});

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, 'POST')) return;
  if (!H.sessionModeGuard(res)) return;

  let body;
  try { body = await H.readBody(req); } catch (e) { return H.fail(res, 400, e.code || 'bad_request', e.message); }

  // Symbols only, as at /api/at -- and before authentication, for the same reason. A record id
  // (clientId) is fine; a base or table id is not.
  const rawId = T.findRawIdInRequest({ ...body, clientId: undefined });
  if (rawId) return H.fail(res, 400, 'raw_id_rejected', 'This API accepts symbolic names only.');

  const op = String(body.op || '');
  if (!['list', 'ensure', 'create', 'update'].includes(op)) return H.fail(res, 400, 'unknown_op', 'op must be list, ensure, create or update.');
  const base = body.base == null || body.base === '' ? 'OM' : String(body.base);
  if (!T.OPS_BASES.includes(base)) return H.fail(res, 400, 'wrong_base', 'Clients are kept for C&I, O&M and RES.');

  const auth = await S.authenticate(req);
  const action = op === 'list' ? 'View' : op === 'update' ? 'Update' : 'Create';
  if (!auth.ok) {
    await A.auditNow({ action, result: 'Denied', denialReason: auth.reason, module: 'clients', baseSymbol: base,
      ip: S.clientIp(req), userAgent: S.userAgent(req), detail: auth.detail });
    return H.fail(res, auth.status, auth.reason, auth.detail);
  }
  const ctx = { userEmail: auth.email, userRecordId: auth.userRecordId, sessionId: auth.sid,
    ip: S.clientIp(req), userAgent: S.userAgent(req), module: 'clients', baseSymbol: base, table: 'client_register' };

  // The same account gates as /api/at, in the same order.
  if (auth.user['Must Change Password'] === true) {
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: 'password_change_required' });
    return H.fail(res, 403, 'password_change_required', 'You must set a new password before continuing.');
  }
  if (S.mustEnrolMfa(auth.role, auth.user)) {
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: 'mfa_enrolment_required' });
    return H.fail(res, 403, 'mfa_enrolment_required', 'Two-factor authentication is mandatory for administrators.');
  }
  const rl = H.sessionRateLimit(auth.sid);
  if (!rl.ok) {
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: 'rate_limited' });
    return H.tooManyRequests(res, rl.retryAfter);
  }

  const view = P.can(auth.perms, 'clients', 'view');
  if (!view.ok) {
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: view.reason });
    return H.fail(res, view.status, view.reason, view.detail);
  }
  const rule = T.expandFieldRules(view.rule, 'clients', base);
  const scope = P.effectiveScope(auth.role, auth.user, rule);

  try {
    const mirror = T.resolve(base, 'clients');
    const R = T.CLIENT_REGISTER;
    const reg = { baseId: T.BASES[R.base], tableId: R.clients };
    const con = { baseId: T.BASES[R.base], tableId: R.contracts };
    if (!mirror.ok || !reg.baseId) throw new Error('The client register is not configured.');
    // Read side by side, not one after another: the three tables take about six seconds in a row,
    // which with sign-in and a cold start ran past the function's time limit -- and every ticket
    // and job card then said the register could not be read (Raymond, 30 Oct 2026, TKT-2026-0093).
    const [{ idToName: mirrorNames }, { idToName: regNames }] = await Promise.all([
      at.fieldMaps(mirror.baseId, mirror.tableId), at.fieldMaps(reg.baseId, reg.tableId)]);

    // The copies of each client in this base, as the role may see them: the proxy's own filter.
    const filter = P.buildReadFilter({ moduleKey: 'clients', baseSymbol: base, rule, scope, user: auth.user, clientFilter: null });
    // Site Information, for the pickers' search: a site's SUB / SOL number, name and address find
    // its client (Raymond, 3 Nov 2026). Read only for a role that may view sites, through that
    // module's own scope filter and field denies -- the search must not reveal a site the role
    // could not open. Read alongside the rest, not after it: see the timing note above.
    const siteView = op === 'list' ? P.can(auth.perms, 'site_information', 'view') : { ok: false };
    const site = siteView.ok ? T.resolve(base, 'site_information') : { ok: false };
    const siteRule = site.ok ? T.expandFieldRules(siteView.rule, 'site_information', base) : null;
    const siteFilter = site.ok ? P.buildReadFilter({ moduleKey: 'site_information', baseSymbol: base, rule: siteRule,
      scope: P.effectiveScope(auth.role, auth.user, siteRule), user: auth.user, clientFilter: null }) : null;
    const pl = { baseId: T.BASES[R.base], tableId: R.plants };
    const [rows, register, contractRows, siteRows, siteNames, plantRows] = await Promise.all([
      listAll(mirror.baseId, mirror.tableId, filter ? { filterByFormula: filter } : {}),
      listAll(reg.baseId, reg.tableId),
      op === 'list' ? listAll(con.baseId, con.tableId) : null,
      // A site read that fails costs the search its site terms, never the client list.
      site.ok ? listAll(site.baseId, site.tableId, siteFilter ? { filterByFormula: siteFilter } : {}).catch(() => []) : [],
      site.ok ? at.fieldMaps(site.baseId, site.tableId).then((m) => m.idToName).catch(() => ({})) : {},
      // SolaX plants (6 Nov 2026). A plant read that fails costs the plants, never the list.
      op === 'list' && pl.tableId ? listAll(pl.baseId, pl.tableId).catch(() => []) : [],
    ]);
    const byMaster = new Map();
    for (const r of rows) {
      const m = str(r.fields['Master Client ID']);
      if (m) byMaster.set(m, (byMaster.get(m) || []).concat(r.id));
    }
    const allRecords = scope === 'All Records' || !scope;

    if (op === 'list') return list();
    if (op === 'ensure') return ensure();
    if (op === 'update') return update();
    return create();

    // ── list ──────────────────────────────────────────────────────────────
    async function list() {
      const contracts = contractRows;
      const numbers = new Map();
      // What a ticket or job card shows about its contract: who funds it, when warranty started
      // (the 1st invoice date) and what was installed. Portfolio is the funder (PPA, Alpine,
      // PrefCap, TxE). The register holds no money, so nothing here is a figure the job card
      // money rule would strip.
      const details = new Map();
      for (const c of contracts) {
        if (str(c.fields.Status) === 'Inactive') continue;
        const d = {
          number: str(c.fields['Contract Number']), funder: str(c.fields.Portfolio),
          firstInvoice: str(c.fields['First Invoice Date']), system: str(c.fields['System Description']),
          kind: str(c.fields['Contract Kind']),
        };
        for (const id of [].concat(c.fields.Client || [])) {
          numbers.set(id, (numbers.get(id) || []).concat(d.number));
          details.set(id, (details.get(id) || []).concat(d));
        }
      }
      // Each visible site, keyed to its register client: through its Client link to a copy here,
      // or failing that by the Client Name it carries.
      const regOfMirror = new Map();
      for (const [mid, ids] of byMaster) for (const id of ids) regOfMirror.set(id, mid);
      const regOfName = new Map(register.map((m) => [key(m.fields['Client Name']), m.id]));
      const sitesOf = new Map();
      for (const s of siteRows) {
        const f = P.filterReadFields(siteRule, s.fields, siteNames);
        const owner = [].concat(f.Client || []).map((id) => regOfMirror.get(id)).find(Boolean)
          || regOfName.get(key(f['Client Name']));
        if (!owner) continue;
        const entry = { number: str(f['SUB / SOL Number']), name: str(f['Site Name']), address: str(f['Property Address']) };
        if (entry.number || entry.name || entry.address) sitesOf.set(owner, (sitesOf.get(owner) || []).concat(entry));
      }
      // A plant carries personal details under other names: its SolaX login is an email and its
      // location an address. Each is read as the client field it stands for, so a role denied
      // Email or Sites on clients is denied them here too.
      const plantsOf = new Map();
      for (const p of plantRows) {
        const v = P.filterReadFields(rule, { Email: p.fields['User Name'], Sites: p.fields.Location }, regNames);
        const entry = { name: str(p.fields['Plant Name']), type: str(p.fields['Plant Type']), user: str(v.Email),
          location: str(v.Sites), installer: str(p.fields['Installer / Distributor']), contract: str(p.fields['Contract Number']),
          status: str(p.fields['Status at Import']), imported: str(p.fields.Imported) };
        for (const id of [].concat(p.fields.Client || [])) plantsOf.set(id, (plantsOf.get(id) || []).concat(entry));
      }
      const out = [];
      for (const m of register) {
        const mirrors = byMaster.get(m.id) || [];
        // A scoped role sees a register client only through a copy it could see in this base.
        if (!allRecords && !mirrors.length) continue;
        const f = P.filterReadFields(rule, m.fields, regNames);
        out.push({
          id: m.id, name: str(f['Client Name']), status: str(f.Status) || 'Active',
          contact: str(f['Contact Person']), mobile: str(f['Mobile Number']), email: str(f.Email), sites: str(f.Sites),
          // From Palladium (3 Nov 2026): the customer code(s), billing address and phone.
          palladium: str(f['Palladium Code']), address: str(f['Postal / Billing Address']), phone: str(f.Phone),
          siteInfo: sitesOf.get(m.id) || [],
          plants: plantsOf.get(m.id) || [],
          contracts: (numbers.get(m.id) || []).filter(Boolean).sort(), mirrors,
          contractDetails: (details.get(m.id) || []).filter((d) => d.number)
            .sort((a, b) => a.number.localeCompare(b.number)),
        });
      }
      // A row added straight into this base and not adopted yet is still a client. Listed, so it
      // cannot vanish from the pickers; load-client-register.js adopts it into the register.
      const known = new Set(register.map((m) => m.id));
      for (const r of rows) {
        if (known.has(str(r.fields['Master Client ID']))) continue;
        const f = P.filterReadFields(rule, r.fields, mirrorNames);
        out.push({ id: '', name: str(f['Client Name']), status: 'Active', contact: str(f['Contact Person']),
          mobile: str(f['Mobile Number']), email: str(f.Email), sites: str(f.Sites), contracts: [], mirrors: [r.id], unregistered: true });
      }
      A.audit({ ...ctx, action: 'View', result: 'Allowed', detail: out.length + ' clients' });
      return H.ok(res, { clients: out });
    }

    // ── ensure: this base's copy of a register client ─────────────────────
    async function ensure() {
      const clientId = str(body.clientId);
      const m = REC_RE.test(clientId) && register.find((x) => x.id === clientId);
      if (!m) {
        await A.auditNow({ ...ctx, action: 'Create', result: 'Denied', denialReason: 'not_found', recordId: clientId.slice(0, 20) });
        return H.fail(res, 404, 'not_found', 'No such client in the register.');
      }
      const have = byMaster.get(m.id);
      if (have && have.length) return H.ok(res, { mirrorId: have[0], created: false });
      // A copy the role cannot see is not a reason to make a second one.
      const any = (await listAll(mirror.baseId, mirror.tableId, { filterByFormula: '{Master Client ID} = "' + m.id + '"' }));
      if (any.length) {
        await A.auditNow({ ...ctx, action: 'View', result: 'Denied', denialReason: 'scope_excluded', recordId: any[0].id });
        return H.fail(res, 403, 'scope_excluded', 'That client is outside your access.');
      }
      const made = await makeMirror(m.id, m.fields);
      if (made.fail) return made.fail;
      return H.ok(res, { mirrorId: made.id, created: true });
    }

    // ── update: a client's contact details, from the ticket or job card ────
    //
    // Raymond, 6 Nov 2026: most subscription clients reached the register with no phone, email or
    // address (the Palladium export held 26 of ~250), so staff fill them in where they meet the
    // gap. The register is written, and this base's copies with it, so the job card's own client
    // record agrees at once rather than at the next sync. Only these four fields; the name is not
    // editable here -- a rename touches every base and is the sync script's --names.
    async function update() {
      const clientId = str(body.clientId);
      const m = REC_RE.test(clientId) && register.find((x) => x.id === clientId);
      const deny = async (reason, status, detail) => {
        await A.auditNow({ ...ctx, action: 'Update', result: 'Denied', denialReason: reason, recordId: clientId.slice(0, 20) });
        return H.fail(res, status, reason, detail);
      };
      if (!m) return deny('not_found', 404, 'No such client in the register.');
      const e = P.can(auth.perms, 'clients', 'edit');
      if (!e.ok) return deny(e.reason, e.status, e.detail);
      // A scoped role edits only a client it can see a copy of here, as the proxy would let it.
      const copies = byMaster.get(m.id) || [];
      if (!allRecords && !copies.length) return deny('scope_excluded', 403, 'That client is outside your access.');
      const patch = {};
      const take = (k, f) => { if (Object.prototype.hasOwnProperty.call(body, k)) patch[f] = str(body[k]); };
      take('contact', 'Contact Person'); take('mobile', 'Mobile Number'); take('email', 'Email'); take('sites', 'Sites');
      if (!Object.keys(patch).length) return H.fail(res, 400, 'bad_request', 'Nothing to change.');
      for (const [k, v] of Object.entries(patch)) if (v.length > LIMITS[k]) return H.fail(res, 400, 'bad_request', k + ' is too long.');
      if (patch.Email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.Email)) return H.fail(res, 400, 'bad_request', 'That email address does not look right.');
      const wrule = T.expandFieldRules(e.rule, 'clients', base);
      const check = P.validateWriteFields(wrule, patch, regNames);
      if (!check.ok) return deny(check.reason, check.status || 403, check.detail);
      // Airtable takes an empty phone or email as "clear it"; '' would be refused for the email type.
      const out = {}; for (const [k, v] of Object.entries(patch)) out[k] = v === '' ? null : v;
      const before = {}; for (const k of Object.keys(patch)) before[k] = m.fields[k] == null ? '' : str(m.fields[k]);
      await at.update(reg.baseId, reg.tableId, m.id, out);
      await A.auditFieldChanges({ ...ctx, recordId: m.id, before, after: patch });
      // This base's copies, the same four fields where it has them (C&I has no Mobile Number).
      const has = new Set(Object.values(mirrorNames));
      const mp = {}; for (const [k, v] of Object.entries(out)) if (has.has(k)) mp[k] = v;
      if (Object.keys(mp).length) for (const id of copies) await at.update(mirror.baseId, mirror.tableId, id, mp);
      const f = P.filterReadFields(rule, { ...m.fields, ...patch }, regNames);
      return H.ok(res, { client: { id: m.id, contact: str(f['Contact Person']), mobile: str(f['Mobile Number']),
        email: str(f.Email), sites: str(f.Sites) } });
    }

    // ── create: a new client, in the register and this base ───────────────
    async function create() {
      const fields = { 'Client Name': str(body.name) };
      if (!fields['Client Name']) return H.fail(res, 400, 'bad_request', 'A client needs a name.');
      if (str(body.contact)) fields['Contact Person'] = str(body.contact);
      if (str(body.mobile)) fields['Mobile Number'] = str(body.mobile);
      if (str(body.email)) fields.Email = str(body.email);
      if (str(body.sites)) fields.Sites = str(body.sites);
      if (str(body.phone)) fields.Phone = str(body.phone);
      if (str(body.address)) fields['Postal / Billing Address'] = str(body.address);
      for (const [k, v] of Object.entries(fields)) {
        if (v.length > LIMITS[k]) return H.fail(res, 400, 'bad_request', k + ' is too long.');
      }
      if (fields.Email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.Email)) return H.fail(res, 400, 'bad_request', 'That email address does not look right.');
      // Somebody already in the register is chosen, not made again.
      const twin = register.find((x) => key(x.fields['Client Name']) === key(fields['Client Name']));
      if (twin) {
        return H.fail(res, 409, 'client_exists', 'A client of that name is already in the register.',
          { clientId: twin.id, name: str(twin.fields['Client Name']) });
      }
      const gate = await mayCreate(fields);
      if (gate) return gate;
      const [m] = await at.create(reg.baseId, reg.tableId, [{
        ...fields, Status: 'Active', Source: ['Entered here'], 'Use In': [base],
        ...(base === 'CI' ? { Segment: 'C&I' } : {}),
      }]);
      await A.auditNow({ ...ctx, action: 'Create', result: 'Allowed', recordId: m.id, field: 'Client Name', newValue: fields['Client Name'] + ' (register)' });
      const made = await makeMirror(m.id, m.fields);
      if (made.fail) return made.fail;
      return H.ok(res, { clientId: m.id, mirrorId: made.id });
    }

    /**
     * REFUSED (the refusal already sent) or null when this role may create this client here.
     * Not H.fail's return value: that is undefined, and a refusal that reads as "no objection"
     * once let a role without clients:create make clients -- verify-client-register.js.
     */
    async function mayCreate(fields) {
      const c = P.can(auth.perms, 'clients', 'create');
      const deny = async (reason, status, detail) => {
        await A.auditNow({ ...ctx, action: 'Create', result: 'Denied', denialReason: reason, field: 'Client Name', newValue: fields['Client Name'] });
        H.fail(res, status, reason, detail);
        return REFUSED;
      };
      if (!c.ok) return deny(c.reason, c.status, c.detail);
      if (!allRecords) return deny('scope_excluded', 403, 'Your access is limited to assigned clients, so you cannot add one.');
      const wrule = T.expandFieldRules(c.rule, 'clients', base);
      const check = P.validateWriteFields(wrule, { ...fields, 'Master Client ID': 'x' }, mirrorNames);
      if (!check.ok) return deny(check.reason, check.status || 403, check.detail);
      return null;
    }

    /** Make this base's copy, stamped, and note it in the register. */
    async function makeMirror(clientId, regFields) {
      const fields = { 'Client Name': str(regFields['Client Name']), 'Master Client ID': clientId };
      const mirrorHas = new Set(Object.values(mirrorNames));
      for (const d of DETAILS) if (mirrorHas.has(d) && str(regFields[d])) fields[d] = str(regFields[d]);
      const gate = await mayCreate(fields);
      if (gate) return { fail: gate };
      const [r] = await at.create(mirror.baseId, mirror.tableId, [fields]);
      const sym = base;
      const reread = register.find((x) => x.id === clientId);
      const was = reread ? reread.fields : regFields;
      await at.update(reg.baseId, reg.tableId, clientId, {
        [sym + ' Client Record']: recIds(was[sym + ' Client Record']).concat(r.id).join(', '),
        'Use In': [...new Set([].concat(was['Use In'] || []).concat(sym))],
      });
      await A.auditNow({ ...ctx, action: 'Create', result: 'Allowed', recordId: r.id, field: 'Master Client ID', newValue: clientId });
      return { id: r.id };
    }
  } catch (e) {
    // The audit row keeps only "error"; the reason goes to the function log, where it can be read
    // (30 Oct 2026: a token without access to the Clients base looked exactly like a slow read).
    console.error('[client-register]', op, base, e && e.status, String((e && e.message) || e).slice(0, 300));
    await A.auditNow({ ...ctx, action, result: 'Denied', denialReason: 'error', detail: String(e.message || e).slice(0, 200) });
    return H.fail(res, e.status || 502, 'register_unavailable', 'The client register could not be read. Try again.');
  }
};
