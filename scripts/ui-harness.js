#!/usr/bin/env node
// Serves public/ plus test/ so a UI harness can be opened in a real browser.
//
//   node scripts/ui-harness.js          ->  http://localhost:4321/test/batch-harness.html
//
// WHY THIS IS SEPARATE FROM dev-server.js
//
// dev-server.js serves public/ and nothing else, and refuses to climb out of it — which is
// correct, because it also runs the real api/ handlers against real credentials. This serves
// static files ONLY: no handlers, no environment, no session. A harness is a page full of stubs
// (TX.can() returning true, a fake network) and it must never be reachable from something that
// can also talk to Airtable, nor end up under public/ where it would deploy.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const TESTS = path.join(ROOT, 'test');
const PORT = Number(process.argv[2]) || 4321;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const inTests = url.pathname.startsWith('/test/');
  const base = inTests ? TESTS : PUBLIC;
  const rel = inTests ? url.pathname.slice('/test'.length)
    : (url.pathname === '/' ? '/index.html' : url.pathname);

  const full = path.normalize(path.join(base, rel));
  if (!full.startsWith(base)) { res.statusCode = 403; res.end('Forbidden'); return; }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.statusCode = 404;
    res.end('Not found: ' + url.pathname);
    return;
  }

  res.setHeader('Content-Type', TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');   // an edited js/css file is never stale
  fs.createReadStream(full).pipe(res);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is busy. Run it elsewhere:  node scripts/ui-harness.js ${PORT + 1}\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`\n  UI harness  http://localhost:${PORT}/test/batch-harness.html`);
  console.log('  Static files only — no API handlers, no credentials.\n');
});
