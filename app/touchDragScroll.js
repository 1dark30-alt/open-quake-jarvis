'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TouchDragScroll = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function attach(element, options) {
    options = options || {};
    const threshold = Number.isFinite(options.threshold) ? Math.max(0, options.threshold) : 8;
    let gesture = null;
    let suppressClick = false;
    let clearSuppression = null;

    function canStartDrag(event) {
      return event.isPrimary !== false && (event.button === undefined || event.button === 0);
    }

    function onPointerDown(event) {
      if (!canStartDrag(event)) return;
      gesture = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startScrollTop: element.scrollTop,
        dragged: false,
      };
    }

    function onPointerMove(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const delta = event.clientY - gesture.startY;
      if (!gesture.dragged && Math.abs(delta) < threshold) return;
      if (!gesture.dragged) {
        gesture.dragged = true;
        try { element.setPointerCapture(event.pointerId); } catch (error) {}
      }
      element.scrollTop = gesture.startScrollTop - delta;
      if (event.cancelable) event.preventDefault();
    }

    function abandon(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gesture = null;
    }

    function onPointerLeave(event) {
      if (gesture && !gesture.dragged) abandon(event);
    }

    function finish(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (gesture.dragged) {
        suppressClick = true;
        clearTimeout(clearSuppression);
        clearSuppression = setTimeout(() => { suppressClick = false; }, 0);
      }
      try { element.releasePointerCapture(event.pointerId); } catch (error) {}
      gesture = null;
    }

    function onClick(event) {
      if (!suppressClick) return;
      suppressClick = false;
      clearTimeout(clearSuppression);
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('pointerleave', onPointerLeave);
    element.addEventListener('lostpointercapture', abandon);
    element.addEventListener('click', onClick, true);

    return function detach() {
      clearTimeout(clearSuppression);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      element.removeEventListener('pointerleave', onPointerLeave);
      element.removeEventListener('lostpointercapture', abandon);
      element.removeEventListener('click', onClick, true);
    };
  }

  return { attach };
});
