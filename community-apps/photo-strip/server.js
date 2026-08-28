'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const IMAGE_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
});
const FOLDER_KEYS = Object.freeze(['folder1', 'folder2', 'folder3', 'folder4']);
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_IMAGES = 10000;
const MAX_DIRECTORIES = 2000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_DELETE_BODY_BYTES = 2048;

let cache = null;
let pendingScan = null;
let trashFileOverride = null;

function truthy(value) {
  return value === true || value === '1' || value === 'true';
}

function supportedImage(name) {
  return !!IMAGE_TYPES[path.extname(String(name || '')).toLowerCase()];
}

function configuredFolders(options) {
  const seen = new Set();
  return FOLDER_KEYS.map(key => String((options || {})[key] || '').trim())
    .filter(Boolean)
    .map(folder => path.resolve(folder))
    .filter(folder => {
      const identity = process.platform === 'win32' ? folder.toLowerCase() : folder;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

function cacheKey(options) {
  return JSON.stringify({ folders: configuredFolders(options), recursive: truthy((options || {}).recursive) });
}

function imageId(file) {
  const identity = process.platform === 'win32' ? file.toLowerCase() : file;
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

function contained(root, file) {
  const base = path.resolve(root);
  const target = path.resolve(file);
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return fold(target).startsWith(fold(base + path.sep));
}

function folderLabel(folder) {
  return path.basename(folder) || folder;
}

async function scanFolder(folder, recursive, state) {
  let rootReal;
  try {
    rootReal = await fsp.realpath(folder);
    if (!(await fsp.stat(rootReal)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    state.messages.push(`Folder “${folderLabel(folder)}” is missing or unreadable.`);
    return;
  }

  state.availableFolders += 1;
  const queue = [rootReal];
  while (queue.length && state.items.length < MAX_IMAGES && state.directories < MAX_DIRECTORIES) {
    const current = queue.shift();
    state.directories += 1;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      state.messages.push(`A folder inside “${folderLabel(folder)}” could not be read.`);
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const entry of entries) {
      if (state.items.length >= MAX_IMAGES) break;
      const full = path.join(current, entry.name);
      if (recursive && entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile() || !supportedImage(entry.name)) continue;
      const identity = process.platform === 'win32' ? full.toLowerCase() : full;
      if (state.seen.has(identity)) continue;
      let stat;
      try { stat = await fsp.stat(full); } catch (error) { continue; }
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
      state.seen.add(identity);
      state.items.push({
        id: imageId(full),
        name: entry.name,
        date: new Date(stat.mtimeMs).toISOString(),
        file: full,
        root: rootReal,
        size: stat.size,
      });
    }
  }
}

async function scanLibrary(options) {
  const folders = configuredFolders(options);
  const state = {
    items: [],
    seen: new Set(),
    messages: [],
    availableFolders: 0,
    directories: 0,
  };
  for (const folder of folders) await scanFolder(folder, truthy((options || {}).recursive), state);
  if (state.items.length >= MAX_IMAGES) state.messages.push(`Library capped at ${MAX_IMAGES.toLocaleString()} photos.`);
  if (state.directories >= MAX_DIRECTORIES) state.messages.push(`Recursive scan capped at ${MAX_DIRECTORIES.toLocaleString()} folders.`);
  const byId = new Map(state.items.map(item => [item.id, item]));
  return {
    key: cacheKey(options),
    scannedAt: Date.now(),
    items: state.items,
    byId,
    folderCount: folders.length,
    availableFolders: state.availableFolders,
    messages: state.messages,
  };
}

async function getLibrary(options, force) {
  const key = cacheKey(options);
  if (!force && cache && cache.key === key && Date.now() - cache.scannedAt < CACHE_TTL_MS) return cache;
  if (!force && pendingScan && pendingScan.key === key) return pendingScan.promise;
  const promise = scanLibrary(options).then(result => {
    cache = result;
    return result;
  }).finally(() => {
    if (pendingScan && pendingScan.promise === promise) pendingScan = null;
  });
  pendingScan = { key, promise };
  return promise;
}

function publicLibrary(library) {
  let status = 'ready';
  if (!library.folderCount) status = 'unconfigured';
  else if (!library.availableFolders) status = 'unavailable';
  else if (!library.items.length) status = 'empty';
  return {
    ok: true,
    status,
    count: library.items.length,
    folderCount: library.folderCount,
    availableFolders: library.availableFolders,
    messages: library.messages.slice(),
    images: library.items.map(item => ({ id: item.id, name: item.name, date: item.date })),
  };
}

async function resolveKnownImage(options, id) {
  if (!/^[a-f0-9]{24}$/.test(String(id || ''))) return { ok: false, error: 'invalid image id' };
  const library = await getLibrary(options, false);
  const image = library.byId.get(String(id));
  if (!image || !supportedImage(image.file)) return { ok: false, error: 'image not found' };

  let realFile;
  let stat;
  try {
    realFile = await fsp.realpath(image.file);
    stat = await fsp.stat(realFile);
  } catch (error) {
    return { ok: false, error: 'image no longer exists' };
  }
  if (!contained(image.root, realFile) || !stat.isFile()) return { ok: false, error: 'image not found' };

  return { ok: true, image, realFile, stat };
}

async function loadImage(options, id) {
  const resolved = await resolveKnownImage(options, id);
  if (!resolved.ok) return resolved;
  const { image, realFile, stat } = resolved;
  if (stat.size > MAX_IMAGE_BYTES) return { ok: false, error: 'image is too large' };

  try {
    const buffer = await fsp.readFile(realFile);
    const mime = IMAGE_TYPES[path.extname(realFile).toLowerCase()];
    return { ok: true, id: image.id, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
  } catch (error) {
    return { ok: false, error: 'image could not be read' };
  }
}

function deleteIdFromBody(body) {
  if (!Buffer.isBuffer(body) || !body.length || body.length > MAX_DELETE_BODY_BYTES) return '';
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' && typeof parsed.id === 'string' ? parsed.id : '';
  } catch (error) {
    return '';
  }
}

async function trashFile(file) {
  if (typeof trashFileOverride === 'function') return trashFileOverride(file);
  let electron;
  try { electron = require('electron'); } catch (error) { electron = null; }
  if (!(electron && electron.shell && typeof electron.shell.trashItem === 'function')) {
    throw new Error('Recycle Bin is unavailable');
  }
  return electron.shell.trashItem(file);
}

async function deleteImage(options, id) {
  if (!truthy((options || {}).allowDelete)) return { ok: false, error: 'photo deletion is disabled' };
  const resolved = await resolveKnownImage(options, id);
  if (!resolved.ok) return resolved;
  try {
    await trashFile(resolved.realFile);
  } catch (error) {
    return { ok: false, error: 'photo could not be moved to the Recycle Bin' };
  }
  resetCache();
  return { ok: true, id: resolved.image.id, name: resolved.image.name };
}

async function handle(action, context) {
  const ctx = context || {};
  const options = ctx.options || {};
  if (action === 'library') {
    const force = ctx.query && ctx.query.refresh === '1';
    return publicLibrary(await getLibrary(options, force));
  }
  if (action === 'image') return loadImage(options, ctx.query && ctx.query.id);
  if (action === 'delete') {
    const id = deleteIdFromBody(ctx.body);
    if (!id) return { ok: false, error: 'invalid request body' };
    return deleteImage(options, id);
  }
  return { ok: false, error: 'unknown action' };
}

function resetCache() {
  cache = null;
  pendingScan = null;
}

module.exports = {
  handle,
  _test: {
    IMAGE_TYPES,
    MAX_IMAGES,
    configuredFolders,
    supportedImage,
    scanLibrary,
    publicLibrary,
    contained,
    deleteIdFromBody,
    deleteImage,
    resetCache,
    setTrashFileImpl(implementation) {
      trashFileOverride = typeof implementation === 'function' ? implementation : null;
    },
  },
};
