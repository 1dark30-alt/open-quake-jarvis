'use strict';

const DEFAULT_DISCORD_SETTINGS = Object.freeze({
  enabled: true,
  applicationIdOverride: '',
  defaultView: 'voice',
  autoReconnect: true,
  showUnavailable: true,
  richPresence: false,
});

const VIEWS = new Set(['voice', 'chat', 'activity']);

function cleanId(value, maxLength) {
  return typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, maxLength) : '';
}

function normalizeDiscordSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const legacyClientId = source.clientId == null ? source.applicationId : source.clientId;
  const applicationIdOverride = source.applicationIdOverride == null ? legacyClientId : source.applicationIdOverride;
  const defaultView = VIEWS.has(source.defaultView) ? source.defaultView : DEFAULT_DISCORD_SETTINGS.defaultView;
  return {
    enabled: source.enabled !== false,
    applicationIdOverride: cleanId(applicationIdOverride, 128),
    defaultView,
    autoReconnect: source.autoReconnect !== false,
    showUnavailable: source.showUnavailable !== false,
    richPresence: source.richPresence === true,
  };
}

// No built-in Discord application. RPC voice scopes are owner-only, so each user registers their own
// free Discord app and sets it as "Your Discord Application ID" (see docs/discord.md). A blank override
// therefore resolves to no application -- the connect UI stays disabled until the user sets one.
const DEFAULT_DISCORD_APPLICATION_ID = '';

function discordApplicationId(settings) {
  const normalized = normalizeDiscordSettings(settings);
  return normalized.applicationIdOverride || DEFAULT_DISCORD_APPLICATION_ID;
}

module.exports = { DEFAULT_DISCORD_APPLICATION_ID, DEFAULT_DISCORD_SETTINGS, discordApplicationId, normalizeDiscordSettings };
