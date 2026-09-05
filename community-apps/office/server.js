'use strict';

const fs = require('fs');
const { createOfficeActions } = require('./officeActions');
const { createOfficeGraph, OFFICE_SCOPES } = require('./officeGraph');
const { officeShortcutImageDataUrl } = require('./officeShortcutIcons');

const WEB_HOSTS = new Set([
  'teams.microsoft.com', 'teams.live.com', 'outlook.office.com', 'outlook.office365.com',
  'outlook.live.com', 'www.office.com', 'office.com',
]);

function requireOAuth(context) {
  if (!context.oauth) throw new Error('OAuth is unavailable');
  return context.oauth;
}

function graphFor(context) {
  const oauth = requireOAuth(context);
  return createOfficeGraph({
    getAccessToken: (_provider, scopes) => oauth.getAccessToken(scopes),
    connectOAuth: (_provider, scopes) => oauth.connect(scopes),
  });
}

function actionsFor(context) {
  const host = context.host || {};
  return createOfficeActions({
    getOptions: () => context.options || {},
    launchApp: value => host.launchApp(value),
    openExternal: value => host.openExternal(value),
    focusTeams: () => host.focusTeams(),
    focusApp: names => host.focusApp(names),
    hasAppWindow: names => host.hasAppWindow(names),
    tapCombo: combo => host.tapCombo(combo),
    fs,
  });
}

function publicOptions(options) {
  const out = Object.assign({}, options || {});
  for (let app = 1; app <= 4; app++) {
    for (let shortcut = 1; shortcut <= 8; shortcut++) {
      const key = 'app' + app + 'Shortcut' + shortcut + 'IconImage';
      const value = out[key];
      if (value) out[key + 'Src'] = officeShortcutImageDataUrl(value, fs);
      delete out[key];
    }
  }
  return out;
}

function allowedWebUrl(value) {
  try {
    const target = new URL(value);
    return target.protocol === 'https:' && !target.port && WEB_HOSTS.has(target.hostname.toLowerCase()) ? target.href : null;
  } catch (e) { return null; }
}

async function handle(action, context) {
  const query = context.query || {};
  if (action === 'auth-status') return requireOAuth(context).status();
  if (action === 'connect') return graphFor(context).connect();
  if (action === 'disconnect') return requireOAuth(context).disconnect();
  if (action === 'data') return graphFor(context).getData();
  if (action === 'check-connection') return graphFor(context).checkConnection();
  if (action === 'meeting-info') {
    let body = {};
    try { body = context.body && context.body.length ? JSON.parse(context.body.toString('utf8')) : {}; } catch (e) {}
    return { ok: true, meeting: await graphFor(context).getMeetingInfo(body) };
  }
  if (action === 'config') return { ok: true, options: publicOptions(context.options) };
  if (action === 'open') {
    const target = allowedWebUrl(query.url);
    return { ok: !!target && !!(await context.host.openExternal(target)) };
  }
  if (action === 'app') return actionsFor(context).run('app', Number(query.index));
  if (action === 'shortcut') return actionsFor(context).run('shortcut', Number(query.index), Number(query.shortcutIndex));
  if (action === 'meeting') return actionsFor(context).run('meeting', undefined, undefined, query.url);
  return { ok: false, error: 'unknown action' };
}

module.exports = { OFFICE_SCOPES, handle };
