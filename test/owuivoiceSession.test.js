'use strict';
// owuivoice-session: the Open WebUI adapter must satisfy the FULL voicepanel-host contract
// (the host calls mode()/validModel()/etc unguarded — a missing method throws at runtime), stream
// turns in the assistant-start → deltas → assistant-final → turn-complete order, keep capped
// multi-turn history, map errors to Auth-tab wordings, and treat truncation as a notice.
// Fake owuiClient (the transport has its own wire tests in owuiClient.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOwuiVoiceAdapter } = require('../app/owuivoice-session');
const { normalizeOwuiUrl } = require('../app/owuiClient');

// Controllable fake transport: streamChat records the request and exposes the handlers so a test
// drives the stream by hand; listModels resolves what the test configured.
function makeAdapter(cfg, opts) {
  opts = opts || {};
  const streams = [];   // [{ url, body, apiKey, h, destroyed }]
  const client = {
    normalizeOwuiUrl,
    listModels: () => (opts.models ? Promise.resolve(opts.models) : new Promise(() => {})),   // default: never answers
    streamChat: (url, body, apiKey, timeoutMs, h) => {
      const rec = { url, body, apiKey, h, destroyed: false };
      streams.push(rec);
      return { destroy() { rec.destroyed = true; } };
    },
  };
  const adapter = createOwuiVoiceAdapter({ resolveOwui: () => cfg, log: () => {}, client });
  const events = [];
  for (const ev of ['assistant-start', 'assistant-delta', 'assistant-final', 'turn-complete', 'model', 'models-changed', 'notice', 'error']) {
    adapter.on(ev, payload => events.push({ ev, payload }));
  }
  return { adapter, streams, events };
}
const CFG = { url: 'http://box:3000', apiKey: 'sk-1', model: 'llama3' };
const tick = () => new Promise(r => setImmediate(r));

test('contract completeness: every host-called method exists and is callable pre-start', () => {
  const { adapter } = makeAdapter(CFG);
  // voicepanel-host calls these without guards (only listModes/listModels/handleHookRequest are guarded)
  for (const m of ['start', 'stop', 'sendTurn', 'isRunning', 'sessionId', 'projectDir', 'interrupt',
    'setMode', 'mode', 'listModes', 'setModel', 'currentModel', 'validModel', 'decideApproval', 'cancelApprovals', 'on', 'off']) {
    assert.equal(typeof adapter[m], 'function', m + ' must exist');
  }
  assert.equal(adapter.isRunning(), false);
  assert.equal(adapter.sessionId(), null);
  assert.equal(adapter.projectDir(), '');           // no working directory, ever
  assert.equal(adapter.mode(), '');
  assert.deepEqual(adapter.listModes(), []);        // hides the Mode button
  assert.equal(adapter.setMode('anything'), false);
  assert.equal(adapter.decideApproval('1', 'allow'), false);
  assert.equal(adapter.supportsAlwaysApproval, false);
  adapter.cancelApprovals('quitting');              // must not throw
  assert.equal(adapter.sendTurn('hi'), false);      // not running yet
  assert.equal(adapter.interrupt(), false);
});

test('start refuses without a configured URL and says where to fix it', () => {
  const { adapter, events } = makeAdapter({ url: '', apiKey: '', model: '' });
  assert.equal(adapter.start({}), false);
  assert.equal(adapter.isRunning(), false);
  const err = events.find(e => e.ev === 'error');
  assert.match(err.payload.message, /not configured.*Auth tab/);
});

test('model list loads async after start; validModel is permissive until then', async () => {
  const { adapter, events } = makeAdapter(CFG, { models: ['llama3', 'phi4'] });
  assert.equal(adapter.validModel('anything-goes'), true);    // list not loaded yet
  assert.equal(adapter.start({ model: '' }), true);
  assert.ok(adapter.sessionId());
  await tick(); await tick();
  assert.ok(events.some(e => e.ev === 'models-changed'));
  assert.equal(adapter.validModel('phi4'), true);
  assert.equal(adapter.validModel('not-a-model'), false);
  assert.equal(adapter.validModel(''), true);                 // '' = Auth-tab default, always valid
  const list = adapter.listModels();
  assert.equal(list[0].id, '');                               // default entry first
  assert.match(list[0].label, /llama3/);                      // names the Auth-tab default
  assert.deepEqual(list.slice(1).map(m => m.id), ['llama3', 'phi4']);
  assert.equal(adapter.setModel('phi4'), true);
  assert.equal(adapter.currentModel(), 'phi4');
  assert.equal(adapter.setModel('bogus'), false);
  assert.equal(adapter.currentModel(), 'phi4');
});

test('turn flow: assistant-start → deltas → assistant-final → turn-complete, history grows both roles', async () => {
  const { adapter, streams, events } = makeAdapter(CFG);
  adapter.start({});
  assert.equal(adapter.sendTurn('hello'), true);
  assert.equal(adapter.sendTurn('too soon'), false);          // one turn in flight at a time
  const s1 = streams[0];
  assert.equal(s1.url, 'http://box:3000/api/chat/completions');
  assert.equal(s1.apiKey, 'sk-1');
  assert.equal(s1.body.model, 'llama3');                      // Auth-tab default (no pick)
  assert.equal(s1.body.stream, true);
  assert.deepEqual(s1.body.messages, [{ role: 'user', content: 'hello' }]);
  s1.h.onDelta('Hi '); s1.h.onDelta('there');
  s1.h.onDone({ finishReason: 'stop' });
  assert.deepEqual(events.map(e => e.ev), ['assistant-start', 'assistant-delta', 'assistant-delta', 'assistant-final', 'turn-complete']);
  assert.equal(events[3].payload.text, 'Hi there');
  assert.deepEqual(events[4].payload, { text: 'Hi there', error: null });
  // second turn carries the whole conversation
  adapter.sendTurn('and again');
  assert.deepEqual(streams[1].body.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Hi there' },
    { role: 'user', content: 'and again' },
  ]);
});

test('history caps at 40 messages', async () => {
  const { adapter, streams } = makeAdapter(CFG);
  adapter.start({});
  for (let i = 0; i < 30; i++) {
    adapter.sendTurn('turn ' + i);
    const s = streams[streams.length - 1];
    s.h.onDelta('r' + i);
    s.h.onDone({ finishReason: 'stop' });
  }
  const last = streams[streams.length - 1];
  assert.ok(last.body.messages.length <= 40, 'got ' + last.body.messages.length);
  assert.equal(last.body.messages[last.body.messages.length - 1].content, 'turn 29');   // newest kept, oldest dropped
});

test('401 maps to the Auth-tab wording and the failed user turn is not left in history', () => {
  const { adapter, streams, events } = makeAdapter(CFG);
  adapter.start({});
  adapter.sendTurn('hello');
  const e401 = new Error('HTTP 401: unauthorized'); e401.statusCode = 401;
  streams[0].h.onError(e401);
  const done = events.find(e => e.ev === 'turn-complete');
  assert.match(done.payload.error, /rejected the API key.*check the key on the Auth tab/);
  adapter.sendTurn('retry');
  assert.deepEqual(streams[1].body.messages, [{ role: 'user', content: 'retry' }]);   // no doubled 'hello'
});

test('connection failure asks whether the server is running', () => {
  const { adapter, streams, events } = makeAdapter(CFG);
  adapter.start({});
  adapter.sendTurn('hello');
  streams[0].h.onError(new Error('connect ECONNREFUSED'));
  const done = events.find(e => e.ev === 'turn-complete');
  assert.match(done.payload.error, /is Open WebUI running\?/);
});

test('truncation is a notice, not an error — the partial reply stays', () => {
  const { adapter, streams, events } = makeAdapter(CFG);
  adapter.start({});
  adapter.sendTurn('write a novel');
  streams[0].h.onDelta('Chapter 1');
  streams[0].h.onDone({ finishReason: 'length' });
  const notice = events.find(e => e.ev === 'notice');
  assert.match(notice.payload.text, /truncated.*context limit/i);
  const done = events.find(e => e.ev === 'turn-complete');
  assert.deepEqual(done.payload, { text: 'Chapter 1', error: null });
});

test('interrupt destroys the stream and settles the turn with the partial text', () => {
  const { adapter, streams, events } = makeAdapter(CFG);
  adapter.start({});
  adapter.sendTurn('go');
  streams[0].h.onDelta('part');
  assert.equal(adapter.interrupt(), true);
  assert.equal(streams[0].destroyed, true);
  const done = events.find(e => e.ev === 'turn-complete');
  assert.deepEqual(done.payload, { text: 'part', error: null });
  assert.equal(adapter.sendTurn('next'), true);               // adapter is free again
  assert.deepEqual(streams[1].body.messages.slice(-2), [
    { role: 'assistant', content: 'part' },                   // partial kept as context
    { role: 'user', content: 'next' },
  ]);
});

test('no model anywhere: the turn is accepted but fails with a wording that names the fix', async () => {
  const { adapter, events } = makeAdapter({ url: 'http://box:3000', apiKey: '', model: '' });
  adapter.start({});
  assert.equal(adapter.sendTurn('hi'), true);
  await tick();
  const done = events.find(e => e.ev === 'turn-complete');
  assert.match(done.payload.error, /no Open WebUI model set/);
});

test('stop clears the session; a fresh start is a fresh conversation', () => {
  const { adapter, streams } = makeAdapter(CFG);
  adapter.start({});
  adapter.sendTurn('hello');
  streams[0].h.onDelta('x');
  adapter.stop();
  assert.equal(streams[0].destroyed, true);
  assert.equal(adapter.isRunning(), false);
  assert.equal(adapter.sessionId(), null);
  adapter.start({});
  adapter.sendTurn('new world');
  assert.deepEqual(streams[1].body.messages, [{ role: 'user', content: 'new world' }]);
});
