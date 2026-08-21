'use strict';
// obsService: connection lifecycle, snapshot hydration from OBS, event-driven snapshot updates,
// reconnect scheduling, and command routing -- all against a fake obs-websocket client (no real OBS).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { ObsService } = require('../app/obsService');

// A stand-in for an obs-websocket-js client: records command calls, answers hydration requests from a
// model, and lets a test emit OBS events. It's an EventEmitter so obs.on(...) / .off(...) just work.
class FakeObs extends EventEmitter {
  constructor(model) { super(); this.model = model || {}; this.calls = []; this.connectArgs = null; this.disconnected = false; }
  async connect(url, password, opts) {
    this.connectArgs = { url, password, opts };
    if (this.model.failConnect) throw Object.assign(new Error(this.model.failConnect), { code: this.model.failCode });
    return { obsWebSocketVersion: '5.7.3', negotiatedRpcVersion: 1 };
  }
  async call(request, data) {
    this.calls.push({ request, data });
    const r = (this.model.responses || {})[request];
    if (r === undefined) return {};
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(data) : r;
  }
  async disconnect() { this.disconnected = true; }
}

const MODEL = {
  responses: {
    GetStudioModeEnabled: { studioModeEnabled: false },
    GetSceneList: { scenes: [{ sceneName: 'Camera' }, { sceneName: 'Game' }], currentProgramSceneName: 'Camera', currentPreviewSceneName: null },
    GetStreamStatus: { outputActive: false },
    GetRecordStatus: { outputActive: false, outputPaused: false },
    GetReplayBufferStatus: { outputActive: false },
    GetInputList: { inputs: [{ inputName: 'Mic' }, { inputName: 'Desktop Audio' }, { inputName: 'Camera' }] },
    GetInputMute: data => { if (data.inputName === 'Camera') throw new Error('not an audio input'); return { inputMuted: data.inputName === 'Mic' }; },
  },
};

const flush = () => new Promise(r => setTimeout(r, 15));

test('connect hydrates the snapshot from OBS', async () => {
  const fake = new FakeObs(MODEL);
  const obs = new ObsService({ clientFactory: () => fake });
  obs.start();
  await flush();
  const s = obs.getSnapshot();
  assert.equal(s.connection, 'connected');
  assert.equal(s.obsVersion, '5.7.3');
  assert.deepEqual(s.scenes, ['Camera', 'Game']);
  assert.equal(s.programScene, 'Camera');
  assert.equal(s.studioMode, false);
  assert.equal(s.streaming.active, false);
  assert.deepEqual(s.inputs, [{ name: 'Mic', muted: true }, { name: 'Desktop Audio', muted: false }]);   // Camera skipped (non-audio)
  assert.equal(fake.connectArgs.url, 'ws://127.0.0.1:4455');
});

test('OBS events update the snapshot and emit update', async () => {
  const fake = new FakeObs(MODEL);
  const obs = new ObsService({ clientFactory: () => fake });
  obs.start(); await flush();
  let last = null; obs.on('update', s => { last = s; });

  fake.emit('CurrentProgramSceneChanged', { sceneName: 'Game' });
  assert.equal(obs.getSnapshot().programScene, 'Game');
  assert.equal(last.programScene, 'Game');

  fake.emit('StudioModeStateChanged', { studioModeEnabled: true });
  fake.emit('CurrentPreviewSceneChanged', { sceneName: 'Camera' });
  assert.equal(obs.getSnapshot().studioMode, true);
  assert.equal(obs.getSnapshot().previewScene, 'Camera');

  fake.emit('StreamStateChanged', { outputActive: true });
  fake.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_PAUSED' });
  assert.equal(obs.getSnapshot().streaming.active, true);
  assert.deepEqual(obs.getSnapshot().recording, { active: true, paused: true });

  fake.emit('InputMuteStateChanged', { inputName: 'Mic', inputMuted: false });
  assert.equal(obs.getSnapshot().inputs.find(i => i.name === 'Mic').muted, false);
});

test('a dropped connection goes reconnecting and schedules a backoff retry', async () => {
  const fake = new FakeObs(MODEL);
  const timers = [];
  const obs = new ObsService({ clientFactory: () => fake, setTimer: (fn, d) => { timers.push({ fn, d }); return timers.length; }, clearTimer: () => {} });
  obs.start(); await flush();
  assert.equal(obs.getSnapshot().connection, 'connected');

  let scheduled = null; obs.on('reconnect-scheduled', e => { scheduled = e; });
  fake.emit('ConnectionClosed', new Error('socket dropped'));
  assert.equal(obs.getSnapshot().connection, 'reconnecting');
  assert.ok(scheduled);
  assert.equal(scheduled.delay, 1000);   // first backoff step
  assert.equal(timers.length, 1);
});

test('a refused connection is reported as not-running, not a hard error', async () => {
  const fake = new FakeObs({ failConnect: 'connect ECONNREFUSED 127.0.0.1:4455' });
  const obs = new ObsService({ clientFactory: () => fake, setTimer: () => 1, clearTimer: () => {} });
  obs.start(); await flush();
  assert.equal(obs.getSnapshot().connection, 'not-running');
});

test('command methods issue the exact OBS request, and reject when disconnected', async () => {
  const fake = new FakeObs(MODEL);
  const obs = new ObsService({ clientFactory: () => fake });

  await assert.rejects(() => obs.setProgramScene('X'), /not connected/i);   // before connect

  obs.start(); await flush();
  fake.calls.length = 0;   // drop hydration calls
  await obs.setProgramScene('Game');
  await obs.setInputMute('Mic', true);
  await obs.startStream();
  assert.deepEqual(fake.calls, [
    { request: 'SetCurrentProgramScene', data: { sceneName: 'Game' } },
    { request: 'SetInputMute', data: { inputName: 'Mic', inputMuted: true } },
    { request: 'StartStream', data: undefined },
  ]);
});

test('configure re-dials only when the url/password actually change', async () => {
  const fakes = [];
  const obs = new ObsService({ clientFactory: () => { const f = new FakeObs(MODEL); fakes.push(f); return f; } });
  obs.start(); await flush();
  assert.equal(fakes.length, 1);

  obs.configure({ url: 'ws://127.0.0.1:4455' });   // no change
  await flush();
  assert.equal(fakes.length, 1);

  obs.configure({ url: 'ws://10.0.0.5:4455', password: 'pw' });   // changed -> re-dial
  await flush();
  assert.equal(fakes.length, 2);
  assert.equal(obs.url, 'ws://10.0.0.5:4455');
  assert.equal(fakes[0].disconnected, true);
  assert.equal(fakes[1].connectArgs.url, 'ws://10.0.0.5:4455');
  assert.equal(fakes[1].connectArgs.password, 'pw');
});

test('stop() disconnects and clears live state', async () => {
  const fake = new FakeObs(MODEL);
  const obs = new ObsService({ clientFactory: () => fake });
  obs.start(); await flush();
  obs.stop();
  const s = obs.getSnapshot();
  assert.equal(s.connection, 'disconnected');
  assert.deepEqual(s.scenes, []);
  assert.equal(s.programScene, null);
  assert.equal(fake.disconnected, true);
});

test('action() dispatches studio-aware scene taps and named commands', async () => {
  const fake = new FakeObs(MODEL);
  const obs = new ObsService({ clientFactory: () => fake });
  obs.start(); await flush();
  fake.calls.length = 0;

  await obs.action('sceneTap', 'Game');   // studio off -> Program
  assert.deepEqual(fake.calls.at(-1), { request: 'SetCurrentProgramScene', data: { sceneName: 'Game' } });

  fake.emit('StudioModeStateChanged', { studioModeEnabled: true });
  await obs.action('sceneTap', 'Camera');   // studio on -> Preview
  assert.deepEqual(fake.calls.at(-1), { request: 'SetCurrentPreviewScene', data: { sceneName: 'Camera' } });

  await obs.action('toggleMute', 'Mic');
  assert.deepEqual(fake.calls.at(-1), { request: 'ToggleInputMute', data: { inputName: 'Mic' } });

  await assert.rejects(() => obs.action('bogus'), /Unknown OBS action/);
});

test('tile-editor action aliases (scene, mute) map to the same commands as the switcher', async () => {
  const fake = new FakeObs(MODEL);
  const obs = new ObsService({ clientFactory: () => fake });
  obs.start(); await flush();
  fake.calls.length = 0;
  await obs.action('scene', 'Game');   // studio off -> Program (alias for sceneTap)
  assert.deepEqual(fake.calls.at(-1), { request: 'SetCurrentProgramScene', data: { sceneName: 'Game' } });
  await obs.action('mute', 'Mic');     // alias for toggleMute
  assert.deepEqual(fake.calls.at(-1), { request: 'ToggleInputMute', data: { inputName: 'Mic' } });
});

test('panic() switches to the safe scene and mutes configured inputs, best-effort', async () => {
  const fake = new FakeObs(MODEL);
  const obs = new ObsService({ clientFactory: () => fake, getPanicConfig: () => ({ safeScene: 'BRB', muteInputs: ['Mic', 'Desktop Audio'] }) });
  obs.start(); await flush();
  fake.calls.length = 0;
  const r = await obs.panic();
  assert.equal(r.scene, true);
  assert.deepEqual(r.muted, ['Mic', 'Desktop Audio']);
  assert.deepEqual(fake.calls, [
    { request: 'SetCurrentProgramScene', data: { sceneName: 'BRB' } },
    { request: 'SetInputMute', data: { inputName: 'Mic', inputMuted: true } },
    { request: 'SetInputMute', data: { inputName: 'Desktop Audio', inputMuted: true } },
  ]);
});
