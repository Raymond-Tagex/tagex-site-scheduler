// File a generated form -- a job card or a ticket -- in Documents, against its job card.
//
// WHY. A job card or ticket raised in the scheduler gets its printed form built and kept on
// the record automatically, rather than only when somebody remembers to press Print.
// Neither Job Cards nor Tickets has an attachment field; Documents does, and links to the job
// card -- which is where the site gallery and Airtable already look for a job's paperwork. A
// ticket has no Documents link of its own, so its form is filed against its job card under
// the ticket's reference.
//
// WHAT IT ENFORCES, on the server, whatever the browser asked for:
//   - the role holds documents:create. Building the form is an export; keeping a copy of it is
//     a document write, and the two are separate rights.
//   - the copy's Sensitivity is within the role's own cap. A form carrying costs is filed
//     Confidential, and a role that may not see Confidential documents may not file one.
//   - one filed copy per name. A double-click, a retry or a second tab cannot pile up copies;
//     the second request is told it is already there. Nothing is ever deleted to make room.
//
// Document Type is "Other" because the field has no "Job Card" choice, and the API cannot add
// one. Adding "Job Card Form" / "Ticket Form" in Airtable and changing FORM_DOC_TYPE here is the
// whole change if the business wants them filtered separately.

'use strict';

const at = require('./airtable.js');
const T = require('./tables.js');
const P = require('./permissions.js');
const A = require('./audit.js');

const FORM_DOC_TYPE = 'Other';

/**
 * @param {object} o
 *   auth, base, ctx      the caller, the scheduler base and the audit context
 *   jobCardId            the job card the document hangs off
 *   name                 Document Name -- also the key that makes filing idempotent
 *   filename             the attachment's file name
 *   bytes                the PDF
 *   sensitivity          'Internal' | 'Confidential'
 *   notes                free text for the Notes field
 * @returns {Promise<{ok:boolean, reason?:string, detail?:string, documentId?:string}>}
 */
async function fileForm(o) {
  const { auth, base, ctx, jobCardId, name, filename, bytes, sensitivity, notes } = o;
  const actx = { ...ctx, module: 'documents' };

  if (!jobCardId) {
    return { ok: false, reason: 'no_job_card', detail: 'It has no job card to be filed against.' };
  }

  const allowed = P.can(auth.perms, 'documents', 'create');
  if (!allowed.ok) {
    await A.auditNow({ ...actx, action: 'Create', result: 'Denied', denialReason: allowed.reason,
      recordId: jobCardId, field: 'File', newValue: name });
    return { ok: false, reason: allowed.reason, detail: 'Your role may not add documents.' };
  }
  if (!T.sensitivityAllowed(sensitivity, allowed.rule.sensitivity_max)) {
    await A.auditNow({ ...actx, action: 'Create', result: 'Denied', denialReason: 'sensitivity',
      recordId: jobCardId, field: 'File', newValue: name + ' (' + sensitivity + ')' });
    return { ok: false, reason: 'sensitivity',
      detail: 'It carries ' + sensitivity + ' information, above what your role may file.' };
  }

  const docs = T.resolve(base, 'documents');
  if (!docs.ok) return { ok: false, reason: docs.reason, detail: docs.detail };

  // Already filed? Only a copy that actually holds a file and has not been retired counts --
  // a record left behind by a failed upload must not stop the next attempt.
  const existing = await at.findOne(docs.baseId, docs.tableId,
    `AND({Document Name} = ${P.lit(name)}, {Record Status} != 'Deleted', LEN({File} & '') > 0)`,
    ['Document Name']);
  if (existing) return { ok: false, reason: 'already_filed', documentId: existing.id,
    detail: 'It is already filed in the job card’s documents.' };

  const created = await at.create(docs.baseId, docs.tableId, [{
    'Document Name': name.slice(0, 200),
    'Document Type': FORM_DOC_TYPE,
    // Linked at creation rather than by a follow-up patch: a second write can fail on its own,
    // and an unlinked form is one nobody will find.
    'Job Card': [jobCardId],
    // "Uploaded By" is a collaborator field and cannot hold an app user, so the author goes
    // here -- the same convention siteinfo-upload.js follows.
    Notes: String(notes || '').slice(0, 500),
    Sensitivity: sensitivity,
  }]);
  const doc = (Array.isArray(created) ? created : (created.records || []))[0];
  if (!doc) throw new Error('The document record could not be created.');

  const { nameToId } = await at.fieldMaps(docs.baseId, docs.tableId);
  const fileFieldId = nameToId.File;
  let upErr = '';
  if (!fileFieldId) upErr = 'The Documents table has no File field.';
  else {
    const up = await fetch(
      `https://content.airtable.com/v0/${docs.baseId}/${doc.id}/${fileFieldId}/uploadAttachment`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_PAT, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: 'application/pdf', filename,
          file: Buffer.from(bytes).toString('base64') }),
      },
    );
    if (!up.ok) {
      const d = await up.json().catch(() => ({}));
      upErr = 'Airtable refused the attachment: '
        + String((d.error && (d.error.message || d.error.type)) || up.status);
    }
  }

  if (upErr) {
    // Retired, not deleted: a document with no file in it is noise in every list, but rule 10
    // stands -- the record stays, marked, and the next attempt is free to file a real copy.
    await at.update(docs.baseId, docs.tableId, doc.id, {
      'Record Status': 'Deleted',
      Notes: (String(notes || '') + ' — upload failed: ' + upErr).slice(0, 500),
    }).catch(() => {});
    await A.auditNow({ ...actx, action: 'Create', result: 'Denied', denialReason: 'upload_failed',
      recordId: doc.id, field: 'File', newValue: name });
    return { ok: false, reason: 'upload_failed', detail: upErr };
  }

  await A.auditNow({ ...actx, action: 'Create', result: 'Allowed', recordId: doc.id, field: 'File',
    newValue: name + ' → job card ' + jobCardId + ' (' + sensitivity + ')' });
  return { ok: true, documentId: doc.id };
}

/** What the browser is told: whether it was filed, and if not, why, in words. */
function filedSummary(r) {
  if (!r) return null;
  return { ok: !!r.ok, reason: r.reason || '', detail: r.detail || '', documentId: r.documentId || '' };
}

module.exports = { fileForm, filedSummary, FORM_DOC_TYPE };
