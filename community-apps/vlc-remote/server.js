'use strict';

const REQUEST_TIMEOUT_MS = 12000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ALLOWED_COMMANDS = new Set([
  'pl_previous',
  'pl_pause',
  'pl_stop',
  'pl_next',
  'seek',
  'volume',
  'pl_empty',
  'pl_play',
]);
const SEEK_VALUES = new Set(['-60', '-10', '+10', '+60']);
const VOLUME_VALUES = new Set(['-16', '0', '+16']);

function optionString(options, key, fallback) {
  const value = options && options[key];
  return value == null || value === '' ? fallback : String(value);
}

function vlcBase(options) {
  const value = optionString(options, 'host', 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('VLC URL must use http or https');
  if (url.username || url.password) throw new Error('Put VLC credentials in the password option, not the VLC URL');
  url.hash = '';
  return url;
}

function authHeader(options) {
  const password = optionString(options, 'password', '');
  return 'Basic ' + Buffer.from(':' + password, 'utf8').toString('base64');
}

function safeError(error) {
  return String(error && error.message || error || 'VLC request failed')
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/ig, '$1<credentials>@')
    .replace(/(password|passwd|pwd)=([^&\s]+)/ig, '$1=<hidden>');
}

async function responseText(response) {
  const declaredLength = Number(response.headers && response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('VLC response was too large');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('VLC response was too large');
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch (error) {}
      throw new Error('VLC response was too large');
    }
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}

async function vlcRequest(options, pathname, params) {
  const url = vlcBase(options);
  url.pathname = pathname;
  url.search = '';
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && value !== '') url.searchParams.set(key, value);
  });

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: authHeader(options),
        Accept: 'application/json',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('VLC request timed out');
    throw error;
  }

  const text = await responseText(response);
  if (!response.ok) {
    const detail = text ? ' - ' + text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    throw new Error('VLC returned HTTP ' + response.status + detail);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error('VLC returned a non-JSON response');
  }
}

function commandParams(query) {
  const command = String(query.command || query.cmd || '');
  if (!ALLOWED_COMMANDS.has(command)) throw new Error('Unsupported VLC command');
  const params = { command };

  if (command === 'seek') {
    const value = String(query.val || '');
    if (!SEEK_VALUES.has(value)) throw new Error('Unsupported seek value');
    params.val = value;
  } else if (command === 'volume') {
    const value = String(query.val == null ? '' : query.val);
    if (!VOLUME_VALUES.has(value)) throw new Error('Unsupported volume value');
    params.val = value;
  } else if (command === 'pl_play') {
    const id = String(query.id || '');
    if (!/^\d+$/.test(id)) throw new Error('Invalid playlist item');
    params.id = id;
  }

  return params;
}

async function handle(action, context) {
  const options = context && context.options || {};
  const query = context && context.query || {};

  try {
    if (action === 'status') return await vlcRequest(options, '/requests/status.json');
    if (action === 'playlist') return await vlcRequest(options, '/requests/playlist.json');
    if (action === 'command') return await vlcRequest(options, '/requests/status.json', commandParams(query));
    return { ok: false, error: 'unknown action' };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

module.exports = { handle };
