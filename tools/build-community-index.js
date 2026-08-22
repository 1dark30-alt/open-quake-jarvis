'use strict';
// Generate community-apps/index.json -- the machine-readable catalog the panel fetches to list and
// version drop-in apps (Settings -> Drop-In Apps -> Browse repo). Run this whenever an app is added
// or its version bumped, alongside rebuilding that app's <id>.zip, then commit both.
//
//   node tools/build-community-index.js
//
// Each entry: { id, name, description, version, zip:"<id>.zip", server:<bool> }. A committed
// <id>.zip must sit next to the app folder (that's what the installer downloads).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'community-apps');
const OUT = path.join(ROOT, 'index.json');

function readManifest(dir) {
  for (const n of ['app.json', 'manifest.json']) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
      catch (e) { console.error('  ! bad JSON in ' + p + ': ' + e.message); return null; }
    }
  }
  return null;
}

const apps = [];
const warnings = [];
for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!ent.isDirectory() || ent.name === 'skills') continue;
  const dir = path.join(ROOT, ent.name);
  const m = readManifest(dir);
  if (!m || typeof m.id !== 'string') continue;                 // not an app folder
  const zip = m.id + '.zip';
  if (!fs.existsSync(path.join(ROOT, zip))) warnings.push('no ' + zip + ' committed for "' + m.id + '" (installer will 404)');
  if (!m.version) warnings.push('"' + m.id + '" has no version field');
  apps.push({
    id: m.id,
    name: m.name || m.id,
    description: typeof m.description === 'string' ? m.description : '',
    version: typeof m.version === 'string' ? m.version : '0.0.0',
    zip: zip,
    server: !!m.server,
  });
}
apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

fs.writeFileSync(OUT, JSON.stringify({ apps }, null, 2) + '\n');
console.log('wrote ' + OUT + ' (' + apps.length + ' apps)');
apps.forEach(a => console.log('  - ' + a.id + '  v' + a.version + (a.server ? '  [server]' : '')));
warnings.forEach(w => console.warn('  ! ' + w));
