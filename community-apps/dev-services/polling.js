'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DevServicesPolling = api;
}(typeof globalThis === 'object' ? globalThis : this, function createPolling() {
  class PollingController {
    constructor(options) {
      const opts = options || {};
      this.task = opts.task;
      this.intervalMs = opts.intervalMs;
      this.setTimer = opts.setTimer || setTimeout;
      this.clearTimer = opts.clearTimer || clearTimeout;
      this.running = false;
      this.visible = true;
      this.timer = null;
      this.inFlight = null;
    }

    start() {
      if (this.running) return this.inFlight;
      this.running = true;
      return this.trigger();
    }

    stop() {
      this.running = false;
      this.clearScheduled();
    }

    setVisible(visible) {
      const next = !!visible;
      if (this.visible === next) return;
      this.visible = next;
      this.clearScheduled();
      if (this.running && this.visible) this.trigger();
    }

    setInterval(intervalMs) {
      this.intervalMs = intervalMs;
      this.clearScheduled();
      if (this.running && this.visible && !this.inFlight) this.schedule();
    }

    clearScheduled() {
      if (this.timer != null) this.clearTimer(this.timer);
      this.timer = null;
    }

    schedule() {
      this.clearScheduled();
      if (!this.running || !this.visible) return;
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.trigger();
      }, this.intervalMs);
    }

    trigger() {
      if (!this.running || !this.visible) return this.inFlight;
      if (this.inFlight) return this.inFlight;
      this.clearScheduled();
      this.inFlight = Promise.resolve().then(() => this.task()).finally(() => {
        this.inFlight = null;
        this.schedule();
      });
      return this.inFlight;
    }
  }

  return { PollingController };
}));
