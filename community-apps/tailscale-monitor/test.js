'use strict';
// ponytail self-check for the mapping logic. Run: node test.js
const assert = require('assert');
const { _test: { mapNode } } = require('./server.js');

const now = Date.parse('2026-08-26T12:00:00Z');
const status = { User: { 1: { LoginName: 'me@example.com' }, 2: { DisplayName: 'Other' } } };

const online = mapNode({ HostName: 'BOX', OS: 'linux', UserID: 1, Online: true,
  TailscaleIPs: ['100.1.1.1', 'fd7a::1'], ExitNodeOption: true }, status, false, now);
assert.strictEqual(online.online, true);
assert.strictEqual(online.owner, 'me@example.com');
assert.strictEqual(online.ipv4, '100.1.1.1');       // v4 picked over v6
assert.strictEqual(online.addresses.length, 2);
assert.strictEqual(online.exitNodeOption, true);
assert.strictEqual(online.exitNode, false);

const off = mapNode({ HostName: 'NAS', OS: 'linux', UserID: 2, Online: false,
  LastSeen: '2026-08-24T23:56:58Z', TailscaleIPs: ['100.2.2.2'] }, status, false, now);
assert.strictEqual(off.online, false);
assert.strictEqual(off.owner, 'Other');              // falls back to DisplayName
assert.ok(off.lastSeen && off.lastSeen < now);

// self flag + expired key
const self = mapNode({ HostName: 'ME', OS: 'windows', UserID: 1, Online: true,
  TailscaleIPs: ['100.3.3.3'], KeyExpiry: '2026-08-01T00:00:00Z' }, status, true, now);
assert.strictEqual(self.self, true);
assert.strictEqual(self.expired, true);

// name falls back to DNSName's first label; missing owner is empty string
const bare = mapNode({ DNSName: 'foo.tail1234.ts.net.', OS: 'linux', UserID: 99, TailscaleIPs: [] }, status, false, now);
assert.strictEqual(bare.name, 'foo');
assert.strictEqual(bare.owner, '');
assert.strictEqual(bare.ipv4, '');

// connection fields: direct endpoint wins, relay falls back, empty -> null
const direct = mapNode({ HostName: 'g', CurAddr: '1.2.3.4:41641', Relay: 'lax', RxBytes: 100, TxBytes: 50 }, status, false, now);
assert.strictEqual(direct.direct, '1.2.3.4:41641');
assert.strictEqual(direct.relay, 'lax');
assert.strictEqual(direct.rxBytes, 100);
const relayed = mapNode({ HostName: 'h', CurAddr: '', Relay: 'den' }, status, false, now);
assert.strictEqual(relayed.direct, null);
assert.strictEqual(relayed.relay, 'den');

console.log('ok — all mapNode checks passed');
