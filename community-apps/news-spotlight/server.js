'use strict';

const { shell } = require('electron');

async function handle(action, context) {
  if (action !== 'open') return { ok: false, error: 'unknown action' };
  return openExternal(context && context.query && context.query.url);
}

async function openExternal(url) {
  let target;
  try {
    target = new URL(String(url || ''));
  } catch (error) {
    return { ok: false, error: 'invalid url' };
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, error: 'unsupported protocol' };
  }

  await shell.openExternal(target.href);
  return { ok: true };
}

module.exports = { handle };