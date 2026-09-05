'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SlideshowController, shuffledIndexes } = require('./slideshow');

function withoutTimers(options) {
  return new SlideshowController(Object.assign({
    setTimer: () => 1,
    clearTimer: () => {},
  }, options || {}));
}

test('sequential next and previous navigation wraps in both directions', () => {
  const seen = [];
  const slideshow = withoutTimers({ onChange: (index, direction) => seen.push([index, direction]) });
  slideshow.setItems(['a', 'b', 'c']);
  assert.equal(slideshow.currentIndex(), 0);
  assert.equal(slideshow.next(), 1);
  assert.equal(slideshow.next(), 2);
  assert.equal(slideshow.next(), 0);
  assert.equal(slideshow.previous(), 2);
  assert.deepEqual(seen, [[0, 0], [1, 1], [2, 1], [0, 1], [2, -1]]);
});

test('relative indexes wrap for five-neighbour photo strip rendering', () => {
  const slideshow = withoutTimers();
  slideshow.setItems(['a', 'b', 'c']);
  assert.equal(slideshow.relativeIndex(-2), 1);
  assert.equal(slideshow.relativeIndex(-1), 2);
  assert.equal(slideshow.relativeIndex(0), 0);
  assert.equal(slideshow.relativeIndex(1), 1);
  assert.equal(slideshow.relativeIndex(2), 2);
});

test('shuffle order is deterministic with an injected random source', () => {
  const values = [0.1, 0.8, 0.3];
  const order = shuffledIndexes(4, () => values.shift());
  assert.deepEqual(order, [1, 3, 2, 0]);
  assert.deepEqual(order.slice().sort(), [0, 1, 2, 3]);
});

test('visibility, pause, and disposal always clean up slideshow timers', () => {
  let nextId = 0;
  const active = new Set();
  const cleared = [];
  const slideshow = new SlideshowController({
    intervalMs: 5000,
    setTimer: callback => {
      const id = ++nextId;
      active.add(id);
      return id;
    },
    clearTimer: id => {
      active.delete(id);
      cleared.push(id);
    },
  });
  slideshow.setItems(['a', 'b']);
  assert.equal(active.size, 1);
  slideshow.setVisible(false);
  assert.equal(active.size, 0);
  slideshow.setVisible(true);
  assert.equal(active.size, 1);
  slideshow.setPaused(true);
  assert.equal(active.size, 0);
  slideshow.setPaused(false);
  assert.equal(active.size, 1);
  slideshow.dispose();
  assert.equal(active.size, 0);
  assert.ok(cleared.length >= 3);
});

test('zero or one image never arms an automatic slideshow timer', () => {
  let armed = 0;
  const slideshow = new SlideshowController({ setTimer: () => { armed += 1; return armed; }, clearTimer: () => {} });
  slideshow.setItems([]);
  slideshow.setItems(['only']);
  assert.equal(armed, 0);
});

test('default browser-style timer functions are invoked through safe wrappers', () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const receiver = {};
  let active = null;
  global.setTimeout = function (callback, delay) {
    assert.equal(this, undefined);
    active = { callback, delay };
    return receiver;
  };
  global.clearTimeout = function (timer) {
    assert.equal(this, undefined);
    assert.equal(timer, receiver);
    active = null;
  };
  try {
    const slideshow = new SlideshowController({ intervalMs: 5000 });
    slideshow.setItems(['a', 'b']);
    assert.equal(active.delay, 5000);
    slideshow.dispose();
    assert.equal(active, null);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});
