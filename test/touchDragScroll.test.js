'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const touchDragScroll = require('../app/touchDragScroll');

function fakeElement() {
  const handlers = {};
  return {
    scrollTop: 120,
    captured: [],
    released: [],
    handlers,
    addEventListener(name, handler, capture) { handlers[name + (capture ? ':capture' : '')] = handler; },
    removeEventListener(name, handler, capture) {
      const key = name + (capture ? ':capture' : '');
      if (handlers[key] === handler) delete handlers[key];
    },
    setPointerCapture(id) { this.captured.push(id); },
    releasePointerCapture(id) { this.released.push(id); },
  };
}

test('touch drag scrolls the list and suppresses the row click', () => {
  const element = fakeElement();
  const detach = touchDragScroll.attach(element);
  let prevented = 0, stopped = 0;

  element.handlers.pointerdown({ pointerType: 'touch', isPrimary: true, pointerId: 3, clientY: 200 });
  assert.deepEqual(element.captured, []);
  element.handlers.pointermove({ pointerId: 3, clientY: 150, cancelable: true, preventDefault() { prevented += 1; } });
  element.handlers.pointerup({ pointerId: 3 });
  element.handlers['click:capture']({ preventDefault() { prevented += 1; }, stopImmediatePropagation() { stopped += 1; } });

  assert.equal(element.scrollTop, 170);
  assert.deepEqual(element.captured, [3]);
  assert.deepEqual(element.released, [3]);
  assert.equal(prevented, 2);
  assert.equal(stopped, 1);
  detach();
  assert.deepEqual(element.handlers, {});
});

test('mouse-compatible primary pointer drag also scrolls and suppresses its click', () => {
  const element = fakeElement();
  touchDragScroll.attach(element);
  let prevented = 0, stopped = 0;

  element.handlers.pointerdown({ pointerType: 'mouse', isPrimary: true, button: 0, pointerId: 5, clientY: 200 });
  assert.deepEqual(element.captured, []);
  element.handlers.pointermove({ pointerId: 5, clientY: 100, cancelable: true, preventDefault() { prevented += 1; } });
  element.handlers.pointerup({ pointerId: 5 });
  element.handlers['click:capture']({ preventDefault() { prevented += 1; }, stopImmediatePropagation() { stopped += 1; } });

  assert.equal(element.scrollTop, 220);
  assert.equal(prevented, 2);
  assert.equal(stopped, 1);
});

test('short taps and non-primary pointer buttons retain normal behaviour', () => {
  const element = fakeElement();
  touchDragScroll.attach(element);
  let stopped = 0;

  element.handlers.pointerdown({ pointerType: 'touch', isPrimary: true, pointerId: 4, clientY: 200 });
  element.handlers.pointermove({ pointerId: 4, clientY: 196, cancelable: true, preventDefault() {} });
  element.handlers.pointerup({ pointerId: 4 });
  element.handlers['click:capture']({ preventDefault() {}, stopImmediatePropagation() { stopped += 1; } });
  assert.equal(element.scrollTop, 120);
  assert.deepEqual(element.captured, []);
  assert.equal(stopped, 0);

  element.handlers.pointerdown({ pointerType: 'mouse', isPrimary: true, button: 2, pointerId: 6, clientY: 200 });
  element.handlers.pointermove({ pointerId: 6, clientY: 100, cancelable: true, preventDefault() {} });
  assert.equal(element.scrollTop, 120);
});

test('an abandoned pointer cannot leave scrolling or click suppression stuck', () => {
  const element = fakeElement();
  touchDragScroll.attach(element);
  let stopped = 0;

  element.handlers.pointerdown({ pointerType:'mouse', isPrimary:true, button:0, pointerId:7, clientY:200 });
  element.handlers.pointerleave({ pointerId:7 });
  element.handlers.pointermove({ pointerId:7, clientY:100, cancelable:true, preventDefault() {} });
  element.handlers.pointerup({ pointerId:7 });
  element.handlers['click:capture']({ preventDefault() {}, stopImmediatePropagation() { stopped += 1; } });
  assert.equal(element.scrollTop,120);
  assert.equal(stopped,0);

  element.handlers.pointerdown({ pointerType:'touch', isPrimary:true, pointerId:8, clientY:200 });
  element.handlers.pointermove({ pointerId:8, clientY:150, cancelable:true, preventDefault() {} });
  element.handlers.lostpointercapture({ pointerId:8 });
  element.handlers.pointermove({ pointerId:8, clientY:100, cancelable:true, preventDefault() {} });
  element.handlers.pointerup({ pointerId:8 });
  element.handlers['click:capture']({ preventDefault() {}, stopImmediatePropagation() { stopped += 1; } });
  assert.equal(element.scrollTop,170);
  assert.equal(stopped,0);
});
