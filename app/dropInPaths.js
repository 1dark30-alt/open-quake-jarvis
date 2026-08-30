'use strict';

const path = require('path');

// Manifest paths are URL-style relative paths. Keep this shared so the panel entry,
// server module, and optional editor entry all receive the same containment treatment.
function safeAppEntry(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const rel = value.trim().replace(/\\/g, '/');
  if (rel.includes('..') || rel.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rel) || path.isAbsolute(rel)) return null;
  return rel;
}

function appEntryUrlPath(entry) {
  return String(entry || '').split('/').map(encodeURIComponent).join('/');
}

function safeEditorDeclaration(manifest) {
  if (!manifest || !manifest.served || !manifest.editor || typeof manifest.editor !== 'object' || Array.isArray(manifest.editor)) return null;
  const entry = safeAppEntry(manifest.editor.entry);
  if (!entry) return null;
  const rawLabel = typeof manifest.editor.label === 'string' ? manifest.editor.label.trim() : '';
  return { entry, label: (rawLabel || 'Manage app').slice(0, 80) };
}

module.exports = { safeAppEntry, appEntryUrlPath, safeEditorDeclaration };
