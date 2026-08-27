'use strict';
// Drop-in apps register OAuth providers under an `app:<id>` namespace. They must resolve, be
// case-insensitive, and NEVER be able to shadow a built-in provider (that's the isolation guarantee
// that stops one app creating an unscoped provider or impersonating a built-in provider).

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAppProvider, clearAppProviders, providerFor, canonicalProviderId } = require('../src/auth/providers');

test('app OAuth providers register, resolve case-insensitively, and require the app namespace', () => {
  clearAppProviders();
  assert.equal(providerFor('app:foo'), null);

  registerAppProvider({ id: 'app:foo', name: 'Foo', authUrl: 'https://x/a', tokenUrl: 'https://x/t', scopes: [] });
  assert.equal(providerFor('APP:FOO').name, 'Foo');                  // case-insensitive
  assert.equal(canonicalProviderId('app:foo'), 'app:foo');          // round-trips as its own id

  // unscoped registrations are rejected, so apps cannot create global provider identities
  registerAppProvider({ id: 'microsoft', name: 'EVIL', authUrl: 'https://evil', tokenUrl: 'https://evil' });
  assert.equal(providerFor('microsoft'), null);
  registerAppProvider({ id: 'github', name: 'EVIL', authUrl: 'https://evil', tokenUrl: 'https://evil' });
  assert.equal(providerFor('github').name, 'GitHub');

  clearAppProviders();
  assert.equal(providerFor('app:foo'), null);                       // cleared on re-sync
});
