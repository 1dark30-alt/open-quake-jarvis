'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OAuthHandler } = require('../src/auth/oauth-handler');
const { TokenStorage } = require('../src/auth/token-storage');

function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) }; }

test('GitHub device flow sends a public client id and scopes without a client secret', async () => {
  let now = 1000;
  const calls = [];
  const opened = [];
  let stored = null;
  const handler = new OAuthHandler({
    storage: {
      getProviderSettings: () => ({ clientId: 'Iv1.synthetic' }),
      setTokens: (_provider, value) => { stored = value; },
      getTokens: () => stored,
    },
    openExternal: async url => { opened.push(url); return true; },
    now: () => now,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: String(options.body) });
      if (url.endsWith('/device/code')) return response({ device_code: 'device-secret-value', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      return response({ access_token: 'gho_synthetic', token_type: 'bearer', scope: 'repo', expires_in: 28800, refresh_token: 'ghr_synthetic', refresh_token_expires_in: 15897600 });
    },
  });

  const started = await handler.beginDeviceFlow('github', ['repo', 'offline_access']);
  assert.equal(started.userCode, 'ABCD-EFGH');
  assert.deepEqual(opened, ['https://github.com/login/device']);
  assert.match(calls[0].body, /client_id=Iv1.synthetic/);
  assert.match(calls[0].body, /scope=repo\+offline_access/);
  assert.doesNotMatch(calls[0].body, /secret/i);

  const early = await handler.pollDeviceFlow('github');
  assert.equal(early.pending, true);
  assert.equal(calls.length, 1);
  now += 5000;
  const completed = await handler.pollDeviceFlow('github');
  assert.equal(completed.connected, true);
  assert.match(calls[1].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
  assert.doesNotMatch(calls[1].body, /client_secret/);
  assert.equal(stored.accessToken, 'gho_synthetic');
  assert.equal(stored.refreshToken, 'ghr_synthetic');
  assert.equal(stored.authFlow, 'device');
  handler.stop();
});

test('a failed browser launch discards the pending GitHub device code', async () => {
  const handler = new OAuthHandler({
    storage: { getProviderSettings: () => ({ clientId: 'Iv1.synthetic' }) },
    openExternal: async () => false,
    fetchImpl: async () => response({ device_code: 'device-secret-value', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }),
  });
  await assert.rejects(handler.beginDeviceFlow('github', ['repo', 'offline_access']), /Could not open/);
  assert.equal((await handler.pollDeviceFlow('github')).code, 'device_flow_not_started');
  handler.stop();
});

test('GitHub device refresh omits client secret and scope, while access-only tokens remain usable', async () => {
  let stored = { provider: 'github', accessToken: 'gho_expired', refreshToken: 'ghr_old', expiresAt: 1, scope: 'repo', authFlow: 'device' };
  let payload = null;
  const handler = new OAuthHandler({
    storage: {
      getProviderSettings: () => ({ clientId: 'Iv1.synthetic', clientSecret: 'must-not-send' }),
      getTokens: () => Object.assign({}, stored),
      setTokens: (_provider, value) => { stored = value; },
    },
    openExternal: () => true,
  });
  handler.fetchToken = async (_provider, value) => { payload = value; return { access_token: 'gho_new', refresh_token: 'ghr_new', expires_in: 3600, scope: 'repo' }; };
  const token = await handler.getValidAccessToken('github', ['repo']);
  assert.equal(token.accessToken, 'gho_new');
  assert.equal(payload.client_secret, undefined);
  assert.equal(payload.scope, undefined);

  stored = { provider: 'github', accessToken: 'gho_long_lived', refreshToken: '', expiresAt: null, scope: 'repo', authFlow: 'device' };
  const longLived = await handler.getValidAccessToken('github', ['repo']);
  assert.equal(longLived.accessToken, 'gho_long_lived');
  handler.stop();
});

test('token storage treats access-only GitHub OAuth tokens as connected', () => {
  const config = { settings: { oauth: { providers: { github: { clientId: 'Iv1.synthetic' } }, tokens: { github: { accessToken: 'gho_synthetic', scope: 'repo,offline_access' } } } } };
  const storage = new TokenStorage({ getConfig: () => config, saveConfig: () => true });
  const status = storage.status('github');
  assert.equal(status.connected, true);
  assert.deepEqual(status.scopes, ['repo', 'offline_access']);
});
