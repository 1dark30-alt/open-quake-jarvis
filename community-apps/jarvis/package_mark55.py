"""Build a source-only drop-in ZIP with an explicit release-file allowlist."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(__file__).resolve().parent
files = [root / name for name in ('app.json', 'jarvisview.html', 'jarvisview.js',
    'server.js', 'start_jarvis.vbs', 'install_mark55.py', 'package_mark55.py', 'README.md')]
files += [p for p in (root / 'assets').rglob('*') if p.is_file()]
backend = root / 'Mark-LV'
for folder in ('actions', 'core', 'dashboard', 'memory', 'plugins', 'config'):
    for p in (backend / folder).rglob('*'):
        if p.is_file() and '__pycache__' not in p.parts and 'certs' not in p.parts:
            if p.suffix in ('.py', '.txt', '.obj', '.html', '.js', '.ico'):
                files.append(p)
files += [backend / name for name in ('main.py', 'quake_main.py', 'ui.py', 'setup.py',
                                     'requirements.txt', 'readme.md', 'LICENSE')]
with ZipFile(root.parent / 'jarvis.zip', 'w', ZIP_DEFLATED) as archive:
    for p in sorted(files):
        archive.write(p, p.relative_to(root).as_posix())
print(f'Packaged {len(files)} files into jarvis.zip')
