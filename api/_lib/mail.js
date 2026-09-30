// TAGEX — transactional mail via Resend. Invite and password-reset links only.
//
// A one-time token appears in the emailed link and nowhere else: not in the database (only its
// SHA-256), not in the audit trail, not in a log line. Passwords are never emailed, ever.

'use strict';

const FROM = () => process.env.FROM_EMAIL || 'delivery@tagexenergy.co.za';
const BRAND = '#f0a500';
const INK = '#0e0f11';

function appOrigin(req) {
  if (process.env.APP_ORIGIN) return String(process.env.APP_ORIGIN).replace(/\/+$/, '');
  const proto = (req && req.headers['x-forwarded-proto']) || 'https';
  const host = (req && (req.headers['x-forwarded-host'] || req.headers.host)) || 'localhost:3000';
  return `${proto}://${host}`;
}

async function send({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    const err = new Error('RESEND_API_KEY is not set');
    err.code = 'mail_not_configured';
    throw err;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `TAGEX Energy <${FROM()}>`,
      to: Array.isArray(to) ? to : [to],
      subject, html, text,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Resend HTTP ${res.status}`);
    err.code = 'mail_send_failed';
    throw err;
  }
  return data;
}

function shell(heading, bodyHtml, ctaLabel, ctaUrl, footNote) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
  <tr><td style="background:${INK};padding:22px 30px;">
    <span style="color:${BRAND};font-size:20px;font-weight:700;letter-spacing:.04em;">TAGEX ENERGY</span>
    <div style="color:#8b92a8;font-size:12px;margin-top:3px;">Operations Platform</div>
  </td></tr>
  <tr><td style="padding:28px 30px 8px;">
    <h1 style="margin:0 0 14px;font-size:19px;color:#111827;">${heading}</h1>
    ${bodyHtml}
  </td></tr>
  <tr><td style="padding:8px 30px 26px;">
    <a href="${ctaUrl}" style="display:inline-block;background:${BRAND};color:#0a0a0b;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:6px;">${ctaLabel}</a>
    <p style="font-size:12px;color:#6b7280;margin:18px 0 0;line-height:1.6;">
      If the button does not work, copy this link into your browser:<br>
      <span style="color:#374151;word-break:break-all;">${ctaUrl}</span>
    </p>
  </td></tr>
  <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:14px 30px;font-size:11px;color:#9ca3af;line-height:1.6;">
    ${footNote}
  </td></tr>
</table></td></tr></table></body></html>`;
}

async function sendInvite({ to, fullName, token, req }) {
  const url = `${appOrigin(req)}/?invite=${encodeURIComponent(token)}`;
  const html = shell(
    `Welcome${fullName ? ', ' + fullName : ''}`,
    `<p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 10px;">
       An account has been created for you on the TAGEX Energy operations platform.
       Set your password to activate it.</p>
     <p style="font-size:14px;color:#374151;line-height:1.7;margin:0;">
       Your password must be at least 12 characters, with an uppercase letter, a lowercase letter and a digit.</p>`,
    'Set my password', url,
    'This link can be used once and expires in 72 hours. If you were not expecting it, ignore this email and tell your manager.'
  );
  const text = [
    `Welcome${fullName ? ', ' + fullName : ''}.`,
    '',
    'An account has been created for you on the TAGEX Energy operations platform.',
    'Set your password here (one use, expires in 72 hours):',
    url,
    '',
    'Minimum 12 characters, with an uppercase letter, a lowercase letter and a digit.',
  ].join('\n');
  return send({ to, subject: 'Your TAGEX Energy account', html, text });
}

async function sendPasswordReset({ to, token, req }) {
  const url = `${appOrigin(req)}/?reset=${encodeURIComponent(token)}`;
  const html = shell(
    'Reset your password',
    `<p style="font-size:14px;color:#374151;line-height:1.7;margin:0;">
       Someone asked to reset the password for this account. If that was you, choose a new one.
       Every other signed-in session will be ended.</p>`,
    'Choose a new password', url,
    'This link can be used once and expires in 1 hour. If you did not request it, no action is needed — your password has not changed.'
  );
  const text = [
    'Reset your TAGEX Energy password.',
    '',
    'Use this link once, within 1 hour:',
    url,
    '',
    'If you did not request this, no action is needed. Your password has not changed.',
  ].join('\n');
  return send({ to, subject: 'Reset your TAGEX Energy password', html, text });
}

module.exports = { send, sendInvite, sendPasswordReset, appOrigin };
