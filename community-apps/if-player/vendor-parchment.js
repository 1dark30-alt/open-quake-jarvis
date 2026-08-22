'use strict';
// Vendoring script for interpreter/parchment-single.html -- run this to upgrade Parchment.
//
//   node vendor-parchment.js <path-to-parchment.html-from-a-release>
//
// Parchment ships a "single file" build (github.com/curiousdannii/parchment/releases). It is used
// as-is except for ONE patch, which this script applies and verifies:
//
//   Parchment's load() does `if (embedded && !options.play_in_iframe) { window.open(...); return }`
//   -- an embedded copy opens a new tab instead of playing in place. `play_in_iframe` is NOT one of
//   the query-overridable options (only autoplay / do_vm_autosave / use_asyncglk / story are), and
//   the single-file build hardcodes its options inline, so the flag has to be set in that literal.
//
// Everything else -- interpreter cores, Glk layer, UI -- is untouched upstream code.
const fs = require('fs');
const path = require('path');

const FROM = '{\n  "single_file": 1\n}';
const TO = '{\n  "single_file": 1,\n  "play_in_iframe": 1\n}';
const DEST = path.join(__dirname, 'interpreter', 'parchment-single.html');

const src = process.argv[2];
if (!src) { console.error('usage: node vendor-parchment.js <parchment.html>'); process.exit(1); }

let html = fs.readFileSync(src, 'utf8');
if (html.indexOf('"play_in_iframe"') >= 0) {
  console.log('already patched');
} else {
  if (html.indexOf(FROM) < 0) {
    console.error('FAILED: the inline parchment_options literal was not found -- Parchment changed its');
    console.error('build layout. Re-read how it sets parchment_options and update this script.');
    process.exit(1);
  }
  html = html.replace(FROM, TO);
}
fs.writeFileSync(DEST, html);
const check = fs.readFileSync(DEST, 'utf8');
console.log('wrote ' + DEST + ' (' + check.length + ' bytes)');
console.log('play_in_iframe present: ' + (check.indexOf('"play_in_iframe": 1') >= 0));
