'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PhotoStripSlideshow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function shuffledIndexes(length, random) {
    const indexes = Array.from({ length }, (_, index) => index);
    const nextRandom = typeof random === 'function' ? random : Math.random;
    for (let index = indexes.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(nextRandom() * (index + 1));
      [indexes[index], indexes[swap]] = [indexes[swap], indexes[index]];
    }
    return indexes;
  }

  class SlideshowController {
    constructor(options) {
      const opts = options || {};
      this.intervalMs = Math.max(1000, Number(opts.intervalMs) || 15000);
      this.shuffle = !!opts.shuffle;
      this.random = typeof opts.random === 'function' ? opts.random : Math.random;
      this.setTimer = opts.setTimer || ((callback, delay) => setTimeout(callback, delay));
      this.clearTimer = opts.clearTimer || (timer => clearTimeout(timer));
      this.onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};
      this.items = [];
      this.order = [];
      this.position = 0;
      this.paused = false;
      this.visible = true;
      this.timer = null;
      this.disposed = false;
    }

    setItems(items) {
      this.items = Array.isArray(items) ? items.slice() : [];
      this.order = this.shuffle
        ? shuffledIndexes(this.items.length, this.random)
        : Array.from({ length: this.items.length }, (_, index) => index);
      this.position = 0;
      this._notify(0);
      this._arm();
    }

    setInterval(intervalMs) {
      this.intervalMs = Math.max(1000, Number(intervalMs) || this.intervalMs);
      this._arm();
    }

    setPaused(paused) {
      this.paused = !!paused;
      this._arm();
    }

    setVisible(visible) {
      this.visible = !!visible;
      this._arm();
    }

    currentIndex() {
      return this.order.length ? this.order[this.position] : -1;
    }

    relativeIndex(offset) {
      if (!this.order.length) return -1;
      const position = (this.position + offset % this.order.length + this.order.length) % this.order.length;
      return this.order[position];
    }

    next() {
      return this._move(1);
    }

    previous() {
      return this._move(-1);
    }

    dispose() {
      this.disposed = true;
      this._clear();
      this.items = [];
      this.order = [];
    }

    _move(direction) {
      if (!this.order.length || this.disposed) return -1;
      this.position = (this.position + direction + this.order.length) % this.order.length;
      this._notify(direction);
      this._arm();
      return this.currentIndex();
    }

    _notify(direction) {
      const index = this.currentIndex();
      if (index >= 0) this.onChange(index, direction);
    }

    _clear() {
      if (this.timer !== null) this.clearTimer(this.timer);
      this.timer = null;
    }

    _arm() {
      this._clear();
      if (this.disposed || this.paused || !this.visible || this.order.length < 2) return;
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.next();
      }, this.intervalMs);
    }
  }

  return { SlideshowController, shuffledIndexes };
});
