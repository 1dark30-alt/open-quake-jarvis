"""Authenticated compatibility endpoints for the local Open Quake panel.

The integrated mode binds only to loopback. Run main.py for upstream LAN pairing.
"""
import asyncio
import json
import secrets
import time
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from dashboard.server import DashboardServer, BASE_DIR, PORT

class QuakeDashboard(DashboardServer):
    controls = None

    def _build_app(self):
        app = super()._build_app()
        app.add_middleware(CORSMiddleware,
            allow_origin_regex=r'https?://(127\.0\.0\.1|localhost)(:[0-9]+)?',
            allow_methods=['GET', 'POST'], allow_headers=['Authorization', 'Content-Type'])
        # Replace just the local pairing route. Upstream remote keys stay one-use.
        app.router.routes[:] = [r for r in app.router.routes
            if not (getattr(r, 'path', '') == '/login' and 'POST' in getattr(r, 'methods', set()))]

        def authorized(req):
            token = req.headers.get('authorization', '').removeprefix('Bearer ').strip()
            return bool(token) and token in self._tokens

        @app.get('/api/health')
        async def health():
            return {'version': '55'}

        @app.post('/login')
        async def login(req: Request):
            body = await req.json()
            entered = str(body.get('pin', '')).strip().upper()
            config = json.loads((BASE_DIR / 'config' / 'api_keys.json').read_text(encoding='utf-8'))
            expected = config.get('quake_pin', 'QUAKE').strip().upper()
            if not entered or not secrets.compare_digest(entered, expected):
                return JSONResponse({'error': 'Invalid PIN'}, status_code=401)
            token = secrets.token_urlsafe(32)
            self._tokens.add(token)
            self._token_keys[token] = entered
            self._aes_key(entered)
            if self._connect_callback:
                self._connect_callback()
            return {'ok': True, 'token': token}

        @app.post('/api/toggle_mute')
        async def mute(req: Request):
            if not authorized(req):
                return JSONResponse({'error': 'Unauthorized'}, status_code=401)
            if self.controls is None:
                return JSONResponse({'error': 'Desktop unavailable'}, status_code=503)
            self.controls.mute.emit()
            return {'ok': True}

        @app.post('/api/show_ui')
        async def show(req: Request):
            if not authorized(req):
                return JSONResponse({'error': 'Unauthorized'}, status_code=401)
            if self.controls is None:
                return JSONResponse({'error': 'Desktop unavailable'}, status_code=503)
            self.controls.show.emit()
            return {'ok': True}

        @app.get('/api/metrics')
        async def metrics(req: Request):
            if not authorized(req):
                return JSONResponse({'error': 'Unauthorized'}, status_code=401)
            from actions.system_monitor import get_system_status
            import psutil
            data = await asyncio.to_thread(get_system_status)
            counters = psutil.net_io_counters()
            now, total = time.monotonic(), counters.bytes_sent + counters.bytes_recv
            previous = getattr(self, '_net_sample', (now, total))
            rate = max(0, total - previous[1]) / max(now - previous[0], .001) / 1024**2
            self._net_sample = (now, total)
            return {'cpu': data['cpu_percent'], 'mem': data['ram_percent'], 'net': rate,
                    'gpu': data['gpu_percent'] if data['gpu_percent'] is not None else -1,
                    'tmp': data['cpu_temp_c'] if data['cpu_temp_c'] is not None else -1,
                    'uptime': data['uptime'], 'proc_count': data['process_count']}

        @app.get('/api/remote-pairing')
        async def pairing(req: Request):
            if not authorized(req):
                return JSONResponse({'error': 'Unauthorized'}, status_code=401)
            return {'manual_url': 'Local panel mode. Run Mark-LV/main.py for LAN access.', 'key': 'LOCAL ONLY'}
        return app

    @staticmethod
    def _ssl_enabled():
        return False

    def get_url(self):
        return f'http://127.0.0.1:{PORT}'

    def get_manual_url(self):
        return self.get_url()

    async def serve(self):
        await uvicorn.Server(uvicorn.Config(self.app, host='127.0.0.1', port=PORT,
                                           log_level='warning')).serve()
