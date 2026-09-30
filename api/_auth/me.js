// GET /api/auth/me
//
// Returns the identity, role and resolved permissions the UI needs to decide what to render.
// The UI trusts this FOR DISPLAY ONLY — every request is re-checked by api/at.js. Anything
// this endpoint says is a hint about what will be allowed, never a grant.
//
// Password Hash, MFA Secret and Invite Token Hash are never included, for any role.

'use strict';

const S = require('../_lib/session.js');
const H = require('../_lib/http.js');
const P = require('../_lib/permissions.js');
const T = require('../_lib/tables.js');

module.exports = async function handler(req, res) {
  if (!H.methodGuard(req, res, ['GET', 'POST'])) return;
  if (!H.sessionModeGuard(res)) return;

  const auth = await S.authenticate(req);
  if (!auth.ok) return H.fail(res, auth.status, auth.reason, auth.detail);

  const role = auth.role;
  const isAdmin = role['Can Manage Users'] === true;
  const mfaEnabled = auth.user['MFA Enabled'] === true && !!auth.user['MFA Secret'];

  // Per-module summary for rendering. Includes provisioning state so the UI can distinguish
  // "you may not" from "this module does not exist yet" without probing the API for 403s.
  const modules = {};
  for (const [key, rule] of Object.entries(auth.perms)) {
    modules[key] = {
      view: rule.view === true,
      create: rule.create === true,
      edit: rule.edit === true,
      delete: rule.delete === true,
      export: rule.export === true,
      fields: {
        deny_read: (rule.fields && rule.fields.deny_read) || [],
        deny_write: (rule.fields && rule.fields.deny_write) || [],
        ...(rule.fields && rule.fields.allow_write ? { allow_write: rule.fields.allow_write } : {}),
      },
      ...(rule.sensitivity_max ? { sensitivity_max: rule.sensitivity_max } : {}),
      ...(rule.export_sensitivity_max ? { export_sensitivity_max: rule.export_sensitivity_max } : {}),
      provisioned: !T.NOT_PROVISIONED.has(key),
      scope: P.effectiveScope(role, auth.user, rule),
    };
  }

  return H.ok(res, {
    user: {
      email: auth.email,
      fullName: auth.user['Full Name'] || '',
      jobTitle: auth.user['Job Title / Department'] || '',
      mobile: auth.user['Mobile Number'] || '',
      status: auth.user.Status || '',
      mustChangePassword: auth.user['Must Change Password'] === true,
      mfaEnabled,
      mustEnrolMfa: S.mustEnrolMfa(role, auth.user),
      canViewRestricted:
        role['Can View Restricted Documents'] === true &&
        auth.user['Can View Restricted Documents'] === true,
      approvalLimit: auth.user['Approval Limit (R)'] != null
        ? auth.user['Approval Limit (R)']
        : role['Approval Limit (R)'] || 0,
      recordScope: auth.user['Record Scope'] || role['Default Record Scope'] || 'All Records',
      lastLoginAt: auth.user['Last Login At'] || null,
    },
    role: {
      name: role['Role Name'] || '',
      description: role.Description || '',
      canManageUsers: isAdmin,
      canEditPermissions: role['Can Edit Permissions'] === true,
      canDelete: role['Can Delete Records'] === true,
      canExport: role['Can Export Data'] === true,
    },
    modules,
    session: {
      id: auth.sid,
      idleTimeoutMinutes: auth.touchedRestricted
        ? S.RESTRICTED_IDLE_MINUTES
        : S.IDLE_TIMEOUT_MINUTES(),
      touchedRestricted: auth.touchedRestricted,
    },
  });
};
