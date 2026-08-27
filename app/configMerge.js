'use strict';
// Three-way merge of an EXTERNAL config write into the editor's dirty working copy, so a counter
// tap or an app option persisting mid-edit never forces a "save or reload" choice. base = the
// config as of the editor's last load/save; editor = the working copy; fresh = what's on disk now.
// Rule per unit/key: external-only change -> fold it in; editor-only change -> keep it; both
// changed -> the editor wins and the conflict is reported (rare — same unit edited both places).
// UMD-lite: plain <script> in the editor window, require()-able from unit tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.configMerge = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const snap = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));
  const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Id-keyed arrays (grids / groups / panes). Editor's order is kept; units added externally are
  // appended; units deleted externally disappear unless the editor touched them.
  function mergeUnitArray(editorArr, baseArr, freshArr, conflicts, label) {
    const baseBy = new Map((baseArr || []).map(u => [u.id, u]));
    const freshBy = new Map((freshArr || []).map(u => [u.id, u]));
    const out = [];
    for (const u of (editorArr || [])) {
      const b = baseBy.get(u.id), f = freshBy.get(u.id);
      if (!b) { out.push(u); continue; }                                   // editor-added
      const editorChanged = !jeq(u, b);
      if (!f) {                                                            // externally deleted
        if (editorChanged) { out.push(u); conflicts.push(label + ' "' + (u.name || u.id) + '"'); }
        continue;
      }
      if (jeq(f, b)) { out.push(u); continue; }                            // external untouched
      if (!editorChanged) { out.push(snap(f)); continue; }                 // external edit folded in
      out.push(u); conflicts.push(label + ' "' + (u.name || u.id) + '"');  // both changed -> editor wins
    }
    const editorIds = new Set((editorArr || []).map(u => u.id));
    const baseIds = new Set((baseArr || []).map(u => u.id));
    for (const f of (freshArr || [])) {
      if (!editorIds.has(f.id) && !baseIds.has(f.id)) out.push(snap(f));   // externally added
    }
    return out;
  }

  // Key-wise three-way merge of a plain object (settings, or the config's top-level scalars).
  // skipKeys: keys handled elsewhere (the unit arrays / the settings subtree itself).
  function mergeObject(editorObj, baseObj, freshObj, conflicts, labelPrefix, skipKeys) {
    const ed = editorObj || {}, ba = baseObj || {}, fr = freshObj || {};
    const skip = new Set(skipKeys || []);
    const out = Object.assign({}, ed);
    const keys = new Set([...Object.keys(ed), ...Object.keys(ba), ...Object.keys(fr)]);
    for (const k of keys) {
      if (skip.has(k)) continue;
      const e = ed[k], b = ba[k], f = fr[k];
      if (jeq(f, b)) continue;                                             // external untouched
      if (jeq(e, b)) {                                                     // external change folded in
        if (f === undefined) delete out[k]; else out[k] = snap(f);
        continue;
      }
      if (jeq(e, f)) continue;                                             // both landed on the same value
      conflicts.push(labelPrefix + '"' + k + '"');                         // both changed -> editor wins
    }
    return out;
  }

  // The whole config. Returns { merged, conflicts } — merged is a NEW object safe to adopt as the
  // editor's working copy; conflicts is a list of human-readable unit/key names the editor kept.
  function mergeExternalConfig(editorCfg, baseCfg, freshCfg) {
    const conflicts = [];
    const sections = ['grids', 'groups', 'panes', 'settings'];
    const merged = mergeObject(editorCfg, baseCfg, freshCfg, conflicts, '', sections);
    merged.settings = mergeObject(editorCfg.settings, baseCfg.settings, freshCfg.settings, conflicts, 'setting ', []);
    merged.grids = mergeUnitArray(editorCfg.grids, baseCfg.grids, freshCfg.grids, conflicts, 'page');
    merged.groups = mergeUnitArray(editorCfg.groups, baseCfg.groups, freshCfg.groups, conflicts, 'group');
    merged.panes = mergeUnitArray(editorCfg.panes, baseCfg.panes, freshCfg.panes, conflicts, 'pane');
    return { merged, conflicts };
  }

  return { mergeExternalConfig, mergeUnitArray, mergeObject };
});
