"""Regression tests for the local speech / subscription boundary."""
import asyncio
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch, Mock
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'Mark-LV'))
from core.codex_client import CodexClient, CodexError
from core.local_voice import LocalTranscriber, LocalVoice, spoken_text
from codex_runtime import schema

class Writer:
    def __init__(self):
        self.messages = asyncio.Queue()
    def write(self, data):
        self.messages.put_nowait(json.loads(data))
    async def drain(self):
        pass

class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = CodexClient()
        self.client.process = Mock(returncode=None)
        self.client.process.stdin = Writer()
        self.client.process.stdout = asyncio.StreamReader()
        self.reader = asyncio.create_task(self.client._read())
    def feed(self, message):
        self.client.process.stdout.feed_data((json.dumps(message) + '\n').encode())
    async def asyncTearDown(self):
        self.client.process.stdout.feed_eof()
        await self.reader
    async def test_reply_can_arrive_before_turn_start_response(self):
        task = asyncio.create_task(self.client.turn('thread-test', 'Hello'))
        sent = await self.client.process.stdin.messages.get()
        self.feed({'method': 'item/completed', 'params': {'threadId': 'thread-test', 'item': {'type': 'agentMessage', 'text': 'Good evening.'}}})
        self.feed({'method': 'turn/completed', 'params': {'threadId': 'thread-test', 'turn': {'status': 'completed'}}})
        self.feed({'id': sent['id'], 'result': {'turn': {'id': 'turn-test'}}})
        self.assertEqual(await task, 'Good evening.')
    async def test_disconnect_unblocks_requests(self):
        task = asyncio.create_task(self.client.request('account/read'))
        await self.client.process.stdin.messages.get()
        self.client.process.stdout.feed_eof()
        with self.assertRaises(CodexError):
            await task
    async def test_api_key_auth_is_not_subscription_auth(self):
        with patch.object(self.client, 'request', return_value={'account': {'type': 'apiKey'}}):
            self.assertFalse((await self.client.account())['signed_in'])
            with self.assertRaises(CodexError):
                await self.client.new_thread('test')
    async def test_dynamic_tool_response(self):
        async def handler(method, params):
            return {'success': True, 'contentItems': [{'type': 'inputText', 'text': 'Done'}]}
        self.client.server_request = handler
        self.feed({'id': 'server-1', 'method': 'item/tool/call', 'params': {'tool': 'jarvis_test'}})
        response = await self.client.process.stdin.messages.get()
        self.assertEqual(response['id'], 'server-1')
        self.assertTrue(response['result']['success'])

class VoiceTests(unittest.TestCase):
    def test_xtts_uses_isolated_client_and_stop_closes_it(self):
        voice = LocalVoice(model_name='xtts-v2')
        client = Mock()
        client.synthesize.return_value = (np.zeros(100, dtype=np.int16), 24000)
        with patch('core.xtts_client.XttsClient', return_value=client), patch('sounddevice.stop'):
            samples, rate = voice.synthesize('**Ready.**')
            client.synthesize.assert_called_once_with('Ready.', 1.0)
            self.assertEqual(rate, 24000)
            voice.stop()
            client.close.assert_called_once()

    def test_xtts_reports_missing_optional_environment(self):
        from core.xtts_client import XttsClient
        client = XttsClient()
        with patch('core.xtts_client.ROOT', Path('missing-xtts-test-folder')):
            with self.assertRaisesRegex(RuntimeError, 'install_xtts.py'):
                client.synthesize('Hello', 1.)

    def test_kokoro_converts_float_audio_and_uses_british_voice(self):
        voice = LocalVoice(model_name='kokoro-bm_george', length_scale=1.25)
        voice.voice = Mock()
        voice.voice.create.return_value = (np.array([-2., 0., 2.], dtype=np.float32), 24000)
        samples, rate = voice.synthesize('**Ready.**')
        self.assertEqual(samples.tolist(), [-32767, 0, 32767])
        self.assertEqual(rate, 24000)
        voice.voice.create.assert_called_once_with('Ready.', voice='bm_george', speed=.8, lang='en-gb')

    def test_missing_kokoro_model_reports_install_without_downloading(self):
        with patch('core.local_voice.MODELS', Path('missing-test-model-directory')):
            with self.assertRaisesRegex(RuntimeError, 'Run install_mark55.py'):
                LocalVoice().synthesize('Hello')

    def test_silence_never_loads_a_model_or_creates_text(self):
        recognizer = LocalTranscriber()
        self.assertEqual(recognizer.transcribe(np.zeros(16000, dtype=np.float32)), '')
        self.assertIsNone(recognizer.model)
    def test_speech_cleanup_preserves_words(self):
        self.assertEqual(spoken_text('**Ready.** [Details](https://example.com)\n```python\nprint(1)\n```'),
                         'Ready. Details\nThe code is shown on screen.')
    def test_failed_synthesis_releases_speaking_gate(self):
        voice = LocalVoice()
        with patch.object(voice, 'synthesize', side_effect=RuntimeError('missing voice')):
            with self.assertRaises(RuntimeError):
                voice.speak('hello')
        self.assertFalse(voice.speaking.is_set())
    def test_gemini_never_runs_in_subscription_mode(self):
        from core import gemini
        with patch('memory.config_manager.load_api_keys', return_value={'llm_provider': 'codex'}):
            with self.assertRaises(RuntimeError):
                gemini.client(key='unused')
            with self.assertRaises(RuntimeError):
                gemini.call('hello', key='unused')
    def test_recursive_tool_schema(self):
        self.assertEqual(schema({'type': 'OBJECT', 'properties': {'a': {'type': 'ARRAY', 'items': {'type': 'STRING'}}}}),
            {'type': 'object', 'properties': {'a': {'type': 'array', 'items': {'type': 'string'}}}})

if __name__ == '__main__':
    unittest.main()
