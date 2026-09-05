'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const sysserver = require('../app/sysserver');
const { configForRenderer } = require('../app/oauthConfigBoundary');
const { OAuthHandler } = require('../src/auth/oauth-handler');
const { TokenStorage } = require('../src/auth/token-storage');
const { clearAppProviders, providerFor, registerAppProvider } = require('../src/auth/providers');

const OFFICE_CLIENT_ID = '1b171d2e-040f-4e4c-b841-dbb1eb8023c7';
const OFFICE_SCOPES = ['User.Read', 'Presence.Read', 'Calendars.Read', 'offline_access'];

function request(port, target, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: target, headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function officeHeaders(port) {
  return {
    'Sec-Fetch-Site': 'same-origin',
    Referer: 'http://127.0.0.1:' + port + '/apps/office/index.html',
  };
}

test.afterEach(() => {
  sysserver.stop();
  clearAppProviders();
});

test('Office is app-scoped and no global Microsoft provider remains', async () => {
  const manifest = require('../community-apps/office/app.json');
  assert.equal(manifest.oauth.clientId, OFFICE_CLIENT_ID);
  assert.deepEqual(manifest.oauth.scopes, OFFICE_SCOPES);
  assert.equal(require('../apps/apps.json').some(app => app.id === 'office'), false);
  registerAppProvider({
    id: 'app:office', name: 'Microsoft 365', clientId: OFFICE_CLIENT_ID,
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: OFFICE_SCOPES, redirectUri: 'http://localhost:5173/oauth/callback', usesPkce: true,
  });
  const handler = new OAuthHandler({
    storage: { getProviderSettings: () => ({}), getTokens: () => null },
    openExternal: () => true,
  });

  const url = new URL(await handler.generateAuthUrl('app:office', OFFICE_SCOPES));
  assert.equal(providerFor('microsoft'), null);
  assert.equal(providerFor('app:office').clientId, OFFICE_CLIENT_ID);
  assert.equal(url.searchParams.get('client_id'), OFFICE_CLIENT_ID);
  assert.deepEqual(url.searchParams.get('scope').split(' '), OFFICE_SCOPES);
});

test('app-scoped OAuth is managed from the drop-in app editor, not global Microsoft settings', () => {
  const configSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'config.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'config-preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');

  assert.match(configSource, /def && def\.oauth \? '<div id="appOAuth"><\/div>'/);
  assert.match(configSource, /appendDropInOAuthSetup[\s\S]*getAppOAuthStatus\(def\.id\)[\s\S]*connectAppOAuth\(def\.id\)[\s\S]*disconnectAppOAuth\(def\.id\)/);
  assert.match(preloadSource, /getAppOAuthStatus[\s\S]*connectAppOAuth[\s\S]*disconnectAppOAuth/);
  assert.match(mainSource, /ipcMain\.handle\('getAppOAuthStatus'[\s\S]*ipcMain\.handle\('connectAppOAuth'[\s\S]*ipcMain\.handle\('disconnectAppOAuth'/);
  assert.match(mainSource, /dropInOAuth\.connect\(def\.id, Array\.isArray\(def\.oauth\.scopes\)/);
  assert.doesNotMatch(configSource, /connectOAuthProvider\('microsoft'/);
});

test('Office drop-in server receives OAuth already bound to its requesting app', async () => {
  const calls = [];
  const opened = [];
  const officeRoot = path.join(__dirname, '..', 'community-apps', 'office');
  const port = await sysserver.start({
    appFolders: { office: { root: officeRoot, server: path.join(officeRoot, 'server.js') } },
    getAppConfig: appId => appId === 'office' ? { app: 'office', options: {} } : null,
    oauth: {
      status: appId => ({ ok: true, provider: 'app:' + appId, configured: true, connected: false, scopes: [] }),
      connect: (appId, scopes) => { calls.push({ appId, scopes }); return { ok: true }; },
      disconnect: () => ({ ok: true }),
      getAccessToken: () => null,
    },
    appHost: {
      openExternal: value => { opened.push(value); return true; },
      launchApp: () => false,
      focusTeams: () => ({ ok: false }),
      focusApp: () => ({ ok: false }),
      hasAppWindow: () => ({ ok: false }),
      tapCombo: () => false,
    },
  });

  const connected = await request(port, '/app-api/connect', officeHeaders(port));
  assert.equal(connected.status, 200);
  assert.deepEqual(JSON.parse(connected.body), { ok: true });
  assert.deepEqual(calls, [{ appId: 'office', scopes: OFFICE_SCOPES }]);

  const status = await request(port, '/app-api/auth-status', officeHeaders(port));
  assert.equal(JSON.parse(status.body).provider, 'app:office');
  assert.doesNotMatch(status.body, /accessToken|refreshToken/);

  const allowed = await request(port, '/app-api/open?url=' + encodeURIComponent('https://www.office.com/'), officeHeaders(port));
  const rejected = await request(port, '/app-api/open?url=' + encodeURIComponent('https://example.com/'), officeHeaders(port));
  assert.equal(JSON.parse(allowed.body).ok, true);
  assert.equal(JSON.parse(rejected.body).ok, false);
  assert.deepEqual(opened, ['https://www.office.com/']);
});

test('legacy global Office HTTP routes are retired', async () => {
  const port = await sysserver.start({});
  for (const target of ['/office', '/api/office/data', '/api/office/connect', '/api/office/action/app/0']) {
    const response = await request(port, target, { 'Sec-Fetch-Site': 'same-origin' });
    assert.notEqual(response.status, 200, target);
  }
});

test('legacy global Microsoft tokens migrate once into the Office app namespace', () => {
  let saves = 0;
  const config = {
    settings: {
      oauth: {
        providers: { microsoft: { clientId: 'legacy', clientSecret: 'legacy-secret' } },
        tokens: { microsoft: { accessToken: 'old-access', refreshToken: 'old-refresh', scope: OFFICE_SCOPES.join(' ') } },
      },
    },
  };
  const storage = new TokenStorage({ getConfig: () => config, saveConfig: () => { saves += 1; return true; } });

  const migrated = storage.getTokens('app:office');
  assert.equal(migrated.provider, 'app:office');
  assert.equal(migrated.refreshToken, 'old-refresh');
  assert.equal(config.settings.oauth.tokens.microsoft, undefined);
  assert.equal(config.settings.oauth.providers.microsoft, undefined);
  assert.equal(saves, 1);
});

test('renderer configuration omits all OAuth tokens and provider secrets', () => {
  const stored = {
    settings: {
      oauth: {
        providers: { 'app:office': { clientId: OFFICE_CLIENT_ID, clientSecret: 'synthetic-secret' } },
        tokens: { 'app:office': { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' } },
      },
    },
    grids: [],
  };
  const dto = configForRenderer(stored);
  assert.deepEqual(dto.settings.oauth.tokens, {});
  assert.equal(dto.settings.oauth.providers['app:office'].clientId, OFFICE_CLIENT_ID);
  assert.equal(Object.hasOwn(dto.settings.oauth.providers['app:office'], 'clientSecret'), false);
  assert.equal(stored.settings.oauth.tokens['app:office'].refreshToken, 'synthetic-refresh');
});
