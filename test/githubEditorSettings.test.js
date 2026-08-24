'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'app', name), 'utf8');

test('GitHub authentication and configuration render in the app page editor', () => {
  const source = read('config.js');
  const setup = source.slice(source.indexOf('async function appendGitHubSetup'), source.indexOf('// Screensaver:'));
  assert.match(source, /def\.id === 'github'\) appendGitHubSetup\(el\)/);
  assert.match(setup, /GitHub account/);
  assert.match(setup, /OAuth Client ID/);
  assert.match(setup, /Repository/);
  assert.match(setup, /Branch/);
  assert.match(setup, /These are optional/);
  assert.match(setup, /Device code/);
  assert.match(setup, /http:\/\/127\.0\.0\.1:53682\/callback/);
  assert.match(setup, /Device Flow never contacts it/);
  assert.match(setup, /connectGitHub\(\)/);
  assert.match(setup, /pollGitHubConnect\(\)/);
  assert.match(setup, /disconnectGitHub\(\)/);
  assert.match(setup, /Save your changes first, then connect/);
});

test('editor surfaces GitHub validation failures instead of misreporting secret storage', () => {
  const source = read('config.js');
  const save = source.slice(source.indexOf('async function doSave'), source.indexOf('// ---- tiles / icons'));
  assert.match(save, /result && result\.error/);
  assert.match(save, /setState\('save failed: ' \+ reason/);
  assert.match(save, /detail === 'secure persistence failed'/);
  assert.doesNotMatch(save, /setState\('save failed: secrets could not be stored securely'/);
});

test('GitHub editor bridge is narrow and tokens remain main-process-only', () => {
  const preload = read('config-preload.js');
  assert.match(preload, /getGitHubStatus/);
  assert.match(preload, /connectGitHub/);
  assert.match(preload, /pollGitHubConnect/);
  assert.match(preload, /disconnectGitHub/);
  assert.doesNotMatch(preload, /getGitHubToken|accessToken|refreshToken/);

  const main = read('main.js');
  assert.match(main, /ipcMain\.handle\('getGitHubStatus'[\s\S]*isFrom\(e, configWin\)/);
  assert.match(main, /ipcMain\.handle\('connectGitHub'/);
  assert.match(main, /ipcMain\.handle\('pollGitHubConnect'/);
  assert.match(main, /ipcMain\.handle\('disconnectGitHub'/);
  const save = main.slice(main.indexOf("ipcMain.handle('saveConfigFromEditor'"), main.indexOf("ipcMain.handle('pickProgram'"));
  assert.match(save, /normalizeGitHubClientId/);
  assert.match(save, /parseGitHubRepository/);
  assert.match(save, /githubClientChanged[\s\S]*delete newCfg\.settings\.oauth\.tokens\.github/);
});

test('GitHub touchscreen panel has operations only and cannot mutate authentication settings', () => {
  const html = read('github.html');
  const script = read('github.js');
  const server = read('sysserver.js');
  assert.doesNotMatch(html, /Settings|settingsButton/);
  assert.doesNotMatch(script, /renderSettings|saveSettings|connectGitHub|OAuth App Client ID|Device Flow/);
  assert.match(script, /Open this GitHub page in the desktop editor/);
  assert.match(html, /repositoryButton/);
  assert.match(html, /repositorySearch/);
  assert.match(script, /api\('repositories'/);
  assert.match(script, /open-quake\.github\.repository/);
  assert.match(script, /repository:state\.settings\.repository/);
  const routes = server.slice(server.indexOf('async function serveGitHubApi'), server.indexOf('async function handler'));
  assert.doesNotMatch(routes, /githubApp\.configure|githubApp\.connect|githubApp\.pollConnect|githubApp\.disconnect/);
});

test('GitHub panel uses large semantic touch controls and contained scrolling', () => {
  const html = read('github.html');
  const script = read('github.js');
  const css = read('github.css');
  assert.match(html, /grid|GitHub views/);
  assert.match(script, /<button type="button" class="list-row/);
  assert.match(script, /role="button" tabindex="0" data-go=/);
  assert.match(script, /\.content button:not\(:disabled\)/);
  assert.match(script, /\.content \[role="button"\]/);
  assert.match(script, /#confirmOverlay button:not\(:disabled\)/);
  assert.match(css, /\.app-shell \{ height:480px/);
  assert.match(css, /\.list-row \{[\s\S]*min-height:72px/);
  assert.match(css, /\.repository-dialog \.repository-row \{[\s\S]*min-height:76px/);
  assert.match(css, /touch-action:manipulation/);
  assert.match(css, /touch-action:pan-y/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(html, /class="dialog-actions"/);
  assert.doesNotMatch(css, /\.dialog > div:last-child/);
});
