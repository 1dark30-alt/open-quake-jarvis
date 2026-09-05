"""Install Mark 55 without launching it."""
from pathlib import Path
import subprocess
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
    print('Installed. Set your Gemini API key in Open Quake and open JARVIS.')

if __name__ == '__main__':
    main()
