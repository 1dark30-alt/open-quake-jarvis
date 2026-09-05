import asyncio
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'Mark-LV'))
from core.wake_capture import WakeCapture


class WakeTests(unittest.TestCase):
    def setUp(self):
        self.runtime = SimpleNamespace(ui=Mock(muted=False), busy=False,
            voice=SimpleNamespace(speaking=Mock(is_set=lambda: False)),
            capture=None, queue=asyncio.Queue(), log=Mock(), state=Mock(), schedule=Mock())
        self.wake = WakeCapture(self.runtime)
        self.wake.enabled = True

    def test_wake_requires_enabled_idle_unmuted_and_not_speaking(self):
        for field, value in [('busy', True), ('capture', object())]:
            original = getattr(self.runtime, field)
            setattr(self.runtime, field, value)
            self.wake.trigger()
            self.assertFalse(self.wake.recording)
            setattr(self.runtime, field, original)
        self.runtime.ui.muted = True
        self.wake.trigger()
        self.assertFalse(self.wake.recording)
        self.runtime.ui.muted = False
        self.runtime.voice.speaking.is_set = lambda: True
        self.wake.trigger()
        self.assertFalse(self.wake.recording)
        self.runtime.voice.speaking.is_set = lambda: False
        self.wake.enabled = False
        self.wake.trigger()
        self.assertFalse(self.wake.recording)

    def test_trigger_then_silence_ends_command_and_has_hard_timeout(self):
        self.wake.trigger()
        self.wake.feed(np.ones(1280, dtype=np.float32) * .1)
        self.assertTrue(self.wake.heard_speech)
        self.assertFalse(self.wake.finished(self.wake.last_speech + .5))
        self.assertTrue(self.wake.finished(self.wake.last_speech + 1.3))
        self.wake.last_speech = self.wake.started + 29.9
        self.assertTrue(self.wake.finished(self.wake.started + 30))

    def test_no_speech_times_out_without_submission(self):
        self.wake.trigger()
        self.wake.feed(np.zeros(1280, dtype=np.float32))
        self.assertFalse(self.wake.heard_speech)
        self.assertTrue(self.wake.finished(self.wake.started + 8))

    def test_pause_discards_audio_and_closes_mic(self):
        self.wake.trigger()
        self.wake.feed(np.ones(1280, dtype=np.float32))
        stream = self.wake.stream = Mock()
        self.wake.pause()
        stream.close.assert_called_once()
        self.assertEqual(self.wake.frames, [])
        self.assertFalse(self.wake.recording)

    def test_muted_frames_and_queued_requests_never_reach_detector(self):
        self.wake.detector = Mock()
        self.runtime.ui.muted = True
        self.wake.feed(np.ones(1280, dtype=np.float32))
        self.wake.detector.feed.assert_not_called()
        self.runtime.ui.muted = False
        self.runtime.queue.put_nowait('already pending')
        self.wake.trigger()
        self.assertFalse(self.wake.recording)

    def test_idle_audio_goes_to_local_detector_only(self):
        self.wake.detector = Mock()
        self.wake.feed(np.ones(1280, dtype=np.float32) * .5)
        data = self.wake.detector.feed.call_args.args[0]
        self.assertEqual(data.dtype, np.int16)
        self.assertEqual(len(self.wake.frames), 0)


if __name__ == '__main__':
    unittest.main()
