'use strict';
// Build the app's index.html from an upstream Parchment "single file" release.
//
//   node vendor-parchment.js <path-to-parchment.html>
//
// open-quake serves drop-in app files under a strict CSP: `script-src 'self'` and
// `frame-ancestors 'none'`. Parchment's single-file build breaks against all of that out of the box,
// in three separate ways. This script resolves each without weakening the platform's CSP:
//
//   1. ~4MB of the build is INLINE <script>. Every executable one is written out to
//      interpreter/parchment-N.js and replaced with <script src>.
//   2. The interpreter cores are embedded as `type="text/plain"` blocks, and in that mode Parchment
//      loads them with `import("data:text/javascript,...")` -- also blocked. Its loader checks
//      `document.getElementById(name)` FIRST and otherwise falls back to `new URL(name, lib_path)`
//      with a plain import/fetch, so extracting each block to a real file in interpreter/ and
//      pointing lib_path there puts every core back on a same-origin URL. (.wasm blocks are
//      base64'd gzip; they are decoded here so they ship as real binaries.)
//   3. Parchment's page becomes the app entry with our chrome injected, rather than being framed by
//      a wrapper -- so frame-ancestors never applies. Being top-level also means Parchment's
//      autoplay default (window.self === window.top) is already true.
//
// It also drops the Scare (Adrift) and TADS interpreters: they are GPL-2.0 while everything else in
// the build is MIT/BSD, they are ~2MB, and this app targets Inform/Z-machine and Glulx. Removing
// them keeps the bundle permissively licensed. See LICENSES.md.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = __dirname;
const INTERP = path.join(DIR, 'interpreter');
const DROP = ['scare', 'tads'];          // GPL-2.0, and not needed for Inform/Z-machine/Glulx

const src = process.argv[2];
if (!src) { console.error('usage: node vendor-parchment.js <parchment.html>'); process.exit(1); }
let html = fs.readFileSync(src, 'utf8');

function fail(msg) {
  console.error('FAILED: ' + msg);
  console.error("Parchment's build layout has changed; re-read its single-file output and update this script.");
  process.exit(1);
}
fs.mkdirSync(INTERP, { recursive: true });

// --- 1. extract the embedded interpreter cores to real files -----------------------------------
const cores = [];
html = html.replace(/<script\b([^>]*?)type="text\/plain([^"]*)"([^>]*?)id="([^"]+)"([^>]*)>([\s\S]*?)<\/script>/g,
  function (whole, a1, typeRest, a3, id, a5, payload) {
    const base = id.replace(/\.(js|wasm)$/, '');
    if (DROP.indexOf(base) >= 0) { cores.push('dropped ' + id); return ''; }
    const text = payload.trim();
    let out;
    if (id.endsWith('.wasm')) {
      const raw = Buffer.from(text, 'base64');
      out = /;gzip/.test(typeRest) ? zlib.gunzipSync(raw) : raw;
    } else {
      out = Buffer.from(text, 'utf8');                    // .js blocks are raw ES module source
    }
    fs.writeFileSync(path.join(INTERP, id), out);
    cores.push(id + ' (' + out.length + 'B)');
    return '';                                            // remove the block: absence selects lib_path
  });
if (!cores.length) fail('no embedded interpreter cores found');

// --- 2. externalise executable inline scripts --------------------------------------------------
const files = [];
let n = 0;
html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/g, function (whole, attrs, code) {
  if (/type\s*=\s*"text\/plain/.test(attrs)) return whole;   // any remaining data payload
  if (/\bsrc\s*=/.test(attrs)) return whole;                 // already external
  if (!code.trim()) return whole;
  const name = 'parchment-' + (n++) + '.js';
  fs.writeFileSync(path.join(INTERP, name), code);
  files.push(name);
  const keep = (attrs.match(/\btype\s*=\s*"module"/) ? ' type="module"' : '')
    + (/\bnomodule\b/.test(attrs) ? ' nomodule' : '');
  const tag = '<script src="interpreter/' + name + '"' + keep + '></script>';
  // boot.js must land straight after Parchment's own options assignment (the first block) and before
  // its main bundle -- that is the only window in which lib_path, the story URL and theme can be set.
  return n === 1 ? tag + '\n<script src="boot.js"></script>' : tag;
});
if (!files.length) fail('no executable inline scripts found to externalise');
if (html.indexOf('<script src="boot.js">') < 0) fail('boot.js was not injected');

// --- 3. inject our chrome ----------------------------------------------------------------------
const CHROME = fs.readFileSync(path.join(DIR, 'chrome.html'), 'utf8');
if (html.indexOf('</head>') < 0 || html.indexOf('</body>') < 0) fail('no </head> or </body>');
html = html.replace('</head>', '  <link rel="stylesheet" href="style.css">\n</head>');
html = html.replace('</body>', CHROME + '\n<script src="vad.js"></script>\n<script src="app.js"></script>\n</body>');

// --- 4. write + verify -------------------------------------------------------------------------
const dest = path.join(DIR, 'index.html');
fs.writeFileSync(dest, html);
const out = fs.readFileSync(dest, 'utf8');
const stray = /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.exec(out);
console.log('cores:        ' + cores.join(', '));
console.log('externalised: ' + files.join(', '));
console.log('wrote:        ' + dest + ' (' + out.length + ' bytes)');
console.log('inline scripts remaining: ' + (stray ? 'YES -- ' + stray[0].slice(0, 90) : 'none'));
if (stray) process.exit(1);
