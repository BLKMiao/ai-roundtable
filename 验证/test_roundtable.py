import base64
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import os
PROJECT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT)
(PROJECT / 'work').mkdir(exist_ok=True)
sys.path.insert(0, str(PROJECT))
import core
import engine
from PIL import Image

requests = []

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        requests.append((self.path, None, dict(self.headers)))
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'data': [{'id': 'gpt-6.1-sol'}, {'id': 'claude-sonnet-5-5'},
                                             {'id': 'gemini-3.1-pro-preview'}]}).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append((self.path, body, dict(self.headers)))
        if self.path.endswith('/images/generations'):
            png = io.BytesIO()
            Image.new('RGB', (20, 20), '#467c63').save(png, 'PNG')
            result = {'data': [{'b64_json': base64.b64encode(png.getvalue()).decode()}]}
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        if self.path.endswith('/fail/chat/completions'):
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"invalid test-key"}}')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        if self.path.endswith('/responses'):
            events = [dict(type='response.output_text.delta', delta='你好'), dict(type='response.completed', response={'usage': {'input_tokens': 100, 'output_tokens': 20}})]
        elif self.path.endswith('/messages'):
            events = [dict(type='message_start', message={'usage': {'input_tokens': 100}}), dict(type='content_block_delta', delta=dict(type='text_delta', text='你好')), dict(type='message_delta', usage={'output_tokens': 20}), dict(type='message_stop')]
        elif ':streamGenerateContent' in self.path:
            events = [dict(candidates=[dict(content={'parts': [{'text': '你好'}]}, finishReason='STOP')], usageMetadata={'promptTokenCount': 100, 'candidatesTokenCount': 20})]
        elif '/slow/' in self.path:
            time.sleep(2)
            events = [dict(choices=[dict(delta={'content': 'too late'}, finish_reason='stop')])]
        elif '/broken/' in self.path:
            events = [dict(choices=[dict(delta={'content': 'partial'})])]
        else:
            events = [dict(choices=[dict(delta={'content': '你好'}, finish_reason='stop')], usage={'prompt_tokens': 100, 'completion_tokens': 20})]
        try:
            for event in events:
                self.wfile.write(('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='work')
        self.folder = Path(self.temp.name).resolve()
        self.old_data = core.DATA
        core.DATA = self.folder
        self.cfg = core.defaults()
        for c in self.cfg.values():
            c.update(base_url=self.base, key='test-key', model='test-model')

    def tearDown(self):
        core.DATA = self.old_data
        self.temp.cleanup()

    def test_platform_presets_and_native_catalog_route(self):
        for provider, ids in [('CherryIn', core.CHERRY_IDS), ('AIHUBMIX', core.MODEL_IDS)]:
            for name in core.NAMES:
                preset = core.provider_preset(provider, name)
                self.assertEqual(preset['model'], ids[name])
                cfg = dict(preset, key='test-key')
                req = core.make_request(cfg, 'role', 'hello')
                payload = json.loads(req.data)
                if name == 'Gemini' and provider == 'AIHUBMIX':
                    self.assertEqual(req.full_url, 'https://aihubmix.com/gemini/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse')
                    self.assertEqual(req.get_header('X-goog-api-key'), 'test-key')
                else:
                    self.assertEqual(payload['model'], ids[name])
                    self.assertEqual(req.get_header('Authorization'), 'Bearer test-key')
                catalog = core.model_list_request(cfg)
                origin = 'https://open.cherryin.net' if provider == 'CherryIn' else 'https://aihubmix.com'
                self.assertEqual(catalog.full_url, origin + '/v1/models')
                self.assertEqual(catalog.get_header('Authorization'), 'Bearer test-key')
        cfg = dict(self.cfg['GPT'], protocol='OpenAI 兼容')
        self.assertEqual(core.fetch_models(cfg), sorted(core.MODEL_IDS.values()))

    def test_legacy_settings_migration_keeps_keys_and_custom_models(self):
        legacy = copy.deepcopy(self.cfg)
        legacy['Gemini'].update(protocol='Gemini 官方', base_url='https://aihubmix.com/gemini/v1beta', model='chosen-custom-model')
        for cfg in legacy.values():
            cfg.pop('provider')
        core.save_settings(legacy, self.folder)
        loaded = core.load_settings(self.folder)
        self.assertEqual(loaded['Gemini']['provider'], 'AIHUBMIX')
        self.assertEqual(loaded['Gemini']['protocol'], 'Gemini 原生')
        self.assertEqual(loaded['Gemini']['model'], 'chosen-custom-model')
        self.assertEqual(loaded['Gemini']['key'], 'test-key')

    def media(self):
        src = self.folder / 'original.png'
        Image.new('RGBA', (2400, 1200), (23, 67, 82, 120)).save(src)
        item = core.import_media(src, self.folder)
        with Image.open(item['path']) as image:
            self.assertEqual(image.size, (2048, 1024))
        video = self.folder / 'small.mp4'
        video.write_bytes(b'mock-video-bytes')
        return item, core.import_media(video, self.folder)

    def test_encrypted_key_round_trip_and_redaction(self):
        core.save_settings(self.cfg, self.folder)
        content = (self.folder / 'settings.json').read_text('utf-8')
        self.assertNotIn('test-key', content)
        self.assertEqual(core.load_settings(self.folder)['Claude']['key'], 'test-key')
        self.assertNotIn('test-key', core.safe_error(Exception('bad test-key'), self.cfg))

    def test_storage_history_attachments_and_failed_exclusion(self):
        store = core.Store(self.folder)
        chat = store.create()
        image, video = self.media()
        store.add(chat, '你', '看一下图片', attachments=[image])
        store.add(chat, 'Claude', '未完成的意见', status='cancelled')
        records = store.messages(chat)
        self.assertEqual(records[0]['attachments'][0]['name'], 'original.png')
        transcript, cut = core.context(records)
        self.assertEqual(len(transcript), 1)
        self.assertFalse(cut)
        self.assertEqual(core.media_for(records, 'Claude 官方'), [image])
        store.db.close()

    def test_all_four_protocols_text_and_image_payloads(self):
        image, video = self.media()
        for protocol in core.PROTOCOLS:
            with self.subTest(protocol=protocol):
                cfg = dict(self.cfg['GPT'], protocol=protocol)
                chunks = []
                usage = engine.Usage()
                cfg['_usage'] = usage.collect
                result = core.api_reply(cfg, '角色', '分析图片', core.Cancel(), chunks.append, [image])
                self.assertEqual(result, '你好')
                self.assertEqual(chunks, ['你好'])
                self.assertEqual(engine.normalize(usage.snapshot(), protocol)['output'], 20)
                path, payload, headers = requests[-1]
                serialized = json.dumps(payload, ensure_ascii=False)
                self.assertIn('original.png', serialized)
                self.assertIn(base64.b64encode(Path(image['path']).read_bytes()).decode(), serialized)
                self.assertNotIn('test-key', serialized)

    def test_video_only_sent_to_gemini(self):
        image, video = self.media()
        history = [dict(speaker='你', content='评一下视频', attachments=[image, video])]
        self.assertEqual(core.media_for(history, 'Claude 官方'), [image])
        self.assertEqual(core.media_for(history, 'Gemini 官方'), [image, video])
        cfg = dict(self.cfg['Gemini'], protocol='Gemini 官方')
        core.api_reply(cfg, '角色', '分析视频', core.Cancel(), lambda _: None, [video])
        payload = requests[-1][1]
        self.assertEqual(payload['contents'][0]['parts'][-1]['inlineData']['mimeType'], 'video/mp4')

    def test_image_generation_file_and_endpoint(self):
        cfg = dict(self.cfg['GPT'], image_model='gpt-image-test')
        item = core.generate_image(cfg, '一幅图', core.Cancel())
        with Image.open(item['path']) as image:
            self.assertEqual(image.size, (20, 20))
        self.assertTrue(requests[-1][0].endswith('/images/generations'))
        self.assertNotIn('response_format', requests[-1][1])

    def test_missing_completion_is_error(self):
        cfg = dict(self.cfg['GPT'], protocol='OpenAI 兼容', base_url=self.base + '/broken')
        with self.assertRaisesRegex(RuntimeError, '完成标记'):
            core.api_reply(cfg, '角色', '问题', core.Cancel(), lambda _: None)

    def test_http_error_redaction(self):
        cfg = dict(self.cfg['GPT'], protocol='OpenAI 兼容', base_url=self.base + '/fail')
        with self.assertRaises(RuntimeError) as raised:
            core.api_reply(cfg, '角色', '问题', core.Cancel(), lambda _: None)
        self.assertIn('401', str(raised.exception))
        self.assertNotIn('test-key', core.safe_error(raised.exception, self.cfg))

    def test_stop_returns_promptly_and_never_emits_late_text(self):
        cfg = dict(self.cfg['GPT'], protocol='OpenAI 兼容', base_url=self.base + '/slow')
        token, chunks = core.Cancel(), []
        threading.Timer(0.2, token.stop).start()
        started = time.monotonic()
        with self.assertRaises(core.Cancelled):
            core.api_reply(cfg, '角色', '问题', token, chunks.append)
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertEqual(chunks, [])

    def test_endpoint_and_attachment_path_validation(self):
        for base in ['http://example.com/v1', 'https://api.example.com/v1?key=SECRET', 'ftp://example.com', 'https://user:pw@example.com']:
            with self.assertRaises(ValueError):
                core.endpoint(base, 'responses')
        source = self.folder / 'outside.png'
        source.write_bytes(b'dummy')
        with self.assertRaises(ValueError):
            core.encoded(dict(path=str(source)))


if __name__ == '__main__':
    unittest.main(verbosity=2)
