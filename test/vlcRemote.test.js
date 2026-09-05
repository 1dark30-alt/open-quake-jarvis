'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handle } = require('../community-apps/vlc-remote/server');

const appRoot = path.join(__dirname, '..', 'community-apps', 'vlc-remote');

async function withFetch(implementation, action) {
  const original = global.fetch;
  global.fetch = implementation;
  try {
    return await action();
  } finally {
    global.fetch = original;
  }
}

function jsonResponse(value, init) {
  return new Response(JSON.stringify(value), Object.assign({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }, init || {}));
}

test('requests VLC status with server-only Basic authentication and bounded fetch options', async () => {
  let request;
  const result = await withFetch(async (url, options) => {
    request = { url: String(url), options };
    return jsonResponse({ state: 'playing', volume: 128 });
  }, () => handle('status', {
    options: { host: 'http://127.0.0.1:8080/', password: 'secret' },
  }));

  assert.equal(result.state, 'playing');
  assert.equal(request.url, 'http://127.0.0.1:8080/requests/status.json');
  assert.equal(request.options.headers.Authorization, 'Basic OnNlY3JldA==');
  assert.equal(request.options.redirect, 'manual');
  assert.ok(request.options.signal instanceof AbortSignal);
});

test('passes only supported command parameters to VLC', async () => {
  let requestUrl;
  const result = await withFetch(async url => {
    requestUrl = new URL(String(url));
    return jsonResponse({ state: 'playing' });
  }, () => handle('command', {
    options: { host: 'http://vlc.local:8080' },
    query: { command: 'pl_play', id: '42', input: 'file:///not-forwarded' },
  }));

  assert.equal(result.state, 'playing');
  assert.equal(requestUrl.pathname, '/requests/status.json');
  assert.equal(requestUrl.searchParams.get('command'), 'pl_play');
  assert.equal(requestUrl.searchParams.get('id'), '42');
  assert.equal(requestUrl.searchParams.has('input'), false);
});

test('rejects unsupported commands and values before making a request', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls += 1;
    return jsonResponse({});
  }, async () => {
    assert.deepEqual(await handle('command', { query: { command: 'in_play', input: 'file:///example' } }), {
      ok: false,
      error: 'Unsupported VLC command',
    });
    assert.deepEqual(await handle('command', { query: { command: 'seek', val: '+9999' } }), {
      ok: false,
      error: 'Unsupported seek value',
    });
  });
  assert.equal(calls, 0);
});

test('rejects non-HTTP hosts and credentials embedded in the VLC URL', async () => {
  assert.deepEqual(await handle('status', { options: { host: 'file:///tmp/vlc' } }), {
    ok: false,
    error: 'VLC URL must use http or https',
  });
  assert.deepEqual(await handle('status', { options: { host: 'http://user:pass@vlc.local:8080' } }), {
    ok: false,
    error: 'Put VLC credentials in the password option, not the VLC URL',
  });
});

test('redacts URL credentials and password parameters from request errors', async () => {
  const result = await withFetch(async () => {
    throw new Error('connect http://alice:secret@vlc.local/?password=hunter2');
  }, () => handle('status', { options: { host: 'http://vlc.local:8080' } }));

  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /alice|secret|hunter2/);
  assert.match(result.error, /<credentials>/);
  assert.match(result.error, /password=<hidden>/);
});

test('rejects oversized responses before reading the body', async () => {
  const result = await withFetch(async () => jsonResponse({}, {
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(3 * 1024 * 1024) },
  }), () => handle('playlist', { options: { host: 'http://vlc.local:8080' } }));

  assert.deepEqual(result, { ok: false, error: 'VLC response was too large' });
});

test('returns the documented unknown-action shape for unused actions', async () => {
  assert.deepEqual(await handle('open', {}), { ok: false, error: 'unknown action' });
});

test('uses the fixed VLC palette and ignores the host accent', () => {
  const script = fs.readFileSync(path.join(appRoot, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(appRoot, 'style.css'), 'utf8');

  assert.doesNotMatch(script, /_accent/);
  assert.doesNotMatch(css, /--accent/);
  assert.match(css, /--vlc-orange:\s*#ff8800/);
  assert.match(css, /background:\s*var\(--vlc-orange\)/);
  assert.match(css, /--label-ink:\s*#f7f8f5/);
  assert.match(css, /color:\s*var\(--label-ink\)/);
});
