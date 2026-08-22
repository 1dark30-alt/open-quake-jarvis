'use strict';
// /app-api/<action> POST support: a drop-in app's server.js receives the raw request body, so an app
// can send data a query string can't carry (the IF player posts captured PCM audio for transcription).
// Also pins the gating that makes that safe: same-origin only, and only for a registered app folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sysserver = require('../app/sysserver');

function req(port, method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: Object.assign({ Host: '127.0.0.1:' + port },
        body ? { 'Content-Length': Buffer.byteLength(body) } : {}, headers || {}),
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) {}
        resolve({ status: res.statusCode, text: t, body: b });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// A minimal drop-in app whose server.js reports back what the platform handed it.
function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-appapi-'));
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ id: 'probe', name: 'Probe', entry: 'index.html', served: true, server: 'server.js' }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>probe</title>');
  fs.writeFileSync(path.join(dir, 'server.js'), [
    "'use strict';",
    'async function handle(action, context) {',
    '  return { ok: true, action,',
    '    isBuffer: Buffer.isBuffer(context.body),',
    '    bodyLen: context.body ? context.body.length : -1,',
    '    bodyText: context.body ? context.body.toString("utf8") : null,',
    '    firstBytes: context.body ? Array.from(context.body.subarray(0, 4)) : null };',
    '}',
    'module.exports = { handle };',
  ].join('\n'));
  return dir;
}

test('POST /app-api/<action> delivers the raw body to the app server, same-origin only', async () => {
  const dir = makeApp();
  const port = await sysserver.start({
    appFolders: { probe: { root: dir, server: path.join(dir, 'server.js') } },
    getAppConfig: () => ({ options: {} }),
  });
  const REF = { Referer: 'http://127.0.0.1:' + port + '/apps/probe/index.html', 'Sec-Fetch-Site': 'same-origin' };
  try {
    // Binary body (the audio case): arrives intact as a Buffer, byte for byte.
    const pcm = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x10]);
    const bin = await req(port, 'POST', '/app-api/listen', Object.assign({ 'Content-Type': 'application/octet-stream' }, REF), pcm);
    assert.equal(bin.status, 200);
    assert.equal(bin.body.ok, true);
    assert.equal(bin.body.action, 'listen');
    assert.equal(bin.body.isBuffer, true);
    assert.equal(bin.body.bodyLen, 5);
    assert.deepEqual(bin.body.firstBytes, [0, 1, 254, 255]);

    // Text body (the speak case).
    const txt = await req(port, 'POST', '/app-api/speak', Object.assign({ 'Content-Type': 'text/plain' }, REF), 'You are in a maze.');
    assert.equal(txt.body.bodyText, 'You are in a maze.');

    // GET still works and simply has no body.
    const get = await req(port, 'GET', '/app-api/config', REF);
    assert.equal(get.status, 200);
    assert.equal(get.body.bodyLen, -1);

    // A cross-site POST is refused before reaching the app.
    const cross = await req(port, 'POST', '/app-api/listen',
      { Referer: 'http://127.0.0.1:' + port + '/apps/probe/index.html', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/octet-stream' }, pcm);
    assert.equal(cross.status, 403);

    // Same-origin but not from a registered app folder: no app to route to.
    const noapp = await req(port, 'POST', '/app-api/listen',
      { Referer: 'http://127.0.0.1:' + port + '/apps/nosuch/index.html', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/octet-stream' }, pcm);
    assert.notEqual(noapp.status, 200);
  } finally {
    await sysserver.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
