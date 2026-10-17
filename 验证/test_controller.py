"""Tests for the headless controller and the local HTTP/SSE bridge (no real API calls, no UI toolkit)."""
import copy
import http.client
import json
import os
import queue
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT)
(PROJECT / 'work').mkdir(exist_ok=True)
sys.path.insert(0, str(PROJECT / 'vendor'))
sys.path.insert(0, str(PROJECT))
import core
import engine
from controller import Controller, ConfigError, CONTINUE_PROMPT
from server import Server
from PIL import Image


def wait_for(inbox, kind, timeout=6):
    end = time.monotonic() + timeout
    seen = []
    while time.monotonic() < end:
        try:
            event = inbox.get(timeout=.1)
        except queue.Empty:
            continue
        seen.append(event)
        if event['type'] == kind:
            return event, seen
    raise AssertionError(f'no {kind} event; saw {[e["type"] for e in seen]}')


class ControllerCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='work')
        self.folder = Path(self.temp.name).resolve()
        self.old_data = core.DATA
        self.app = Controller(self.folder)
        for p in engine.PLATFORMS:
            self.app.settings['_platforms'][p]['key'] = p + '-TEST-SECRET'
        self.calls = []
        self.fail = {}
        self.app.router.run = self.fake_run
        self.inbox = self.app.subscribe()

    def tearDown(self):
        self.app.shutdown()
        self.app.store.db.close()
        self.app.writer.store.db.close()
        core.DATA = self.old_data
        self.temp.cleanup()

    def fake_run(self, name, settings, history, token, on_delta, on_route, chat, round_id, image_prompt=None, image_size=None):
        self.calls.append((name, copy.deepcopy(history), image_prompt, image_size))
        self.fresh = getattr(self, 'fresh', []) + [bool(settings.get('_fresh_turn'))]
        if name in self.fail:
            raise self.fail[name]
        on_route('CherryIn')
        if image_prompt:
            path = self.folder / 'attachments' / 'generated-test.png'
            path.parent.mkdir(exist_ok=True)
            Image.new('RGB', (8, 8), '#336699').save(path)
            return dict(name='生成的图片.png', path=str(path), kind='image', mime='image/png'), 'CherryIn'
        for piece in (name + ' ', '的意见'):
            token.check()
            on_delta(piece)
        return name + ' 的意见', 'CherryIn'

    def run_and_wait(self, chat, text='聊聊', **kw):
        self.app.send(chat, text, **kw)
        return wait_for(self.inbox, 'run_end')

    def media(self, kind='video'):
        if kind == 'video':
            return self.app.upload('clip.mp4', b'fake-video-bytes')
        import io
        buf = io.BytesIO()
        Image.new('RGB', (40, 30), '#aa5533').save(buf, 'PNG')
        return self.app.upload('shot.png', buf.getvalue())

    def test_round_order_shared_history_and_events(self):
        chat = self.app.new_chat()
        end, seen = self.run_and_wait(chat, '我们聊聊这个想法')
        self.assertEqual(end['status'], 'complete')
        self.assertEqual([c[0] for c in self.calls], ['Claude', 'GPT', 'Gemini'])
        # a new question: everyone answers on their own first (nobody sees the others' replies of this round)
        self.assertEqual([c[1][-1]['speaker'] for c in self.calls], ['你', '你', '你'])
        self.assertEqual(self.fresh, [True, True, True])
        kinds = [e['type'] for e in seen]
        self.assertEqual(kinds.count('turn_start'), 3)
        self.assertEqual(kinds.count('turn_end'), 3)
        self.assertIn('delta', kinds)
        self.assertEqual([m['speaker'] for m in self.app.chat(chat)['messages']], ['你', 'Claude', 'GPT', 'Gemini'])
        self.assertEqual(self.app.chat(chat)['messages'][1]['route'], 'CherryIn')

    def test_video_goes_to_gemini_first_and_upload_limits(self):
        chat = self.app.new_chat()
        video = self.media('video')
        self.assertEqual(video['kind'], 'video')
        self.run_and_wait(chat, '看看这个视频', upload_ids=[video['id']])
        self.assertEqual([c[0] for c in self.calls], ['Gemini', 'Claude', 'GPT'])
        with self.assertRaisesRegex(ValueError, '失效'):
            self.app.send(chat, 'x', upload_ids=[video['id']])   # already consumed
        many = [self.media('image')['id'] for _ in range(5)]
        with self.assertRaisesRegex(ValueError, '最多'):
            self.app.send(chat, 'x', upload_ids=many)

    def test_target_mention_direct_and_disabled_members(self):
        chat = self.app.new_chat()
        self.run_and_wait(chat, '只问你', target='GPT')
        self.assertEqual([c[0] for c in self.calls], ['GPT'])
        self.calls.clear()
        self.run_and_wait(chat, '@Gemini 你怎么看', target='GPT')          # mention wins over the target menu
        self.assertEqual([c[0] for c in self.calls], ['Gemini'])
        self.calls.clear()
        self.app.set_muted(chat, 'Claude', True)
        self.run_and_wait(chat, '都来说说')
        self.assertEqual([c[0] for c in self.calls], ['GPT', 'Gemini'])
        self.calls.clear()
        self.run_and_wait(chat, '@Claude 你被禁言但被点名')
        self.assertEqual([c[0] for c in self.calls], ['Claude'])          # an explicit @ overrides the mute
        self.app.set_muted(chat, 'GPT', True)
        with self.assertRaisesRegex(ValueError, '至少'):
            self.app.set_muted(chat, 'Gemini', True)
        self.assertEqual(self.app.chat(chat)['muted'], ['Claude', 'GPT'])
        self.assertEqual(self.app.chat(self.app.new_chat())['muted'], [])   # per discussion, not global
        self.calls.clear()
        direct = self.app.direct_chat('Claude')
        self.run_and_wait(direct, '@GPT 这是 Claude 的单聊')
        self.assertEqual([c[0] for c in self.calls], ['Claude'])

    def test_speaking_order_per_chat(self):
        chat = self.app.new_chat()
        other = self.app.new_chat() if False else None
        self.app.set_order(chat, ['Gemini', 'Claude', 'GPT'])
        self.run_and_wait(chat, '换个顺序')
        self.assertEqual([c[0] for c in self.calls], ['Gemini', 'Claude', 'GPT'])
        self.assertEqual(self.app.chat(chat)['order'], ['Gemini', 'Claude', 'GPT'])
        with self.assertRaises(ValueError):
            self.app.set_order(chat, ['Gemini', 'Claude'])
        self.assertEqual(self.app.store.order(chat + 99), ['Claude', 'GPT', 'Gemini'])

    def test_empty_send_continues_discussion_and_rounds(self):
        chat = self.app.new_chat()
        with self.assertRaisesRegex(ValueError, '说点什么'):
            self.app.send(chat, '')
        self.run_and_wait(chat, '开始', rounds=2)
        self.assertEqual(len(self.calls), 6)
        self.assertEqual(self.fresh, [True] * 3 + [False] * 3)                   # round 2: they respond to each other
        self.assertEqual(self.calls[3][1][-1]['speaker'], 'Gemini')
        self.assertEqual(self.calls[4][1][-1]['speaker'], 'Claude')
        self.calls.clear()
        self.fresh = []
        self.run_and_wait(chat, '')
        self.assertEqual(self.calls[0][1][-1]['content'], CONTINUE_PROMPT)
        self.assertEqual(self.fresh, [False] * 3)                                 # "让大家继续聊" is a discussion turn
        self.assertEqual(self.calls[1][1][-1]['speaker'], 'Claude')
        prompt_new = core.prompt_for('GPT', {}, self.calls[0][1], fresh=True)[1]
        self.assertIn('独立给出你自己的想法', prompt_new)
        self.assertIn('不要猜测、复述或点评他们', prompt_new)
        self.assertIn('至少 3 个彼此差异明显的想法', prompt_new)
        self.assertNotIn('独立给出', core.prompt_for('GPT', {}, self.calls[0][1])[1])

    def test_follow_up_presets_choose_independent_or_discussion_rounds(self):
        from controller import PRESETS
        chat = self.app.new_chat()
        with self.assertRaisesRegex(ValueError, '说点什么'):
            self.app.send(chat, '', preset='more')
        self.run_and_wait(chat, '给我几个故事方向')
        self.calls.clear(); self.fresh = []
        self.run_and_wait(chat, '', preset='more')                    # more proposals: independent again
        self.assertEqual(self.fresh, [True] * 3)
        self.assertEqual([c[1][-1]['content'] for c in self.calls], [PRESETS['more']['text']] * 3)
        self.calls.clear(); self.fresh = []
        self.run_and_wait(chat, '', preset='review')                  # review: they read each other
        self.assertEqual(self.fresh, [False] * 3)
        self.assertEqual(self.calls[1][1][-1]['speaker'], 'Claude')
        self.calls.clear(); self.fresh = []
        self.run_and_wait(chat, '', preset='sum', target='GPT')       # sum up: one member
        self.assertEqual([c[0] for c in self.calls], ['GPT'])
        self.assertEqual(self.app.chat(chat)['messages'][-2]['content'], PRESETS['sum']['text'])
        with self.assertRaisesRegex(ValueError, '快捷'):
            self.app.send(chat, '', preset='nope')
        boot = self.app.bootstrap()['presets']
        self.assertEqual(set(boot), set(PRESETS))
        self.assertEqual(boot['review']['mode'], 'discuss')

    def test_one_failure_does_not_stop_the_round_and_can_be_retried(self):
        chat = self.app.new_chat()
        self.fail['GPT'] = RuntimeError('CherryIn：HTTP 500：boom')
        end, _ = self.run_and_wait(chat, '出错测试')
        self.assertEqual(end['status'], 'partial')
        messages = self.app.chat(chat)['messages']
        self.assertEqual([(m['speaker'], m['status']) for m in messages],
                         [('你', 'complete'), ('Claude', 'complete'), ('GPT', 'error'), ('Gemini', 'complete')])
        self.assertIn('boom', messages[2]['note'])
        del self.fail['GPT']
        self.calls.clear()
        self.app.retry(chat, messages[2]['id'])
        wait_for(self.inbox, 'run_end')
        after = self.app.chat(chat)['messages']
        self.assertEqual([c[0] for c in self.calls], ['GPT'])
        self.assertEqual([m['speaker'] for m in self.calls[0][1]], ['你'])     # a retried first-round answer stays independent
        self.assertEqual(self.fresh[-1], True)
        self.assertTrue(all(m['status'] == 'complete' for m in after))
        self.assertEqual(len(after), 4)
        with self.assertRaisesRegex(ValueError, '不需要'):
            self.app.retry(chat, after[1]['id'])

    def test_repeated_failures_abort_and_config_errors_stop_at_once(self):
        chat = self.app.new_chat()
        self.fail.update(Claude=RuntimeError('down'), GPT=RuntimeError('down'), Gemini=RuntimeError('down'))
        end, _ = self.run_and_wait(chat, '全挂了')
        self.assertEqual(end['status'], 'error')
        self.assertEqual(len(self.calls), 2)              # stops after two failures in a row
        self.calls.clear()
        self.fail.update(Claude=ValueError('密钥错误'))
        end, _ = self.run_and_wait(chat, '配置错误')
        self.assertEqual(end['status'], 'error')
        self.assertEqual(len(self.calls), 1)

    def test_stop_keeps_partial_reply_and_ends_round(self):
        chat = self.app.new_chat()
        started = threading.Event()
        def slow(name, settings, history, token, on_delta, on_route, chat_id, round_id, image_prompt=None, image_size=None):
            on_route('CherryIn')
            on_delta('写到一半')
            started.set()
            while True:
                token.check()
                time.sleep(.02)
        self.app.router.run = slow
        self.app.send(chat, '开始')
        self.assertTrue(started.wait(3))
        self.app.stop()
        end, _ = wait_for(self.inbox, 'run_end')
        self.assertEqual(end['status'], 'cancelled')
        last = self.app.chat(chat)['messages'][-1]
        self.assertEqual((last['speaker'], last['status'], last['content']), ('Claude', 'cancelled', '写到一半'))
        self.assertFalse(self.app.busy)
        self.assertEqual(len(self.app.chat(chat)['messages']), 2)   # later members never spoke

    def test_busy_guard_and_missing_keys(self):
        chat = self.app.new_chat()
        gate = threading.Event()
        def blocked(name, settings, history, token, on_delta, on_route, chat_id, round_id, image_prompt=None, image_size=None):
            gate.wait(3)
            return 'ok', 'CherryIn'
        self.app.router.run = blocked
        self.app.send(chat, '开始')
        with self.assertRaisesRegex(ValueError, '还在进行'):
            self.app.send(chat, '再来一条')
        with self.assertRaisesRegex(ValueError, '正在回复'):
            self.app.delete_chat(chat)
        gate.set()
        wait_for(self.inbox, 'run_end')
        for p in engine.PLATFORMS:
            self.app.settings['_platforms'][p]['key'] = ''
        with self.assertRaises(ConfigError):
            self.app.send(chat, '没有密钥')

    def test_image_generation_and_retry_of_failed_image(self):
        chat = self.app.new_chat()
        self.app.generate_image(chat, '一张圆桌', '1536x1024')
        end, _ = wait_for(self.inbox, 'run_end')
        self.assertEqual(end['status'], 'complete')
        self.assertEqual(self.calls[0][2:], ('一张圆桌', '1536x1024'))
        message = self.app.chat(chat)['messages'][-1]
        self.assertEqual(message['speaker'], '图片生成')
        self.assertTrue(message['attachments'][0]['url'].startswith('/files/attachments/'))
        self.fail['GPT'] = RuntimeError('超时')
        self.app.generate_image(chat, '再来一张')
        wait_for(self.inbox, 'run_end')
        failed = self.app.chat(chat)['messages'][-1]
        self.assertEqual(failed['status'], 'error')
        del self.fail['GPT']
        self.app.retry(chat, failed['id'])
        wait_for(self.inbox, 'run_end')
        self.assertEqual(self.calls[-1][2], '再来一张')
        self.assertEqual(self.app.chat(chat)['messages'][-1]['status'], 'complete')

    def test_chat_management(self):
        first = self.app.new_chat()
        self.assertEqual(self.app.new_chat(), first)        # blank chats are reused, not piled up
        attach = self.media('image')
        self.run_and_wait(first, '', upload_ids=[attach['id']])
        self.assertEqual(dict(self.app.store.chats())[first], 'shot.png')   # attachment-only message still gets a title
        self.app.rename_chat(first, '  我的想法  ')
        self.assertEqual(self.app.chat(first)['title'], '我的想法')
        second = self.app.new_chat()
        self.assertNotEqual(first, second)
        overview = self.app.chats()
        self.assertEqual([c['id'] for c in overview], [first, second])   # active chats first
        files = list((self.folder / 'attachments').glob('*'))
        self.assertTrue(files)
        self.app.delete_chat(first)
        self.assertFalse(self.app.store.exists(first))
        self.assertFalse(any(f.name == Path(attach['url']).name for f in (self.folder / 'attachments').glob('*')))
        with self.assertRaises(ValueError):
            self.app.chat(first)

    def test_settings_never_expose_keys_and_null_keeps_existing(self):
        self.app.save_settings(dict(platforms=dict(CherryIn=dict(key='sk-abcdefghijklmnop'), AIHUBMIX=dict(key=None)),
                                    profile=dict(nickname='  小林 ', bio='背景', share_bio=True),
                                    members=dict(GPT=dict(role='整理会议纪要'), Claude=dict(role='   '))))
        boot = self.app.bootstrap()
        self.assertNotIn('abcdefghijklmnop', json.dumps(boot, ensure_ascii=False))
        line = {x['id']: x for x in boot['lines']}
        self.assertEqual(line['CherryIn']['mask'], 'sk-••••mnop')
        self.assertTrue(line['AIHUBMIX']['configured'])            # null = unchanged
        self.assertEqual(boot['profile']['nickname'], '小林')
        self.assertEqual(next(m for m in boot['members'] if m['name'] == 'Claude')['role'], core.ROLES['Claude'])
        raw = (self.folder / 'settings.json').read_text('utf-8')
        self.assertNotIn('abcdefghijklmnop', raw)
        self.assertEqual(engine.load_settings(self.folder)['_platforms']['CherryIn']['key'], 'sk-abcdefghijklmnop')
        self.app.save_settings(dict(platforms=dict(CherryIn=dict(key=''))))
        self.assertFalse({x['id']: x for x in self.app.bootstrap()['lines']}['CherryIn']['configured'])

    def test_custom_lines_save_order_and_never_expose_key(self):
        self.app.save_settings(dict(
            custom=dict(Custom1=dict(name='公司网关', base_url='https://gw.example.com/v1/chat/completions/', key='sk-custom-secret-1234',
                                     models=dict(Claude='claude-x', GPT='gpt-x', Gemini=''), image_model='img-x')),
            line_order=['Custom1', 'CherryIn']))
        boot = self.app.bootstrap()
        self.assertNotIn('custom-secret', json.dumps(boot, ensure_ascii=False))
        self.assertEqual([x['id'] for x in boot['lines']], ['Custom1', 'CherryIn', 'AIHUBMIX', 'Custom2'])
        self.assertEqual(boot['primary'], 'Custom1')
        custom = boot['lines'][0]
        self.assertEqual((custom['name'], custom['base_url'], custom['models']['GPT']), ('公司网关', 'https://gw.example.com/v1', 'gpt-x'))
        self.assertNotIn('custom-secret', (self.folder / 'settings.json').read_text('utf-8'))
        again = engine.load_settings(self.folder)
        self.assertEqual(again['_custom']['Custom1']['key'], 'sk-custom-secret-1234')
        self.assertEqual(again['_line_order'][0], 'Custom1')
        with self.assertRaisesRegex(ValueError, 'https'):
            self.app.save_settings(dict(custom=dict(Custom2=dict(base_url='http://remote.example.com/v1'))))
        with self.assertRaisesRegex(ValueError, '接口地址'):
            self.app.save_settings(dict(custom=dict(Custom2=dict(key='abc', base_url=''))))
        self.assertNotIn('custom-secret', core.safe_error(Exception('boom sk-custom-secret-1234'), self.app.settings))

    def test_output_limits_are_validated_saved_and_reloaded(self):
        boot = self.app.bootstrap()['limits_tokens']
        self.assertEqual((boot['chat'], boot['write'], boot['write_default'], boot['chat_default']), (None, None, 32000, 32000))
        self.app.save_settings(dict(limits=dict(chat='4000', write=64000)))
        self.assertEqual(self.app.bootstrap()['limits_tokens']['write'], 64000)
        self.assertEqual(engine.load_settings(self.folder)['_limits'], dict(chat=4000, write=64000))
        with self.assertRaisesRegex(ValueError, '回复长度上限'):
            self.app.save_settings(dict(limits=dict(write='99')))
        with self.assertRaisesRegex(ValueError, '回复长度上限'):
            self.app.save_settings(dict(limits=dict(write='abc')))
        self.assertEqual(self.app.settings['_limits']['write'], 64000)               # a rejected save changes nothing
        self.app.save_settings(dict(limits=dict(write='', chat=None)))               # blank = back to the defaults
        self.assertEqual(engine.load_settings(self.folder)['_limits'], dict(chat=None, write=None))

    def test_usage_totals_and_reconcile(self):
        chat = self.app.new_chat()
        ident = self.app.ledger.begin(chat, 'r1', 'Claude', dict(provider='CherryIn', model='m'), '回复')
        self.app.ledger.finish(ident, dict(provider='CherryIn', protocol='Claude Messages'), 'Claude',
                               {'input_tokens': 1000, 'output_tokens': 200}, '完成')
        second = self.app.ledger.begin(chat, 'r1', 'GPT', dict(provider='CherryIn', model='m'), '回复')
        self.app.ledger.finish(second, dict(provider='CherryIn', protocol='OpenAI Responses'), 'GPT', {}, '完成')
        engine.PRICE_DATES['CherryIn'] = time.strftime('%Y-%m-%d')
        details = self.app.usage_details()
        self.assertEqual(details['total']['pending'], 1)
        self.assertTrue(details['total']['estimated'])
        self.assertIsNotNone(details['total']['credits'])
        self.assertIn('*', self.app.usage_summary(chat)['chat'])
        self.app.reconcile(second, 0.01)
        self.assertEqual(self.app.usage_details()['total']['pending'], 0)
        with self.assertRaises(ValueError):
            self.app.reconcile(second, -1)

    def test_export_markdown(self):
        chat = self.app.new_chat()
        self.run_and_wait(chat, '导出测试')
        title, text = self.app.export_markdown(chat)
        self.assertEqual(title, '导出测试')
        self.assertIn('## Claude Sonnet 5.5', text)
        self.assertIn('Gemini 的意见', text)


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='work')
        self.folder = Path(self.temp.name).resolve()
        self.old_data = core.DATA
        self.app = Controller(self.folder)
        self.server = Server(self.app)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_port
        self.cookie = 'rt=' + self.server.token

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.app.store.db.close()
        self.app.writer.store.db.close()
        core.DATA = self.old_data
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None, host=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        head = {'Host': host or f'127.0.0.1:{self.port}'}
        head.update(headers or {})
        conn.request(method, path, body=body, headers=head)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, data, response

    def test_token_host_and_origin_checks(self):
        self.assertEqual(self.request('GET', '/api/bootstrap')[0], 401)
        self.assertEqual(self.request('GET', '/api/bootstrap', headers={'Cookie': 'rt=wrong'})[0], 401)
        self.assertEqual(self.request('GET', '/api/bootstrap', headers={'Cookie': self.cookie}, host='evil.example:80')[0], 403)
        status, data, _ = self.request('GET', '/api/bootstrap', headers={'Cookie': self.cookie})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)['version'], '3.0')
        status, *_ = self.request('POST', '/api/chat/new', b'{}', {'Cookie': self.cookie, 'Origin': 'https://evil.example'})
        self.assertEqual(status, 403)
        status, data, _ = self.request('POST', '/api/chat/new', b'{}', {'Cookie': self.cookie, 'Origin': self.server.origin})
        self.assertEqual(status, 200)
        self.assertIn('id', json.loads(data))

    def test_page_sets_cookie_and_static_files_stay_inside_web(self):
        status, data, response = self.request('GET', '/?t=' + self.server.token)
        self.assertEqual(status, 200)
        self.assertIn('rt=' + self.server.token, response.getheader('Set-Cookie'))
        self.assertIn(b'AI', data)
        for path in ('/../core.py', '/%2e%2e/core.py', '/..%5ccore.py'):
            self.assertIn(self.request('GET', path, headers={'Cookie': self.cookie})[0], (404, 400))
        self.assertEqual(self.request('GET', '/files/attachments/..%2f..%2fsettings.json', headers={'Cookie': self.cookie})[0], 404)
        (self.folder / 'settings.json').write_text('{}')
        self.assertEqual(self.request('GET', '/files/profile/..%5c..%5csettings.json', headers={'Cookie': self.cookie})[0], 404)

    def test_errors_are_json_and_events_stream(self):
        status, data, _ = self.request('POST', '/api/send', json.dumps(dict(chat=999, text='hi')).encode(), {'Cookie': self.cookie})
        self.assertEqual(status, 400)
        self.assertIn('error', json.loads(data))
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        conn.request('GET', '/events', headers={'Cookie': self.cookie})
        response = conn.getresponse()
        self.assertEqual(response.getheader('Content-Type').split(';')[0], 'text/event-stream')
        deadline = time.monotonic() + 3
        while self.server.clients < 1 and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertEqual(self.server.clients, 1)
        self.app.emit('chats_changed')
        seen = b''
        while b'chats_changed' not in seen and time.monotonic() < deadline + 3:
            seen += response.fp.readline()
        self.assertIn(b'chats_changed', seen)
        conn.close()

    def test_upload_and_avatar_round_trip(self):
        import io
        buf = io.BytesIO()
        Image.new('RGB', (30, 30), '#445566').save(buf, 'PNG')
        status, data, _ = self.request('POST', '/api/upload?name=a%20b.png', buf.getvalue(), {'Cookie': self.cookie, 'Content-Type': 'image/png'})
        self.assertEqual(status, 200)
        item = json.loads(data)
        self.assertEqual(item['name'], 'a b.png')
        status, data, response = self.request('GET', item['url'], headers={'Cookie': self.cookie})
        self.assertEqual((status, response.getheader('Content-Type')), (200, 'image/jpeg'))
        status, data, _ = self.request('POST', '/api/avatar', buf.getvalue(), {'Cookie': self.cookie})
        self.assertEqual(status, 200)
        url = json.loads(data)['avatar']
        self.assertEqual(self.request('GET', url, headers={'Cookie': self.cookie})[0], 200)
        self.assertEqual(self.request('POST', '/api/upload?name=x.exe', b'MZ', {'Cookie': self.cookie})[0], 400)


if __name__ == '__main__':
    unittest.main(verbosity=2)
