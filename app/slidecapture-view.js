'use strict';
// slidecapture-view.js — logic for the hidden slide-capture page. No DOM UI.
//
// getDisplayMedia streams the window main picked (main's setDisplayMediaRequestHandler returns
// that source). Once a second we draw the current video frame to a small thumbnail canvas and
// ship its raw bytes + brightness stats to main, which runs the settle-detection engine. When
// main decides a slide should be saved (or the user hits Manual capture), it sends 'grab' and we
// return one full-resolution PNG of the current frame. All the diff/settle logic is in main so
// it stays in the unit-tested engine; this page is just the capture surface.

var THUMB_W = 384, THUMB_H = 216;   // must match slideCaptureEngine THUMB_W/THUMB_H
var POLL_MS = 1000;

var stream = null, video = null, timer = null;
var thumbCanvas = null, thumbCtx = null, fullCanvas = null, fullCtx = null;

function api() { return window.slideAPI; }

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} stream = null; }
  video = null;
}

// getDisplayMedia on a fabricated window source flakes on some apps (new Teams: NotReadableError
// "Could not start video source") but usually succeeds a moment later, so retry a few times before
// surfacing the error. Constraints are identical each attempt.
function acquire(tries) {
  return navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: { frameRate: { ideal: 2, max: 5 }, width: { max: 1920 }, height: { max: 1080 } },
  }).catch(function (err) {
    if (tries > 0) return new Promise(function (r) { setTimeout(r, 400); }).then(function () { return acquire(tries - 1); });
    throw err;
  });
}

function start(sourceId) {
  stop();
  acquire(3).then(function (s) {
    stream = s;
    video = document.createElement('video');
    video.srcObject = s;
    // If the shared window closes, getDisplayMedia ends the track — tell main so it can stop cleanly.
    s.getVideoTracks().forEach(function (t) { t.onended = function () { api().sendStatus('source-ended', ''); }; });
    return video.play();
  }).then(function () {
    if (!thumbCanvas) {
      thumbCanvas = document.createElement('canvas'); thumbCanvas.width = THUMB_W; thumbCanvas.height = THUMB_H;
      thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
      fullCanvas = document.createElement('canvas');
      fullCtx = fullCanvas.getContext('2d');
    }
    api().sendStatus('capturing', '');
    timer = setInterval(poll, POLL_MS);
  }).catch(function (err) {
    api().sendStatus('error', (err && (err.name + ': ' + err.message)) || 'getDisplayMedia failed');
  });
}

function poll() {
  if (!video || !video.videoWidth) return;
  thumbCtx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
  var img = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H);
  var d = img.data, sum = 0, nonBlack = 0, px = d.length / 4;
  for (var p = 0; p < d.length; p += 4) {
    var l = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    sum += l; if (l > 8) nonBlack++;
  }
  // Transfer the RGBA bytes to main (copied out of the ImageData's buffer).
  var buf = d.buffer.slice(0);
  api().sendThumb(buf, { meanLuma: sum / px, nonBlack: nonBlack / px });
}

// One full-resolution PNG of the current frame, for a save.
function grab() {
  if (!video || !video.videoWidth) { api().sendFrame(null); return; }
  fullCanvas.width = video.videoWidth; fullCanvas.height = video.videoHeight;
  fullCtx.drawImage(video, 0, 0);
  fullCanvas.toBlob(function (blob) {
    if (!blob) { api().sendFrame(null); return; }
    blob.arrayBuffer().then(function (ab) { api().sendFrame(ab); }).catch(function () { api().sendFrame(null); });
  }, 'image/png');
}

api().onCommand(function (msg) {
  if (!msg) return;
  if (msg.type === 'start') start(msg.sourceId);
  else if (msg.type === 'stop') { stop(); api().sendStatus('stopped', ''); }
  else if (msg.type === 'grab') grab();
});
api().ready();
