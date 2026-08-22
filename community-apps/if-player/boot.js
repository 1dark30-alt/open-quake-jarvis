'use strict';
// Runs after Parchment's own options assignment and BEFORE its main bundle, so it can finish
// configuring the interpreter before launch. vendor-parchment.js injects the <script> tag in that
// exact slot.
//
// Why this is needed: open-quake hands app options in as a ?query, so `story` arrives as a bare
// filename. Parchment derives a story title with /([/=])([^/=]+)$/.exec(path)[2], which throws on a
// name containing no "/" or "=" -- so the filename has to become a real URL before launch. Setting
// `story` here also settles the theme up front, avoiding a flash of Parchment's light default.
(function () {
  var o = window.parchment_options = window.parchment_options || {};
  var q = new URLSearchParams(location.search);
  var story = (q.get('story') || '').trim();

  o.autoplay = 1;
  o.do_vm_autosave = 1;                                   // resume in place if the panel reloads
  o.theme = q.get('_dark') === '0' ? 'light' : 'dark';
  // vendor-parchment.js extracted the interpreter cores out of the page into real files, so point
  // Parchment's loader at them. Without this it falls back to import.meta.url and 404s.
  o.lib_path = new URL('interpreter/', location.href).href;
  delete o.single_file;

  if (story) {
    // A bare filename means the app's stories/ folder; anything with a scheme is used as-is.
    var url = /^https?:\/\//i.test(story)
      ? story
      : new URL('stories/' + encodeURIComponent(story.split(/[\\/]/).pop()), location.href).href;
    o.story = { url: url };
  }
})();
