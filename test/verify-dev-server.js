#!/usr/bin/env node
// The dev server hands handlers a body the way Vercel does — node test/verify-dev-server.js
//
// Vercel parses a request body before the handler runs, so H.readBody() takes req.body and
// never streams; its 1 MB streaming cap is never reached in production. scripts/dev-server.js
// used to leave the body unread, so locally readBody streamed it and refused anything over 1 MB
// -- Split a PDF's page pictures among them. These run the server's own attachBody() and then
// the real readBody() on the same request, which is the order a request takes through it.

'use strict';

const path = require('path');
const { Readable } = require('stream');
const D = require(path.join(__dirname, '..', 'scripts', 'dev-server.js'));
const H = require(path.join(__dirname, '..', 'api', '_lib', 'http.js'));

let failed = 0;
let passed = 0;
function t(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else failed++;
  console.log((ok ? '  \x1b[32mpass\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m  ') + label
    + (ok ? '' : '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)));
}

/** A request as Node's http server delivers one: a stream with a method and headers. */
function request(body, type, method) {
  const chunks = [];
  const buf = Buffer.from(body);
  for (let i = 0; i < buf.length; i += 64 * 1024) chunks.push(buf.subarray(i, i + 64 * 1024));
  const req = Readable.from(chunks);
  req.method = method || 'POST';
  req.headers = { 'content-type': type || 'application/json' };
  return req;
}

/** readBody, but a hang is a failure rather than a stuck suite. */
const readBody = (req) => Promise.race([
  H.readBody(req).then((b) => ({ ok: true, b }), (e) => ({ ok: false, code: e.code })),
  new Promise((r) => setTimeout(() => r({ ok: false, code: 'hung' }), 3000)),
]);

(async () => {
  console.log('\n\x1b[1mA BODY OVER readBody\'s 1 MB, UNDER VERCEL\'S 4.5 MB\x1b[0m\n');
  {
    // Three page pictures, about what Split a PDF's classify sends at most.
    const big = { op: 'classify', pages: [1, 2, 3].map((page) => ({ page, content: 'A'.repeat(1000 * 1000) })) };
    const json = JSON.stringify(big);
    t('the request is over readBody\'s streaming cap', json.length > H.MAX_BODY_BYTES, true);
    const req = request(json);
    const b = await D.attachBody(req);
    t('the dev server accepts it, as Vercel does', b.ok, true);
    const r = await readBody(req);
    t('and the handler reads it', r.ok, true);
    t('whole', r.ok && r.b.pages.map((p) => p.content.length), [1000000, 1000000, 1000000]);
  }

  console.log('\n\x1b[1mWHAT VERCEL REFUSES, THIS REFUSES\x1b[0m\n');
  {
    const req = request('{"x":"' + 'A'.repeat(5 * 1024 * 1024) + '"}');
    const b = await D.attachBody(req);
    t('over 4.5 MB is 413, as on Vercel', [b.ok, b.status, b.payload && b.payload.reason], [false, 413, 'FUNCTION_PAYLOAD_TOO_LARGE']);
    const bad = await D.attachBody(request('{not json'));
    t('malformed JSON is 400', [bad.ok, bad.status], [false, 400]);
  }

  console.log('\n\x1b[1mTHE ORDINARY CASES STILL WORK\x1b[0m\n');
  {
    const req = request('{"op":"list","table":"job_cards"}');
    await D.attachBody(req);
    const r = await readBody(req);
    t('a small JSON body reads as before', r.b, { op: 'list', table: 'job_cards' });

    const empty = request('');
    await D.attachBody(empty);
    const e = await readBody(empty);
    t('an empty POST reads as {}, and does not hang', e, { ok: true, b: {} });

    const get = request('', '', 'GET');
    const g = await D.attachBody(get);
    t('a GET is left alone', [g.ok, get.body], [true, undefined]);

    const form = request('a=1&b=two', 'application/x-www-form-urlencoded');
    await D.attachBody(form);
    t('a form body is parsed as Vercel parses it', form.body, { a: '1', b: 'two' });
  }

  console.log('\n' + '='.repeat(70));
  console.log(failed
    ? `\n\x1b[31m\x1b[1m  ${failed} FAILED\x1b[0m, ${passed} passed`
    : `\n\x1b[32m\x1b[1m  ALL ${passed} ASSERTIONS PASSED\x1b[0m`);
  console.log('='.repeat(70) + '\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Suite crashed:', e); process.exit(1); });
