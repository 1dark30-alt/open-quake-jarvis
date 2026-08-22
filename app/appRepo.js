'use strict';
// Pure helpers for installing/updating drop-in apps from a repository. No electron/fs -- unit-tested
// in test/appRepo.test.js. The main process (app/main.js) wraps these with net.fetch + downloads.
//
// A "repo" is just a base URL that serves an index.json catalog and the per-app <id>.zip files. The
// default the UI ships is a github.com tree URL; repoRawBase() turns that into the raw.githubusercontent
// base actually fetched from, so users can paste either form (or point at any other static host).

// github.com/<o>/<r>/tree|blob/<branch>/<path...>  ->  raw.githubusercontent.com/<o>/<r>/<branch>/<path...>
// raw URLs and other http(s) bases pass through (trailing slash trimmed). Junk / non-http -> ''.
function repoRawBase(url) {
  var s = String(url || '').trim();
  if (!s) return '';
  var m = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)(?:\/(.*))?$/i);
  if (m) {
    var path = (m[4] || '').replace(/\/+$/, '');
    return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3] + (path ? '/' + path : '');
  }
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  return '';
}

function indexUrl(base) { return repoRawBase(base) + '/index.json'; }

// Resolve an index entry's zip to an absolute URL. An entry.zip may be an absolute http(s) URL
// (custom hosting) or a bare filename resolved against the repo base.
function zipUrl(base, entry) {
  var z = String((entry && entry.zip) || '').trim();
  if (!z) return '';
  if (/^https?:\/\//i.test(z)) return z;
  return repoRawBase(base) + '/' + z.replace(/^\/+/, '');
}

// Compare dotted numeric versions. Returns -1 (a<b), 0 (equal), 1 (a>b). Non-numeric parts count as 0,
// so "1.2" < "1.2.1" and "1.0" == "1.0.0".
function cmpVersion(a, b) {
  var pa = String(a == null ? '' : a).split('.');
  var pb = String(b == null ? '' : b).split('.');
  var n = Math.max(pa.length, pb.length);
  for (var i = 0; i < n; i++) {
    var x = parseInt(pa[i], 10); if (!isFinite(x)) x = 0;
    var y = parseInt(pb[i], 10); if (!isFinite(y)) y = 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// Normalize a fetched catalog (either { apps:[...] } or a bare array) into a clean app list.
// Drops entries without a usable id.
function parseIndex(json) {
  var arr = json && Array.isArray(json.apps) ? json.apps : (Array.isArray(json) ? json : []);
  var out = [];
  arr.forEach(function (a) {
    if (!a || typeof a.id !== 'string' || !a.id.trim()) return;
    out.push({
      id: a.id.trim(),
      name: (typeof a.name === 'string' && a.name) || a.id.trim(),
      description: typeof a.description === 'string' ? a.description : '',
      version: typeof a.version === 'string' ? a.version : '0.0.0',
      zip: typeof a.zip === 'string' ? a.zip : (a.id.trim() + '.zip'),
      server: !!a.server,
    });
  });
  return out;
}

module.exports = { repoRawBase, indexUrl, zipUrl, cmpVersion, parseIndex };
