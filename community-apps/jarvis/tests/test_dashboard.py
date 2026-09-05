import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'Mark-LV'))
from dashboard import quake

class DashboardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'config').mkdir()
        (root / 'config' / 'api_keys.json').write_text(json.dumps({'quake_pin': 'TEST55'}))
        self.patch = patch.object(quake, 'BASE_DIR', root)
        self.patch.start()
        self.dashboard = quake.QuakeDashboard()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.dashboard.app), base_url='http://127.0.0.1:8000')

    async def asyncTearDown(self):
        await self.client.aclose()
        self.patch.stop()
        self.temp.cleanup()

    async def test_health_and_authentication(self):
        self.assertEqual((await self.client.get('/api/health')).json(), {'version': '55'})
        self.assertEqual((await self.client.post('/login', json={'pin': 'wrong'})).status_code, 401)
        for route in ['metrics', 'remote-pairing', 'files', 'codex/status']:
            self.assertEqual((await self.client.get('/api/' + route)).status_code, 401)
        for route in ['toggle_mute', 'show_ui', 'command', 'codex/login', 'voice/preview']:
            self.assertEqual((await self.client.post('/api/' + route, json={})).status_code, 401)

    async def test_reconnect_and_command(self):
        for _ in range(2):
            response = await self.client.post('/login', json={'pin': 'test55'})
            self.assertEqual(response.status_code, 200)
        headers = {'Authorization': 'Bearer ' + response.json()['token']}
        result = await self.client.post('/api/command', headers=headers, json={'text': 'hello'})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(await self.dashboard._command_queue.get(), 'hello')
        self.assertEqual((await self.client.get('/api/files', headers=headers)).status_code, 200)
        self.assertEqual((await self.client.post('/api/show_ui', headers=headers)).status_code, 503)

    async def test_controls_and_metrics(self):
        from unittest.mock import Mock
        response = await self.client.post('/login', json={'pin': 'TEST55'})
        headers = {'Authorization': 'Bearer ' + response.json()['token']}
        controls = Mock()
        self.dashboard.controls = controls
        for endpoint in ['toggle_mute', 'show_ui']:
            self.assertEqual((await self.client.post('/api/' + endpoint, headers=headers)).status_code, 200)
        controls.mute.emit.assert_called_once_with()
        controls.show.emit.assert_called_once_with()
        response = await self.client.get('/api/metrics', headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertTrue({'cpu', 'mem', 'net', 'gpu', 'tmp', 'uptime', 'proc_count'} <= response.json().keys())

    async def test_subscription_buttons(self):
        from unittest.mock import AsyncMock, Mock
        response = await self.client.post('/login', json={'pin': 'TEST55'})
        headers = {'Authorization': 'Bearer ' + response.json()['token']}
        runtime = Mock(busy=False, login=AsyncMock(return_value={'ok': True}), submit=AsyncMock(),
                       status=AsyncMock(return_value={'signed_in': True}))
        self.dashboard.runtime = runtime
        self.assertEqual((await self.client.post('/api/codex/login', headers=headers)).status_code, 200)
        runtime.login.assert_awaited_once()
        self.assertEqual((await self.client.post('/api/voice/preview', headers=headers)).status_code, 200)
        runtime.submit.assert_awaited_once_with('/preview')
        runtime.busy = True
        self.assertEqual((await self.client.post('/api/voice/preview', headers=headers)).status_code, 409)

    async def test_cors(self):
        for origin, allowed in [('http://127.0.0.1:3000', True), ('https://example.com', False)]:
            response = await self.client.options('/login', headers={'Origin': origin,
                'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type'})
            self.assertEqual('access-control-allow-origin' in response.headers, allowed)

if __name__ == '__main__':
    unittest.main()
