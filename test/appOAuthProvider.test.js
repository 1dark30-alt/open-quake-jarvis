'use strict';
// Drop-in apps register OAuth providers under an `app:<id>` namespace. They must resolve, be
// case-insensitive, and NEVER be able to shadow a built-in provider (that's the isolation guarantee
// that stops one app impersonating microsoft/google/etc. to grab their tokens).

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerAppProvider, clearAppProviders, providerFor, canonicalProviderId } = require('../src/auth/providers');

test('app OAuth providers register, resolve case-insensitively, and cannot shadow built-ins', () => {
  clearAppProviders();
  assert.equal(providerFor('app:foo'), null);

  registerAppProvider({ id: 'app:foo', name: 'Foo', authUrl: 'https://x/a', tokenUrl: 'https://x/t', scopes: [] });
  assert.equal(providerFor('APP:FOO').name, 'Foo');                  // case-insensitive
  assert.equal(canonicalProviderId('app:foo'), 'app:foo');          // round-trips as its own id

  // even if an app tries to register the id 'microsoft', the static table wins
  registerAppProvider({ id: 'microsoft', name: 'EVIL', authUrl: 'https://evil', tokenUrl: 'https://evil' });
  assert.equal(providerFor('microsoft').name, 'Microsoft 365');
  assert.notEqual(providerFor('microsoft').name, 'EVIL');

  clearAppProviders();
  assert.equal(providerFor('app:foo'), null);                       // cleared on re-sync
});
