"""Keep XTTS's GPU dependencies outside the main Jarvis environment."""
import atexit
import base64
import json
from pathlib import Path
import queue
import subprocess
import threading
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


class XttsClient:
    def __init__(self):
        self.process = None
        self.responses = None
        atexit.register(self.close)

    def _read(self, process, responses):
        try:
            for line in process.stdout:
                responses.put(json.loads(line))
        except Exception:
            pass
        finally:
            responses.put({'error': 'XTTS process exited. See models/xtts-worker.log.'})

    def _receive(self, responses):
        try:
            response = responses.get(timeout=180)
        except queue.Empty:
            self.close()
            raise RuntimeError('XTTS timed out; retry or select Kokoro.')
        if 'error' in response:
            raise RuntimeError(response['error'])
        return response

    def synthesize(self, text, speed):
        if self.process is None or self.process.poll() is not None:
            python = ROOT / 'models' / 'xtts-env' / 'Scripts' / 'python.exe'
            if not python.exists():
                raise RuntimeError('Run install_xtts.py to install the optional XTTS environment.')
            with (ROOT / 'models' / 'xtts-worker.log').open('a', encoding='utf-8') as log:
                self.process = subprocess.Popen([str(python), '-u', str(ROOT / 'core' / 'xtts_worker.py')],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf-8',
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.responses = queue.Queue()
            threading.Thread(target=self._read, args=(self.process, self.responses), daemon=True).start()
            self._receive(self.responses)
        process, responses = self.process, self.responses
        process.stdin.write(json.dumps({'text': text, 'speaker': 'Craig Gutsy', 'speed': speed}) + '\n')
        process.stdin.flush()
        result = self._receive(responses)
        return np.frombuffer(base64.b64decode(result['pcm']), dtype='<i2').copy(), result['rate']

    def close(self):
        process, self.process = self.process, None
        if process and process.poll() is None:
            process.kill()
            process.wait(timeout=10)
