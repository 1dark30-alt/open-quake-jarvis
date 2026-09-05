"""Install Mark 55 without launching it."""
from pathlib import Path
import subprocess
import json
import sys
import venv

def main():
    if sys.version_info < (3, 11):
        raise SystemExit('Python 3.11 or newer is required.')
    root = Path(__file__).resolve().parent / 'Mark-LV'
    env = root / '.venv'
    venv.EnvBuilder(with_pip=True).create(env)
    python = env / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
    subprocess.run([str(python), '-m', 'pip', 'install', '-r', str(root / 'requirements.txt')], check=True)
    subprocess.run([str(python), '-m', 'playwright', 'install', 'chromium'], check=True)
    subprocess.run([str(python), '-m', 'core.local_voice'], cwd=root, check=True)
    config_file = root / 'config' / 'api_keys.json'
    config = json.loads(config_file.read_text(encoding='utf-8')) if config_file.exists() else {}
    config.setdefault('llm_provider', 'codex')
    config.setdefault('os_system', sys.platform)
    config.setdefault('quake_pin', 'QUAKE')
    config.setdefault('push_to_talk_enabled', True)
    config_file.write_text(json.dumps(config, indent=2), encoding='utf-8')
    print('Installed. Select ChatGPT subscription in Open Quake. Sign in using the JARVIS panel button.')

if __name__ == '__main__':
    main()
