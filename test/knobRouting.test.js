'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KNOB_DEFAULT, knobDefaultFor, parseCustomRing } = require('../app/knobRouting');

test('knobDefaultFor routes all gestures to the app only for a knob-declaring app page', () => {
  const appDef = { id: 'deck-host', knob: true };
  assert.deepEqual(knobDefaultFor({ kind: 'app', app: 'deck-host' }, appDef), { turn: 'app', click: 'app', dblclick: 'app' });
  assert.deepEqual(knobDefaultFor({ kind: 'app', app: 'clock' }, { id: 'clock' }), KNOB_DEFAULT);          // no flag
  assert.deepEqual(knobDefaultFor({ kind: 'app', app: 'x' }, { id: 'x', knob: 'yes' }), KNOB_DEFAULT);      // must be === true
  assert.deepEqual(knobDefaultFor({ kind: 'web' }, appDef), KNOB_DEFAULT);                                  // not an app page
  assert.deepEqual(knobDefaultFor({ kind: 'app', app: 'gone' }, null), KNOB_DEFAULT);                       // app not found
});

test('parseCustomRing accepts a full custom payload with clamping', () => {
  assert.deepEqual(parseCustomRing('custom:{"hue":10,"sat":20,"effect":5,"speed":40}'),
    { hue: 10, sat: 20, effect: 5, speed: 40 });
  assert.deepEqual(parseCustomRing('custom:{"hue":999,"sat":-4,"effect":99,"speed":255.6}'),
    { hue: 255, sat: 0, effect: 43, speed: 255 });   // clamped to hardware ranges
});

test('parseCustomRing fills defaults for missing/invalid fields', () => {
  assert.deepEqual(parseCustomRing('custom:{}'), { hue: 128, sat: 255, effect: 1, speed: 128 });
  assert.deepEqual(parseCustomRing('custom:{"hue":"red"}'), { hue: 128, sat: 255, effect: 1, speed: 128 });
  assert.equal(parseCustomRing('custom:{"effect":0}').effect, 0);   // All Off is a legal id
});

test('parseCustomRing rejects everything malformed', () => {
  assert.equal(parseCustomRing('custom:not json'), null);
  assert.equal(parseCustomRing('custom:[1,2]'), null);
  assert.equal(parseCustomRing('custom:null'), null);
  assert.equal(parseCustomRing('listening'), null);      // named states are not custom
  assert.equal(parseCustomRing(''), null);
  assert.equal(parseCustomRing(null), null);
  assert.equal(parseCustomRing({ hue: 1 }), null);       // must be the string protocol form
});
