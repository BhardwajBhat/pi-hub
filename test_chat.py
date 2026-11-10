"""Offline tests: fake Pi RPC process, no credentials or model calls."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from unittest.mock import patch

from chat import ChatStore

FAKE_PI = '''import json, sys
messages = []
for line in sys.stdin.buffer:
    c = json.loads(line)
    kind = c['type']
    data = {}
    if kind == 'get_state':
        data = {'model': {'provider': 'test', 'id': 'fake'}, 'thinkingLevel': 'off'}
    elif kind == 'get_messages':
        data = {'messages': messages}
    elif kind == 'prompt':
        if c['message'] == 'reject':
            print(json.dumps(dict(type='response', id=c['id'], command=kind,
                                  success=False, error='Rejected prompt')), flush=True)
            continue
        user = dict(role='user', content=c['message'])
        reply = dict(role='assistant', content=[dict(type='text', text='Hello \\u2028 world')])
        for e in [dict(type='agent_start'), dict(type='message_end', message=user),
                  dict(type='message_start', message=dict(role='assistant', content=[])),
                  dict(type='message_update', assistantMessageEvent=dict(type='text_delta', contentIndex=0, delta='Hello')),
                  dict(type='message_end', message=reply), dict(type='agent_settled')]:
            print(json.dumps(e), flush=True)
        messages += [user, reply]
        data = {'disposition': 'started'}
    print(json.dumps(dict(type='response', id=c['id'], command=kind, success=True, data=data)), flush=True)
'''


class ChatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"PIHUB_DATA_DIR": str(self.root / "data")})
        self.env.start()
        fake = self.root / 'fake.py'
        fake.write_text(FAKE_PI)
        self.store = ChatStore(shlex.join([sys.executable, str(fake)]))

    def tearDown(self):
        self.store.shutdown()
        self.env.stop()
        self.temp.cleanup()

    def test_rpc_and_persistence(self):
        c = self.store.create('Example', str(self.root))
        c.prompt('Hi')
        deadline = time.monotonic() + 3
        while c.busy and time.monotonic() < deadline:
            time.sleep(.01)
        state = c.snapshot()
        self.assertFalse(state['busy'])
        self.assertEqual(state['model'], 'test/fake')
        self.assertEqual(len(state['messages']), 2)
        self.assertEqual(state['messages'][1]['content'][0]['text'], 'Hello \u2028 world')
        self.assertIsNone(state['partial'])
        # Wait for the reader's atomic save, then simulate a fresh server.
        self.store.save()
        other = ChatStore(self.store.agent)
        self.assertEqual(other.get(c.record['id']).snapshot()['messages'], state['messages'])

    def test_rejection_is_visible(self):
        c = self.store.create('Example', str(self.root))
        with self.assertRaisesRegex(ValueError, 'Rejected prompt'):
            c.prompt('reject')
        self.assertFalse(c.busy)
        self.assertEqual(c.snapshot()['error'], 'Rejected prompt')

    def test_partial_replaced_by_final(self):
        c = self.store.create('Example', str(self.root))
        c._event({'type': 'message_start', 'message': {'role': 'assistant', 'content': []}})
        c._event({'type': 'message_update', 'assistantMessageEvent':
                  {'type': 'text_delta', 'contentIndex': 0, 'delta': 'partial'}})
        self.assertEqual(c.snapshot()['partial']['content'][0]['text'], 'partial')
        c._event({'type': 'message_end', 'message': {'role': 'assistant', 'content': 'final'}})
        self.assertIsNone(c.partial)
        self.assertEqual(c.snapshot()['messages'][0]['content'], 'final')

    def test_invalid_directory(self):
        with self.assertRaisesRegex(ValueError, 'Directory does not exist'):
            self.store.create('Bad', str(self.root / 'missing'))

    def test_missing_executable(self):
        self.store.agent = '/nonexistent/pi'
        c = self.store.create('Bad', str(self.root))
        with self.assertRaises(OSError):
            c.prompt('Hi')
        self.assertFalse(c.busy)

    def test_http_routes(self):
        spec = importlib.util.spec_from_file_location('hub', Path(__file__).with_name('pi-hub.py'))
        hub = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hub)
        hub.CHATS = self.store
        hub.USER = hub.PASS = ''
        server = hub.ThreadingHTTPServer(('127.0.0.1', 0), hub.Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        try:
            with urlopen(base + '/') as r:
                self.assertIn(b'Conversations', r.read())
            data = urlencode({'name': '<script>test</script>', 'cwd': str(self.root)}).encode()
            with urlopen(Request(base + '/chat/new', data=data)) as r:
                ident = json.load(r)['id']
            with urlopen(base + '/chat/state?id=' + ident) as r:
                self.assertEqual(json.load(r)['name'], '<script>test</script>')
            with self.assertRaises(HTTPError) as cm:
                urlopen(Request(base + '/chat/send', data=urlencode({'id': ident, 'text': 'Hi'}).encode(),
                                headers={'Origin': 'https://evil.example'}))
            self.assertEqual(cm.exception.code, 403)
            cm.exception.close()
            with self.assertRaises(HTTPError) as cm:
                urlopen(base + '/chat/state?id=missing')
            self.assertEqual(cm.exception.code, 404)
            cm.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join()


if __name__ == '__main__':
    unittest.main()
