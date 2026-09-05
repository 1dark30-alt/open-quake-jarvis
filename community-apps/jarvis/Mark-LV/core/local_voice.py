"""Local Kokoro/Piper speech and CPU transcription. Never calls a speech API."""
from pathlib import Path
import re
import json
import threading
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / 'models'
VOICE = 'kokoro-bm_george'
SPEAKER = 'p237'  # Scottish male, Fife; resolve the model-specific numeric ID below.


def spoken_text(text):
    text = re.sub(r'```.*?```', 'The code is shown on screen.', text, flags=re.S)
    text = re.sub(r'\[([^]]+)\]\([^)]+\)', r'\1', text)
    text = re.sub(r'https?://\S+', 'the link on screen', text)
    return re.sub(r'[*#`_]', '', text).strip()


class LocalVoice:
    def __init__(self, length_scale=1.0, pitch=1.0, model_name=VOICE):
        if model_name not in ('xtts-v2', 'xtts-jarvis', 'kokoro-bm_george', 'kokoro-bm_daniel', 'en_GB-alan-medium', 'en_GB-vctk-medium'):
            raise ValueError('Unsupported local voice model')
        self.model_name = model_name
        self.length_scale = max(.8, min(1.4, float(length_scale)))
        self.pitch = max(.9, min(1.1, float(pitch)))
        self.voice = None
        self.speaker_id = None
        self.lock = threading.Lock()
        self.speaking = threading.Event()
        self.cancelled = threading.Event()

    def synthesize(self, text):
        if self.model_name.startswith('xtts-'):
            from core.xtts_client import XttsClient
            with self.lock:
                if self.voice is None:
                    self.voice = XttsClient(reference=self.model_name == 'xtts-jarvis')
                text = spoken_text(text)
                if not text:
                    return np.zeros(0, dtype=np.int16), 24000
                samples, rate = self.voice.synthesize(text, 1 / self.length_scale)
                return samples, round(rate * self.pitch)
        if self.model_name.startswith('kokoro-'):
            return self._kokoro(text)
        from piper import PiperVoice, SynthesisConfig
        with self.lock:
            if self.voice is None:
                model = MODELS / self.model_name / (self.model_name + '.onnx')
                if not model.exists():
                    raise RuntimeError('Local voice is missing. Run install_mark55.py.')
                metadata = json.loads(Path(str(model) + '.json').read_text(encoding='utf-8'))
                self.speaker_id = metadata.get('speaker_id_map', {}).get(SPEAKER)
                if self.model_name == 'en_GB-vctk-medium' and self.speaker_id is None:
                    raise RuntimeError('Scottish speaker is missing from the voice model. Re-run install_mark55.py.')
                self.voice = PiperVoice.load(str(model))
            chunks = list(self.voice.synthesize(spoken_text(text), syn_config=SynthesisConfig(
                speaker_id=self.speaker_id, length_scale=self.length_scale, noise_scale=.55, noise_w_scale=.7)))
            if not chunks:
                return np.zeros(0, dtype=np.int16), 22050
            samples = np.concatenate([np.frombuffer(c.audio_int16_bytes, dtype=np.int16) for c in chunks])
            return samples, round(chunks[0].sample_rate * self.pitch)

    def _kokoro(self, text):
        from kokoro_onnx import Kokoro
        with self.lock:
            if self.voice is None:
                model = MODELS / 'kokoro' / 'kokoro-v1.0.onnx'
                voices = MODELS / 'kokoro' / 'voices-v1.0.bin'
                if not model.exists() or not voices.exists():
                    raise RuntimeError('Kokoro models are missing. Run install_mark55.py.')
                self.voice = Kokoro(str(model), str(voices))
            text = spoken_text(text)
            if not text:
                return np.zeros(0, dtype=np.int16), 24000
            samples, rate = self.voice.create(text, voice=self.model_name.removeprefix('kokoro-'),
                                             speed=1 / self.length_scale, lang='en-gb')
            return (np.clip(samples, -1, 1) * 32767).astype(np.int16), round(rate * self.pitch)

    def save(self, text, destination):
        samples, rate = self.synthesize(text)
        with wave.open(str(destination), 'wb') as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(samples.tobytes())

    def speak(self, text, device=None, on_audio=None):
        import sounddevice as sd
        self.cancelled.clear()
        self.speaking.set()
        try:
            samples, rate = self.synthesize(text)
            if self.cancelled.is_set():
                return
            if on_audio:
                on_audio(samples, rate)
            sd.play(samples, rate, device=device, blocking=True)
        finally:
            self.speaking.clear()

    def stop(self):
        self.cancelled.set()
        if self.model_name.startswith('xtts-') and self.voice is not None:
            self.voice.close()
        import sounddevice as sd
        sd.stop()


class LocalTranscriber:
    def __init__(self):
        self.model = None
        self.lock = threading.Lock()

    def transcribe(self, samples):
        if len(samples) < 3200 or float(np.max(np.abs(samples))) < .006:
            return ''
        with self.lock:
            if self.model is None:
                from faster_whisper import WhisperModel
                path = MODELS / 'whisper-base.en'
                if not (path / 'model.bin').exists():
                    raise RuntimeError('Local speech recognition is missing. Run install_mark55.py.')
                self.model = WhisperModel(str(path), device='cpu', compute_type='int8', local_files_only=True)
            segments, _ = self.model.transcribe(samples, language='en', beam_size=1,
                vad_filter=True, condition_on_previous_text=False)
            return ' '.join(s.text.strip() for s in segments if s.no_speech_prob < .6).strip()


def install_models():
    """Explicit installer only: the running assistant never downloads a model."""
    import subprocess
    import sys
    from faster_whisper.utils import download_model
    import urllib.request
    directory = MODELS / 'kokoro'
    directory.mkdir(parents=True, exist_ok=True)
    for name in ('kokoro-v1.0.onnx', 'voices-v1.0.bin'):
        target = directory / name
        if not target.exists():
            temporary = target.with_suffix('.download')
            release = 'model-files-v1.0' if name.endswith('.onnx') else 'model-files-v1.1'
            urllib.request.urlretrieve('https://github.com/thewh1teagle/kokoro-onnx/releases/download/' + release + '/' + name, temporary)
            temporary.replace(target)
    # Retain Alan as an explicitly selectable alternative.
    directory = MODELS / 'en_GB-alan-medium'
    directory.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, '-m', 'piper.download_voices', '--download-dir', str(directory), 'en_GB-alan-medium'], check=True)
    download_model('base.en', output_dir=str(MODELS / 'whisper-base.en'))

if __name__ == '__main__':
    install_models()
