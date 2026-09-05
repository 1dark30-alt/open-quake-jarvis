'use strict';
/*
 * touchSetup.js — bind a touchscreen to its physical display on Windows.
 *
 * Two operations:
 *   - runMultidigimon() — launches Windows' built-in `multidigimon -touch` wizard ("Tap this
 *     screen with a single finger to identify it as a touch screen"). This is what writes the
 *     persistent digitizer→display binding under HKLM\SOFTWARE\Microsoft\Wisp\Pen\Digimon.
 *     Tablet PC Settings → Setup → Touch Input used to fire the same wizard, but that UI is
 *     hidden / broken in Win 11 24H2. multidigimon -touch is the same backend tool, callable
 *     directly. Binding persists across primary-display swaps, sleep, USB reconnect, reboot.
 *   - runTabcal(displayId) — fine COORDINATE calibration (after binding is correct). Separate
 *     concern; use only if taps land on the right display but slightly off-target.
 *
 * Both run elevated via a temp .ps1 file — sidesteps the PowerShell quoting nightmares of
 * passing complex args through nested -Command strings (UAC would silently never appear).
 *
 * No-op on macOS / Linux.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Enumerate Windows displays with their device name + bounds. Returns [] off Windows or on failure.
function enumDisplays() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const ps = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.DeviceName, $_.Bounds.X, $_.Bounds.Y, $_.Bounds.Width, $_.Bounds.Height, $_.Primary }";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', code => {
      if (code !== 0) return resolve([]);
      const rows = out.trim().split(/\r?\n/).map(line => {
        const parts = line.split('|');
        if (parts.length < 6) return null;
        return { deviceName: parts[0], x: +parts[1], y: +parts[2], width: +parts[3], height: +parts[4], primary: parts[5] === 'True' };
      }).filter(Boolean);
      resolve(rows);
    });
  });
}

// Given an Electron Display object (the panel), return the matching \\.\DISPLAY# name or null.
async function findDisplayId(panel) {
  if (!panel || !panel.bounds) return null;
  const b = panel.bounds;
  const rows = await enumDisplays();
  const hit = rows.find(r => r.x === b.x && r.y === b.y && r.width === b.width && r.height === b.height);
  return hit ? hit.deviceName : null;
}

// Run a command elevated via a temp .ps1 file. Used by both runMultidigimon and runTabcal so the
// quoting / UAC plumbing is identical for both. Returns a Promise of { ok, scriptPath, error? }.
function runElevatedScript(scriptBody, tag) {
  const script = scriptBody.endsWith('\r\n') ? scriptBody : scriptBody + '\r\n';
  const tempPath = path.join(os.tmpdir(), 'oq-' + tag + '-' + Date.now() + '.ps1');
  try { fs.writeFileSync(tempPath, script, 'utf8'); }
  catch (e) { return Promise.resolve({ ok: false, error: 'temp script write failed: ' + e.message }); }
  const outer = `Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${tempPath.replace(/'/g, "''")}' -Verb RunAs`;
  console.log('[touchSetup] ' + tag + ' scriptPath=' + tempPath + ' contents=' + JSON.stringify(script.trim()));
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', outer], { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => { console.log('[touchSetup] ' + tag + ' spawn error:', e.message); resolve({ ok: false, error: 'spawn: ' + e.message }); });
    child.on('close', code => {
      console.log('[touchSetup] ' + tag + ' PS exit=' + code + (out.trim() ? ' stdout=' + out.trim() : '') + (err.trim() ? ' stderr=' + err.trim() : ''));
      setTimeout(() => { try { fs.unlinkSync(tempPath); } catch (e) {} }, 60000);
      if (code !== 0) return resolve({ ok: false, error: 'PowerShell exit ' + code + (err.trim() ? ': ' + err.trim() : '') });
      resolve({ ok: true, scriptPath: tempPath });
    });
  });
}

// Launch Windows' built-in touch-identify wizard. The user taps the panel when its prompt appears
// and Windows writes the persistent binding. DOES NOT need a DisplayID — the wizard identifies the
// display from where the tap came.
function runMultidigimon() {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'Windows only' });
  return runElevatedScript('multidigimon.exe -touch', 'multidigimon');
}

// Fine coordinate calibration on a specific display, AFTER binding is correct. Separate concern
// from runMultidigimon; users only need this if their taps land on the right display but slightly
// off. DeviceKind=touch is REQUIRED — without it tabcal defaults to pen calibration and silently
// ignores finger touches.
function runTabcal(displayId) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'Windows only' });
  if (!displayId) return Promise.resolve({ ok: false, error: 'no display id' });
  return runElevatedScript(`tabcal.exe LinCal DeviceKind=touch DisplayID=${displayId}`, 'tabcal');
}

// Clear stale calibration on every display so a fresh LinCal binds cleanly. Useful when the user
// has run setup before on the wrong display and the OS is holding onto that mapping.
function clearAllCalibrations() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  // Build a chained command so one UAC prompt covers all the ClearCal calls.
  // DeviceKind=touch is REQUIRED — without it ClearCal targets pen calibration data, not touch.
  const ps = "Add-Type -AssemblyName System.Windows.Forms; $ids = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.DeviceName }; $cmd = ($ids | ForEach-Object { 'tabcal.exe ClearCal DeviceKind=touch DisplayID=' + $_ }) -join ' ; '; Start-Process powershell.exe -ArgumentList '-NoProfile','-Command',$cmd -Verb RunAs -WindowStyle Hidden";
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = { enumDisplays, findDisplayId, runMultidigimon, runTabcal, clearAllCalibrations };
