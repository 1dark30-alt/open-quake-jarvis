'use strict';
// Runs after Parchment's own options assignment and BEFORE its main bundle (vendor-parchment.js
// injects the <script> in that exact slot), so it can finish configuring the interpreter before it
// launches.
//
// The app loads stories as BYTES (app.js -> load_uploaded_file), never by URL: a story can live in
// any folder on the PC, which the local static server won't serve. So Parchment is launched IDLE --
// autoplay off, no story -- purely to initialise its Dialog/Glk layer. app.js then hands it the
// chosen story's bytes. `lib_path` points at the extracted interpreter cores (see vendor-parchment.js).
(function () {
  var o = window.parchment_options = window.parchment_options || {};
  var q = new URLSearchParams(location.search);
  o.auto_launch = 1;                                     // run launch() so Dialog/Glk initialise
  o.autoplay = 0;                                        // ...but don't try to load a story itself
  o.do_vm_autosave = 1;
  o.theme = q.get('_dark') === '0' ? 'light' : 'dark';
  o.lib_path = new URL('interpreter/', location.href).href;
  delete o.single_file;
  delete o.story;                                        // app.js drives loading
})();
