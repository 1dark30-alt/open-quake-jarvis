'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'community-apps', 'if-player');
const chrome = fs.readFileSync(path.join(root, 'chrome.html'), 'utf8').trim();
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('IF player exposes only the approved common touchscreen commands', () => {
  const commands = [...chrome.matchAll(/data-command="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(commands, [
    'north', 'west', 'look', 'east', 'south',
    'take all', 'inventory', 'again', 'undo',
  ]);
  assert.equal((chrome.match(/class="command-btn/g) || []).length, 9);
  assert.match(chrome, /id="ifcommands-label" class="command-label">Common commands</);
});

test('generated Parchment page contains the current source chrome', () => {
  assert.ok(index.includes(chrome), 'run vendor-parchment.js workflow so index.html embeds chrome.html');
});

test('command rail is a fluid three-column layout and hides for the picker', () => {
  assert.match(css, /#gameport\s*\{[\s\S]*?left:\s*calc\(var\(--if-rail\) \+ \(var\(--if-gap\) \* 2\)\)/);
  assert.match(css, /#gameport\s*\{[\s\S]*?max-width:\s*none\s*!important/);
  assert.match(css, /body\.picking #ifcommands\s*\{\s*display:\s*none/);
  assert.match(css, /\.command-btn\s*\{[\s\S]*?min-height:\s*48px/);
  assert.match(css, /\.command-quick \.command-btn\s*\{[\s\S]*?min-height:\s*64px/);
});

test('command buttons share focus-safe wiring and remain inert until playing', () => {
  assert.match(app, /commandbtns\.forEach\(function \(btn\)[\s\S]*?wire\(btn,[\s\S]*?if \(playing\) sendCommand\(btn\.getAttribute\('data-command'\)\);[\s\S]*?focusGame\(\)/);
  assert.match(app, /btn\.addEventListener\('pointerdown', function \(e\) \{ e\.preventDefault\(\); \}\)/);
  assert.match(app, /commandbtns\.forEach\(function \(btn\) \{ btn\.disabled = !playing; \}\)/);
});
