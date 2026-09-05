'use strict';
// owuiClient: URL normalization matrix, raw-http postJson/streamChat against a REAL local http
// server (auth header, query preserved, SSE reassembly across split chunks, [DONE], inactivity
// timeout), and defensive listModels parsing. No fakes on the wire — the transport is the point.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { normalizeOwuiUrl, postJson, streamChat, listModels } = require('../app/owuiClient');

test('normalizeOwuiUrl: every pasted form derives the same /api endpoints from the origin', () => {
  const want = origin => ({ origin, chatUrl: origin + '/api/chat/completions', modelsUrl: origin + '/api/models' });
  assert.deepEqual(normalizeOwuiUrl('http://box:3000'), want('http://box:3000'));
  assert.deepEqual(normalizeOwuiUrl('http://box:3000/'), want('http://box:3000'));
  assert.deepEqual(normalizeOwuiUrl('https://owui.example.com'), want('https://owui.example.com'));
  assert.deepEqual(normalizeOwuiUrl('http://box:3000/v1'), want('http://box:3000'));                    // /v1 paths discarded
  assert.deepEqual(normalizeOwuiUrl('http://box:3000/api/chat/completions'), want('http://box:3000'));  // full path accepted
  assert.deepEqual(normalizeOwuiUrl('box:3000'), want('http://box:3000'));                              // bare host:port
  assert.deepEqual(normalizeOwuiUrl('192.168.1.25:3000'), want('http://192.168.1.25:3000'));
  assert.deepEqual(normalizeOwuiUrl('http:/box:3000'), want('http://box:3000'));                        // missing-slash typo heals
  assert.deepEqual(normalizeOwuiUrl('https:box:3000'), want('https://box:3000'));
  assert.deepEqual(normalizeOwuiUrl('  http://box:3000  '), want('http://box:3000'));
  assert.equal(normalizeOwuiUrl(''), null);
  assert.equal(normalizeOwuiUrl('   '), null);
  assert.equal(normalizeOwuiUrl(null), null);
  assert.equal(normalizeOwuiUrl('ftp://box:3000'), null);   // non-web scheme refused, not silently rewritten
});

// One tiny disposable server per test; handler sees (req, res, bodyText).
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => handler(req, res, body));
    });
    srv.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      try { resolve(await fn(base)); }
      catch (e) { reject(e); }
      finally { srv.close(); }
    });
  });
}

test('postJson: JSON body, Bearer auth, query preserved, non-200 passes through', async () => {
  await withServer((req, res, body) => {
    if (req.url === '/api/chat/completions?probe=1') {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer sk-abc');
      assert.equal(req.headers['content-type'], 'application/json');
      assert.deepEqual(JSON.parse(body), { model: 'm', stream: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404); res.end('nope');
    }
  }, async base => {
    const r = await postJson(base + '/api/chat/completions?probe=1', { model: 'm', stream: false }, 'sk-abc', 5000);
    assert.deepEqual(r, { status: 200, text: '{"ok":true}' });
    const bad = await postJson(base + '/other', {}, 'sk-abc', 5000);
    assert.equal(bad.status, 404);
    assert.equal(bad.text, 'nope');
  });
});

test('postJson: no Authorization header when the key is empty; connection refused rejects', async () => {
  await withServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200); res.end('{}');
  }, async base => {
    await postJson(base + '/x', {}, '', 5000);
  });
  await assert.rejects(postJson('http://127.0.0.1:1/x', {}, '', 5000));   // port 1: nothing listens
});

test('streamChat: SSE deltas reassemble across split chunks; [DONE] finishes with the last finish_reason', async () => {
  const frame = obj => 'data: ' + JSON.stringify(obj) + '\n\n';
  await withServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer k2');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const full = frame({ choices: [{ delta: { content: 'Hel' } }] })
      + frame({ choices: [{ delta: { content: 'lo world' } }] })
      + 'data: {"garbage\n\n'                                      // unparseable — skipped, not fatal
      + frame({ choices: [] })                                     // empty choices — skipped
      + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      + 'data: [DONE]\n\n';
    // Split mid-frame to prove line buffering: byte 10 lands inside the first data: line.
    res.write(full.slice(0, 10));
    setTimeout(() => { res.write(full.slice(10)); res.end(); }, 20);
  }, base => new Promise((resolve, reject) => {
    const deltas = [];
    streamChat(base + '/api/chat/completions', { stream: true }, 'k2', 5000, {
      onDelta: t => deltas.push(t),
      onDone: ({ finishReason }) => {
        try {
          assert.equal(deltas.join(''), 'Hello world');
          assert.equal(finishReason, 'stop');
          resolve();
        } catch (e) { reject(e); }
      },
      onError: e => reject(new Error('unexpected error: ' + e.message)),
    });
  }));
});

test('streamChat: HTTP error carries statusCode; destroy() aborts silently', async () => {
  await withServer((req, res) => {
    if (req.url === '/err') { res.writeHead(401); res.end('{"detail":"bad key"}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');   // then hang — destroy() cuts it
  }, async base => {
    await new Promise((resolve, reject) => {
      streamChat(base + '/err', {}, 'k', 5000, {
        onDelta: () => reject(new Error('no deltas expected')),
        onDone: () => reject(new Error('must not complete')),
        onError: e => {
          try { assert.equal(e.statusCode, 401); assert.match(e.message, /bad key/); resolve(); }
          catch (e2) { reject(e2); }
        },
      });
    });
    await new Promise((resolve, reject) => {
      const s = streamChat(base + '/hang', {}, 'k', 5000, {
        onDelta: () => setImmediate(() => { s.destroy(); setTimeout(resolve, 50); }),   // no callbacks after destroy
        onDone: () => reject(new Error('destroyed stream must not call onDone')),
        onError: () => reject(new Error('destroyed stream must not call onError')),
      });
    });
  });
});

test('streamChat: server going silent trips the inactivity timeout', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // one delta, then silence forever
    res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
  }, base => new Promise((resolve, reject) => {
    streamChat(base + '/x', {}, '', 300, {
      onDone: () => reject(new Error('must not complete')),
      onError: e => {
        try { assert.match(e.message, /no response after/); resolve(); }
        catch (e2) { reject(e2); }
      },
    });
  }));
});

test('listModels: accepts {data}, {models}, and bare-array shapes; 401 throws with statusCode', async () => {
  const fake = body => async () => ({ ok: true, status: 200, json: async () => body });
  assert.deepEqual(await listModels('http://x/api/models', 'k', fake({ data: [{ id: 'llama3' }, { name: 'phi' }, 7] })), ['llama3', 'phi']);
  assert.deepEqual(await listModels('http://x/api/models', 'k', fake({ models: ['a', 'b'] })), ['a', 'b']);
  assert.deepEqual(await listModels('http://x/api/models', 'k', fake(['c'])), ['c']);
  assert.deepEqual(await listModels('http://x/api/models', 'k', fake({ weird: true })), []);
  await assert.rejects(
    listModels('http://x/api/models', 'bad', async () => ({ ok: false, status: 401 })),
    e => e.statusCode === 401,
  );
});
