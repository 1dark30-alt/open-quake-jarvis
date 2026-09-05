"""Optional Windows/NVIDIA XTTS installer for personal, non-commercial use.

Model license: https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt
"""
from pathlib import Path
import shutil
import subprocess


def main():
    root = Path(__file__).resolve().parent / 'Mark-LV'
    uv = shutil.which('uv')
    if not uv:
        raise SystemExit('Install uv first: python -m pip install uv')
    env = root / 'models' / 'xtts-env'
    python = env / 'Scripts' / 'python.exe'
    if not python.exists():
        subprocess.run([uv, 'venv', '--python', '3.12', str(env)], check=True)
    subprocess.run([uv, 'pip', 'install', '--python', str(python), 'torch==2.8.0', 'torchaudio==2.8.0',
        '--index-url', 'https://download.pytorch.org/whl/cu128'], check=True)
    subprocess.run([uv, 'pip', 'install', '--python', str(python),
        'coqui-tts>=0.27.4,<0.28', 'transformers<5'], check=True)
    code = "from huggingface_hub import snapshot_download; snapshot_download('coqui/XTTS-v2', local_dir='models/xtts-v2', allow_patterns=['config.json','model.pth','vocab.json','speakers_xtts.pth','LICENSE.txt'])"
    subprocess.run([str(python), '-c', code], cwd=root, check=True)
    print('XTTS installed. Select local_voice_model: xtts-v2 in config/api_keys.json and restart Jarvis.')


if __name__ == '__main__':
    main()
