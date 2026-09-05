const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
let child, starting;
function healthy() {
  return new Promise(resolve => {
    const req = http.get('http://127.0.0.1:8000/api/health', res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body).version === '55'); } catch { resolve(false); } });
    });
    req.setTimeout(1000, () => req.destroy());
    req.on('error', () => resolve(false));
  });
}
async function start(options) {
  if (await healthy()) return { ok: true, msg: 'Mark 55 is running' };
  const dir = path.join(__dirname, 'Mark-LV');
  const python = path.join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) return { ok: false, error: 'Run install_mark55.py with Python 3.11 or newer first.' };
  try {
    const file = path.join(dir, 'config', 'api_keys.json');
    const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    for (const key of ['gemini_api_key', 'pin']) {
      const value = options[key];
      if (typeof value === 'string' && value.trim() && !value.startsWith('oqenc:v1:'))
        config[key === 'pin' ? 'quake_pin' : key] = value.trim();
    }
    config.llm_provider = options.llm_provider || 'codex';
    config.os_system = process.platform;
    config.local_voice_pace = 1.06;
    config.local_voice_pitch = 0.98;
    config.push_to_talk_enabled = true;
    if (config.llm_provider !== 'codex' && !config.gemini_api_key) return { ok: false, error: 'Set your Gemini API key in JARVIS options.' };
    if (!config.quake_pin) config.quake_pin = 'QUAKE';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
  } catch (err) { return { ok: false, error: `Cannot save configuration: ${err.message}` }; }
  if (!child) {
    const log = fs.openSync(path.join(dir, 'startup.log'), 'a');
    try {
      child = spawn(python, ['quake_main.py'], { cwd: dir, windowsHide: true, stdio: ['ignore', log, log] });
      child.on('error', () => { child = null; });
      child.on('exit', () => { child = null; });
    } finally { fs.closeSync(log); }
  }
  for (let i = 0; i < 60; i++) {
    if (await healthy()) return { ok: true, msg: 'Mark 55 ready' };
    if (!child) return { ok: false, error: 'Mark 55 exited. See Mark-LV/startup.log.' };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { ok: false, error: 'Startup timed out. Check Mark-LV/startup.log and the desktop window, then retry.' };
}
async function handle(action, ctx = {}) {
  if (action === 'status') return { ok: true, running: await healthy() };
  if (action !== 'start') return { ok: false, error: 'unknown action' };
  if (!starting) starting = start(ctx.options || {}).finally(() => { starting = null; });
  return starting;
}
module.exports = { handle };
