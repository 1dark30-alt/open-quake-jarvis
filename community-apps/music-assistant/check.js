'use strict';
// node community-apps/music-assistant/check.js — self-check of the pure helpers.
const assert = require('assert');
const MA = require('./ma-client.js');
const MAMock = require('./mock.js');

// wsUrl / baseUrl
assert.strictEqual(MA.wsUrl('http://192.168.1.25:8095'), 'ws://192.168.1.25:8095/ws');
assert.strictEqual(MA.wsUrl('https://music.example.com/'), 'wss://music.example.com/ws');
assert.strictEqual(MA.wsUrl('192.168.1.25:8095'), 'ws://192.168.1.25:8095/ws');
assert.strictEqual(MA.wsUrl('http://h:8095/ws'), 'ws://h:8095/ws');
assert.strictEqual(MA.wsUrl(''), '');
assert.strictEqual(MA.baseUrl('https://music.example.com/'), 'https://music.example.com');

// roundSize: whitelist {0,80,160,256,512,1024}, round UP, clamp
assert.strictEqual(MA.roundSize(0), 0);
assert.strictEqual(MA.roundSize(81), 160);
assert.strictEqual(MA.roundSize(160), 160);
assert.strictEqual(MA.roundSize(384), 512);
assert.strictEqual(MA.roundSize(1025), 1024);

// imageUrl
const proxied = MA.imageUrl('http://h:8095', { image: { proxy_id: 'abc123' } }, 300);
assert.strictEqual(proxied, 'http://h:8095/imageproxy/abc123?size=512&fmt=jpeg');
const remote = MA.imageUrl('http://h:8095', { metadata: { images: [{ type: 'thumb', path: 'https://img/x.jpg', remotely_accessible: true }] } }, 300);
assert.strictEqual(remote, 'https://img/x.jpg');
assert.strictEqual(MA.imageUrl('http://h:8095', {}, 300), '');

// mergeChunk: two partials + final resolve to one array
const pending = {};
assert.strictEqual(MA.mergeChunk(pending, { partial: true, result: [1, 2] }), null);
assert.strictEqual(MA.mergeChunk(pending, { partial: true, result: [3] }), null);
assert.deepStrictEqual(MA.mergeChunk(pending, { result: [4] }), [1, 2, 3, 4]);
assert.deepStrictEqual(MA.mergeChunk({}, { result: { a: 1 } }), { a: 1 });

// nextBackoff: 0→1000 doubling to a 15s cap
assert.strictEqual(MA.nextBackoff(0), 1000);
assert.strictEqual(MA.nextBackoff(1000), 2000);
assert.strictEqual(MA.nextBackoff(8000), 15000);
assert.strictEqual(MA.nextBackoff(15000), 15000);

// pickPlayer: default name → last used → first available
const players = [
  { player_id: 'a', display_name: 'Kitchen', available: false },
  { player_id: 'b', display_name: 'Living Room', available: true },
  { player_id: 'c', display_name: 'Office', available: true },
];
assert.strictEqual(MA.pickPlayer(players, 'office', null), 'c');
assert.strictEqual(MA.pickPlayer(players, 'kitchen', 'c'), 'c'); // kitchen unavailable → last used
assert.strictEqual(MA.pickPlayer(players, '', 'zz'), 'b');       // stale last-used → first available
assert.strictEqual(MA.pickPlayer([], '', null), null);

// formatDuration
assert.strictEqual(MA.formatDuration(65), '1:05');
assert.strictEqual(MA.formatDuration(3671), '1:01:11');
assert.strictEqual(MA.formatDuration(0), '0:00');

// mock/client surface parity
const real = ['connect', 'close', 'request', 'on', 'status'];
const mock = MAMock.create({});
for (const key of real) assert.ok(key in mock, 'mock missing ' + key);

console.log('music-assistant check: OK');
