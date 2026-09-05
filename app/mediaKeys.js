'use strict';
// Media key adapter — Windows implementation via @jitsi/robotjs.
// Keeps the { transport(cmd), volume(v), pasteShortcut() } interface so main.js
// doesn't know the backend. Swap this file to add platform backends later.

// Macro key combos: map friendly tokens to robotjs names. Modifiers robotjs knows: control/shift/alt/command.
const MOD_ALIAS = { ctrl: 'control', control: 'control', ctl: 'control', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt', win: 'command', cmd: 'command', command: 'command', meta: 'command', super: 'command' };
const KEY_ALIAS = { esc: 'escape', escape: 'escape', del: 'delete', 'delete': 'delete', ins: 'insert', insert: 'insert', 'return': 'enter', enter: 'enter', space: 'space', spacebar: 'space', tab: 'tab', backspace: 'backspace', bksp: 'backspace', up: 'up', down: 'down', left: 'left', right: 'right', pgup: 'pageup', pageup: 'pageup', pgdn: 'pagedown', pagedown: 'pagedown', home: 'home', end: 'end', plus: '+' };

function createMediaKeys({ log = () => {} } = {}) {
  let robot = null;
  try { robot = require('@jitsi/robotjs'); }
  catch (e) {
    try { robot = require('robotjs'); }
    catch (e2) { log('robotjs unavailable (media keys off): ' + e2.message); }
  }

  return {
    transport(cmd) {
      if (!robot) return false;
      const map = { playpause: 'audio_play', next: 'audio_next', prev: 'audio_prev', stop: 'audio_stop' };
      const k = map[cmd];
      if (!k) return false;
      try { robot.keyTap(k); return true; } catch (e) { return false; }
    },
    volume(v) {
      if (!robot) return;
      try {
        if (v === 'mute') robot.keyTap('audio_mute');
        else robot.keyTap(v > 0 ? 'audio_vol_up' : 'audio_vol_down');
      } catch (e) {}
    },
    // Used by the paste-text tile: sends Ctrl+V to the active foreground window.
    pasteShortcut() {
      if (!robot) return false;
      try { robot.keyTap('v', 'control'); return true; } catch (e) { return false; }
    },
    // ---- monitor mode: the device (knob/touch) drives the OS cursor while the panel shows the desktop.
    // Driven only by trusted device input in the main process — never by web/renderer content.
    available() { return !!robot; },
    moveMouse(x, y) { if (robot) { try { robot.moveMouse(x, y); } catch (e) {} } },
    mouseToggle(down, button) { if (robot) { try { robot.mouseToggle(down ? 'down' : 'up', button || 'left'); } catch (e) {} } },
    click(button) { if (robot) { try { robot.mouseClick(button || 'left'); } catch (e) {} } },
    scroll(dy) { if (robot) { try { robot.scrollMouse(0, dy); } catch (e) {} } },
    tapKey(name) { if (robot) { try { robot.keyTap(name); } catch (e) {} } },
    // Release a modifier (or any key) system-wide. Used by the global-shortcut handler to clear
    // the stuck-modifier state Win32 RegisterHotKey leaves behind when a hotkey with modifiers
    // fires while the user is still holding them. `name` is a robotjs key name (e.g. 'control').
    keyUp(name) { if (robot) { try { robot.keyToggle(name, 'up'); } catch (e) {} } },
    // Macro: send a key combo like "control+shift+c". Last non-modifier token is the key.
    tapCombo(combo) {
      if (!robot) return false;
      const toks = String(combo || '').split('+').map(s => s.trim().toLowerCase()).filter(Boolean);
      const mods = []; let key = null;
      for (const t of toks) {
        if (MOD_ALIAS[t]) { if (!mods.includes(MOD_ALIAS[t])) mods.push(MOD_ALIAS[t]); }
        else key = KEY_ALIAS[t] || t;
      }
      if (!key) return false;
      try { mods.length ? robot.keyTap(key, mods) : robot.keyTap(key); return true; }
      catch (e) { log('keyTap failed for "' + combo + '": ' + e.message); return false; }
    },
    // Macro: type literal text into the active window (does NOT touch the clipboard, unlike pasteShortcut).
    typeString(text) {
      if (!robot || text == null || text === '') return false;
      try { robot.typeString(String(text)); return true; } catch (e) { log('typeString failed: ' + e.message); return false; }
    },
  };
}

module.exports = { createMediaKeys };
