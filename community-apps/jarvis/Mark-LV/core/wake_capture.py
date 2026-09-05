"""Local wake detection followed by one bounded, silence-ended command."""
import asyncio
import time
import numpy as np
from core.wake_word import WakeWordDetector, is_ready


class WakeCapture:
    def __init__(self, runtime):
        self.runtime = runtime
        self.enabled = False
        self.stream = None
        self.detector = None
        self.frames = []
        self.recording = False
        self.started = self.last_speech = self.cooldown = 0.
        self.heard_speech = False
        self.ready = False

    def allowed(self):
        r = self.runtime
        return (self.enabled and not r.ui.muted and not r.busy
                and not r.voice.speaking.is_set() and r.capture is None
                and r.queue.empty())

    def trigger(self):
        if not self.allowed() or self.recording or time.monotonic() < self.cooldown:
            return
        self.recording = True
        self.frames = []
        self.started = self.last_speech = time.monotonic()
        self.heard_speech = False
        self.runtime.log('Awake. Listening for your command…')
        self.runtime.schedule(self.runtime.state('listening'))

    def feed(self, samples):
        if not self.allowed():
            return
        if self.recording:
            self.frames.append(samples)
            level = float(np.sqrt(np.mean(samples ** 2)))
            self.runtime.ui.set_audio_level(min(1., level * 8))
            if level >= .012:
                self.heard_speech = True
                self.last_speech = time.monotonic()
        elif self.detector and time.monotonic() >= self.cooldown:
            self.detector.feed((np.clip(samples, -1, 1) * 32767).astype(np.int16))

    def finished(self, now):
        return self.recording and (now - self.started >= 30
            or (not self.heard_speech and now - self.started >= 8)
            or (self.heard_speech and now - self.last_speech >= 1.2))

    def pause(self):
        if self.stream:
            self.stream.stop()
            self.stream.close()
            self.stream = None
        self.frames = []
        self.recording = False
        self.cooldown = time.monotonic() + .5

    async def run(self):
        from core.audio_devices import resolve
        from memory.config_manager import get_input_device
        import sounddevice as sd
        loop = asyncio.get_running_loop()
        device_name = None
        retry_at = 0.
        try:
            while True:
                await asyncio.sleep(.08)
                if not self.allowed():
                    if self.stream or self.recording:
                        self.pause()
                    continue
                if time.monotonic() < retry_at:
                    continue
                try:
                    if not self.detector:
                        if not await asyncio.to_thread(is_ready):
                            self.runtime.log('Download the Hey Jarvis model in Settings → Wake Word.')
                            retry_at = time.monotonic() + 10
                            continue
                        detector = WakeWordDetector(
                            lambda: loop.call_soon_threadsafe(self.trigger),
                            logger=lambda msg: loop.call_soon_threadsafe(self.runtime.log, msg))
                        if not await asyncio.to_thread(detector.start):
                            retry_at = time.monotonic() + 10
                            continue
                        self.detector = detector
                        self.ready = True
                    selected = get_input_device()
                    if self.stream and selected != device_name:
                        self.pause()
                    if not self.stream:
                        device_name = selected
                        self.stream = sd.InputStream(samplerate=16000, channels=1,
                            blocksize=1280, dtype='float32', device=resolve(selected, 'input'),
                            callback=lambda data, frames, timing, status:
                                loop.call_soon_threadsafe(self.feed, data[:, 0].copy()))
                        self.stream.start()
                    if self.finished(time.monotonic()):
                        samples = np.concatenate(self.frames) if self.heard_speech and self.frames else None
                        self.pause()
                        if samples is not None:
                            await self.runtime.audio(samples)
                        else:
                            self.runtime.log('No command heard. Say Hey Jarvis to try again.')
                        self.cooldown = time.monotonic() + 1
                except Exception as exc:
                    self.pause()
                    self.runtime.log('Wake microphone unavailable: ' + str(exc))
                    retry_at = time.monotonic() + 10
        finally:
            self.pause()
            if self.detector:
                await asyncio.to_thread(self.detector.stop)
