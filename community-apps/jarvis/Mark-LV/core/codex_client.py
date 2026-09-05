"""Codex app-server client using the supported ChatGPT-managed sign-in flow.

Credentials remain in Codex. No API keys or OAuth tokens are read by Jarvis.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess

class CodexError(RuntimeError):
    pass


def find_codex():
    executable = os.environ.get('JARVIS_CODEX_EXE') or shutil.which('codex.exe') or shutil.which('codex')
    if executable:
        return executable
    root = Path(os.environ.get('LOCALAPPDATA', '')) / 'OpenAI/Codex/bin'
    matches = sorted(root.glob('*/codex.exe'), key=lambda p: p.stat().st_mtime, reverse=True)
    if matches:
        return str(matches[0])
    raise CodexError('Install Codex and sign in with ChatGPT, then restart JARVIS.')


class CodexClient:
    def __init__(self, notify=None, server_request=None):
        self.notify = notify
        self.server_request = server_request
        self.process = None
        self.pending = {}
        self.sequence = 0
        self.jobs = set()
        self.turns = {}
        self.reader = None

    async def start(self):
        env = dict(os.environ)
        # Subscription mode must never silently fall back to pay-as-you-go.
        for key in ('OPENAI_API_KEY', 'CODEX_API_KEY'):
            env.pop(key, None)
        self.process = await asyncio.create_subprocess_exec(
            find_codex(), '-c', 'forced_login_method="chatgpt"', 'app-server',
            '--listen', 'stdio://', stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=8 * 1024 * 1024, env=env,
            **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
        self.reader = asyncio.create_task(self._read())
        await self.request('initialize', {'clientInfo': {'name': 'jarvis_mark55', 'version': '55.1'},
                                          'capabilities': {'experimentalApi': True}})
        await self.send({'method': 'initialized', 'params': {}})

    async def send(self, message):
        if not self.process or self.process.returncode is not None:
            raise CodexError('Codex has stopped. Restart JARVIS to reconnect.')
        self.process.stdin.write((json.dumps(message) + '\n').encode())
        await self.process.stdin.drain()

    async def request(self, method, params=None, timeout=45):
        self.sequence += 1
        request_id = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            await self.send({'id': request_id, 'method': method, 'params': params or {}})
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(request_id, None)

    async def _respond(self, message):
        try:
            result = await self.server_request(message['method'], message.get('params', {})) if self.server_request else None
            if result is None:
                await self.send({'id': message['id'], 'error': {'code': -32601, 'message': 'Unsupported request'}})
            else:
                await self.send({'id': message['id'], 'result': result})
        except Exception as exc:
            await self.send({'id': message['id'], 'error': {'code': -32000, 'message': str(exc)}})

    async def _read(self):
        error = CodexError('Codex connection closed. Restart JARVIS to reconnect.')
        try:
            while line := await self.process.stdout.readline():
                message = json.loads(line)
                if 'id' in message and 'method' in message:
                    job = asyncio.create_task(self._respond(message))
                    self.jobs.add(job)
                    job.add_done_callback(self.jobs.discard)
                elif 'id' in message:
                    future = self.pending.get(message['id'])
                    if future and not future.done():
                        if 'error' in message:
                            future.set_exception(CodexError(message['error'].get('message', 'Codex request failed')))
                        else:
                            future.set_result(message.get('result', {}))
                else:
                    method, params = message.get('method'), message.get('params', {})
                    state = self.turns.get(params.get('threadId'))
                    if state and method == 'item/completed':
                        item = params.get('item', {})
                        if item.get('type') == 'agentMessage' and item.get('phase') != 'commentary':
                            state['messages'].append(item.get('text', ''))
                    if state and method == 'turn/completed' and not state['future'].done():
                        turn = params['turn']
                        if turn.get('status') == 'completed':
                            state['future'].set_result('\n\n'.join(state['messages']))
                        else:
                            detail = (turn.get('error') or {}).get('message', turn.get('status', 'failed'))
                            state['future'].set_exception(CodexError(detail))
                    if self.notify:
                        self.notify(method, params)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            error = CodexError(str(exc))
        finally:
            for future in list(self.pending.values()) + [s['future'] for s in self.turns.values()]:
                if not future.done():
                    future.set_exception(error)

    async def account(self):
        result = await self.request('account/read', {'refreshToken': False})
        account = result.get('account') or {}
        return {'signed_in': account.get('type') == 'chatgpt', 'plan': account.get('planType')}

    async def login(self):
        result = await self.request('account/login/start', {'type': 'chatgpt'})
        return result['authUrl']

    async def new_thread(self, instructions, tools=None):
        if not (await self.account())['signed_in']:
            raise CodexError('Sign in with ChatGPT using the panel button or type /login.')
        result = await self.request('thread/start', {
            'cwd': str(Path(__file__).resolve().parents[1]), 'modelProvider': 'openai',
            'approvalPolicy': 'on-request', 'sandbox': 'read-only',
            'ephemeral': True, 'developerInstructions': instructions,
            'dynamicTools': tools or [],
        })
        return result['thread']['id']

    async def turn(self, thread_id, text, timeout=240):
        if thread_id in self.turns:
            raise CodexError('A request is already active.')
        future = asyncio.get_running_loop().create_future()
        self.turns[thread_id] = {'future': future, 'messages': []}
        turn_id = None
        try:
            response = await self.request('turn/start', {'threadId': thread_id,
                'input': [{'type': 'text', 'text': text}]})
            turn_id = response['turn']['id']
            self.turns[thread_id]['turn_id'] = turn_id
            return await asyncio.wait_for(asyncio.shield(future), timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            if turn_id:
                await self.request('turn/interrupt', {'threadId': thread_id, 'turnId': turn_id})
            raise
        finally:
            self.turns.pop(thread_id, None)
            if not future.done():
                future.cancel()

    async def interrupt(self, thread_id):
        state = self.turns.get(thread_id)
        if state and state.get('turn_id'):
            await self.request('turn/interrupt', {'threadId': thread_id, 'turnId': state['turn_id']})

    async def close(self):
        for job in list(self.jobs):
            job.cancel()
        if self.jobs:
            await asyncio.gather(*self.jobs, return_exceptions=True)
        if self.process and self.process.returncode is None:
            self.process.terminate()
            await self.process.wait()
        if self.reader:
            await self.reader
