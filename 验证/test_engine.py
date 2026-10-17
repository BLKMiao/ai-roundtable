import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import os
PROJECT = Path(__file__).resolve().parents[1]
os.chdir(PROJECT)
(PROJECT / 'work').mkdir(exist_ok=True)
sys.path.insert(0, str(PROJECT))
import core
import engine


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='work')
        self.folder = Path(self.temp.name)
        self.settings = engine.defaults()
        for p in engine.PLATFORMS:
            self.settings['_platforms'][p]['key'] = p + '-TEST-SECRET'
        self.ledger = engine.Ledger(self.folder)
        self.router = engine.Router(self.ledger)
        self.history = [dict(speaker='你', content='讨论一下', status='complete')]
        # the bundled price snapshot is dated; keep the tests independent of today's date
        engine.PRICE_DATES.update({p: time.strftime('%Y-%m-%d') for p in engine.PLATFORMS})

    def tearDown(self):
        self.temp.cleanup()

    def run_request(self, name='Claude', token=None, route=None, delta=None, prompt=None):
        return self.router.run(name, self.settings, self.history, token or core.Cancel(), delta or (lambda _: None), route or (lambda _: None), 1, 'round-1', image_prompt=prompt)

    def test_two_keys_encrypted_and_legacy_migration(self):
        old = core.defaults()
        for n, p in [('Claude', 'CherryIn'), ('GPT', 'AIHUBMIX'), ('Gemini', 'CherryIn')]:
            old[n].update(core.provider_preset(p, n), key=p + '-TEST-SECRET')
        core.save_settings(old, self.folder)
        migrated = engine.load_settings(self.folder)
        self.assertEqual(migrated['_platforms'], self.settings['_platforms'])
        self.assertTrue((self.folder / 'settings.before-v2.json').exists())
        migrated['_profile'].update(nickname='测试人', bio='只在本地的简介')
        engine.save_settings(migrated, self.folder)
        raw = (self.folder / 'settings.json').read_text(encoding='utf-8')
        self.assertNotIn('TEST-SECRET', raw)
        self.assertEqual(set(json.loads(raw)['platforms']), set(engine.PLATFORMS))
        self.assertEqual(engine.load_settings(self.folder)['_profile']['nickname'], '测试人')
        self.assertNotIn('TEST-SECRET', core.safe_error(Exception('CherryIn-TEST-SECRET'), migrated))

    def test_primary_to_same_model_context_role_and_partial_reset(self):
        calls, output, routes = [], [], []
        self.settings['Claude']['role'] = '提出反例'
        def call(cfg, instructions, prompt, token, delta, media):
            calls.append((cfg['model'], instructions, prompt))
            if cfg['provider'] == 'CherryIn':
                delta('主线路部分文字')
                raise TimeoutError('timed out')
            cfg['_usage']({'usage': {'input_tokens': 1000, 'output_tokens': 200}})
            delta('备用完整文字')
            return '备用完整文字'
        def route(p):
            routes.append(p)
            output.clear()
        with patch.object(core, 'api_reply', call):
            result, provider = self.run_request(route=route, delta=output.append)
        self.assertEqual(routes, ['CherryIn', 'AIHUBMIX'])
        self.assertEqual(provider, 'AIHUBMIX')
        self.assertEqual(output, ['备用完整文字'])
        self.assertEqual([c[0] for c in calls], [core.CHERRY_IDS['Claude'], core.MODEL_IDS['Claude']])
        self.assertEqual(calls[0][1:], calls[1][1:])
        self.assertIn('提出反例', calls[0][1])
        rows = self.ledger.rows()
        self.assertEqual(len(rows), 2)
        self.assertIsNone(rows[-1]['usd'])
        self.assertAlmostEqual(rows[0]['usd'], .004)
        self.assertIn('待核对', engine.Ledger.summary(rows))

    def test_primary_success_never_calls_backup_and_usage_snapshots_not_added(self):
        calls = []
        def call(cfg, *args):
            calls.append(cfg['provider'])
            cfg['_usage']({'response': {'usage': {'input_tokens': 1000, 'output_tokens': 20}}})
            cfg['_usage']({'response': {'usage': {'input_tokens': 1000, 'output_tokens': 200}}})
            return '完成'
        with patch.object(core, 'api_reply', call):
            self.run_request('GPT')
        self.assertEqual(calls, ['CherryIn'])
        self.assertAlmostEqual(self.ledger.rows()[0]['usd'], .004)

    def test_explicit_unavailability_falls_back(self):
        for status in (401, 402, 404, 429, 503):
            self.assertTrue(engine.can_fallback(core.APIError(status, 'unavailable')))
        self.assertTrue(engine.can_fallback(core.APIError(403, '余额不足')))
        self.assertFalse(engine.can_fallback(core.APIError(403, 'safety policy blocked')))
        self.assertFalse(engine.can_fallback(core.APIError(400, 'invalid image data')))
        self.assertFalse(engine.can_fallback(RuntimeError('回复被服务端截断：content_filter')))

    def test_cancel_does_not_fallback(self):
        calls = []
        token = core.Cancel()
        def call(cfg, instructions, prompt, cancel, *args):
            calls.append(cfg['provider'])
            cancel.stop()
            cancel.check()
        with patch.object(core, 'api_reply', call), self.assertRaises(core.Cancelled):
            self.run_request(token=token)
        self.assertEqual(calls, ['CherryIn'])
        self.assertEqual(self.ledger.rows()[0]['status'], '已停止')

    def test_both_errors_report_only_final_and_redact_keys(self):
        def call(cfg, *args):
            raise core.APIError(429, cfg['key'])
        with patch.object(core, 'api_reply', call), self.assertRaises(RuntimeError) as captured:
            self.run_request()
        self.assertIn('CherryIn', str(captured.exception))
        self.assertIn('AIHUBMIX', str(captured.exception))
        self.assertNotIn('TEST-SECRET', str(captured.exception))
        self.assertEqual(len(self.ledger.rows()), 2)

    def test_bio_opt_in_and_avatar_not_transmitted(self):
        self.settings['_profile'].update(nickname='小林', bio='私人背景', avatar='PRIVATE-PATH')
        prompts = []
        def call(cfg, instructions, *args):
            prompts.append(instructions)
            return '好的'
        with patch.object(core, 'api_reply', call):
            self.run_request()
            self.settings['_profile']['share_bio'] = True
            self.run_request()
        self.assertIn('小林', prompts[0])
        self.assertNotIn('私人背景', prompts[0])
        self.assertIn('私人背景', prompts[1])
        self.assertNotIn('PRIVATE-PATH', ''.join(prompts))

    def custom_settings(self):
        self.settings['_custom']['Custom1'].update(name='自家网关', base_url='https://gw.example.com/v1', key='GW-TEST-SECRET',
                                                   image_model='img-1', models={'Claude': 'cl-1', 'GPT': 'gp-1', 'Gemini': ''})

    def test_custom_line_priority_and_per_member_models(self):
        self.custom_settings()
        self.settings['_line_order'] = ['Custom1', 'CherryIn', 'AIHUBMIX', 'Custom2']
        seen = []
        def call(cfg, instructions, prompt, token, delta, media):
            seen.append((cfg['provider'], cfg['protocol'], cfg['model'], cfg['base_url']))
            return 'ok'
        with patch.object(core, 'api_reply', call):
            self.run_request('Claude')
            self.run_request('Gemini')                     # no model ID for Gemini on the custom line: skipped, not failed
        self.assertEqual(seen[0], ('Custom1', 'OpenAI 兼容', 'cl-1', 'https://gw.example.com/v1'))
        self.assertEqual(seen[1][0], 'CherryIn')
        req = core.make_request(engine.route(self.settings, 'GPT', 'Custom1'), 'sys', 'hi')
        self.assertEqual(req.full_url, 'https://gw.example.com/v1/chat/completions')
        self.assertEqual(req.get_header('Authorization'), 'Bearer GW-TEST-SECRET')
        self.assertEqual(json.loads(req.data)['model'], 'gp-1')

    def test_custom_line_only_and_unpriced_usage_is_pending(self):
        self.custom_settings()
        self.settings['_platforms'] = {p: {'key': ''} for p in engine.PLATFORMS}
        self.assertTrue(engine.connected(self.settings))
        def call(cfg, *args):
            cfg['_usage']({'usage': {'prompt_tokens': 100, 'completion_tokens': 20}})
            return 'ok'
        with patch.object(core, 'api_reply', call):
            _, provider = self.run_request('GPT')
        self.assertEqual(provider, 'Custom1')
        row = self.ledger.rows()[0]
        self.assertIsNone(row['usd'])                      # no public price for a custom gateway: honest "to be checked"
        with self.assertRaisesRegex(ValueError, '模型 ID'):
            self.run_request('Gemini')

    def test_custom_failure_falls_back_to_next_line_and_image_needs_image_model(self):
        self.custom_settings()
        self.settings['_line_order'] = ['Custom1', 'CherryIn', 'AIHUBMIX', 'Custom2']
        calls = []
        def call(cfg, *args):
            calls.append(cfg['provider'])
            if cfg['provider'] == 'Custom1':
                raise core.APIError(429, 'rate limit')
            return 'ok'
        with patch.object(core, 'api_reply', call):
            _, provider = self.run_request('GPT')
        self.assertEqual((calls, provider), (['Custom1', 'CherryIn'], 'CherryIn'))
        images = []
        def image(cfg, *args):
            images.append((cfg['provider'], cfg['image_model'], cfg['base_url']))
            return {'kind': 'image', 'path': 'x.png'}
        with patch.object(core, 'generate_image', image):
            self.run_request('GPT', prompt='画')
        self.assertEqual(images[0], ('Custom1', 'img-1', 'https://gw.example.com/v1'))

    def test_output_cap_defaults_user_override_and_every_protocol(self):
        caps = []
        def call(cfg, *args):
            caps.append((cfg['protocol'], cfg.get('max_tokens')))
            return 'ok'
        task = ('系统', '用户')
        with patch.object(core, 'api_reply', call):
            self.run_request('Claude')                                          # chat: Claude gets room for long answers
            self.router.run('Claude', self.settings, [], core.Cancel(), lambda _: None, lambda _: None, 1, 'r', task=task)
            self.router.run('GPT', self.settings, [], core.Cancel(), lambda _: None, lambda _: None, 1, 'r', task=task)
            self.settings['_limits'] = dict(chat=2000, write=50000)
            self.run_request('GPT')
            self.router.run('Gemini', self.settings, [], core.Cancel(), lambda _: None, lambda _: None, 1, 'r', task=task)
        self.assertEqual(caps, [('Claude Messages', 32000), ('Claude Messages', 32000), ('OpenAI Responses', None),
                                ('OpenAI Responses', 2000), ('Gemini 原生', 50000)])
        # what reaches the wire
        body = lambda protocol, name, n: json.loads(core.make_request(dict(engine.route(self.settings, name, 'CherryIn'), max_tokens=n), 's', 'p').data)
        self.assertEqual(body('Claude Messages', 'Claude', None)['max_tokens'], 8192)
        self.assertEqual(body('Claude Messages', 'Claude', 40000)['max_tokens'], 40000)
        self.assertEqual(body('OpenAI Responses', 'GPT', 9000)['max_output_tokens'], 9000)
        self.assertNotIn('max_output_tokens', body('OpenAI Responses', 'GPT', None))
        cfg = engine.route(self.settings, 'GPT', 'CherryIn')
        cfg.update(protocol='OpenAI 兼容', max_tokens=7000)
        self.assertEqual(json.loads(core.make_request(cfg, 's', 'p').data)['max_tokens'], 7000)
        gem = engine.route(self.settings, 'Gemini', 'AIHUBMIX')
        self.assertEqual(json.loads(core.make_request(dict(gem, max_tokens=12000), 's', 'p').data)['generationConfig'], {'maxOutputTokens': 12000})
        self.assertNotIn('generationConfig', json.loads(core.make_request(dict(gem, max_tokens=None), 's', 'p').data))
        self.assertEqual([engine.clean_limit(x) for x in ('', None, 'abc', 10, 300000, '4096', 32000)], [None, None, None, None, None, 4096, 32000])

    def test_native_gemini_video_routes_automatic(self):
        for p in engine.PLATFORMS:
            cfg = engine.route(self.settings, 'Gemini', p)
            req = core.make_request(cfg, 'system', 'text')
            self.assertIn('/models/', req.full_url)
            self.assertIn(':streamGenerateContent', req.full_url)
            self.assertEqual(cfg['protocol'], 'Gemini 原生')
        self.assertEqual(core.media_for([{'speaker': '你', 'attachments': [{'kind': 'video'}]}], 'Claude Messages'), [])

    def test_image_timeout_not_resubmitted(self):
        calls = []
        def image(cfg, *args):
            calls.append(cfg['provider'])
            raise TimeoutError('生成超时')
        with patch.object(core, 'generate_image', image), self.assertRaises(RuntimeError) as captured:
            self.run_request('GPT', prompt='画一朵花')
        self.assertEqual(calls, ['CherryIn'])
        self.assertIn('未重复提交', str(captured.exception))
        self.assertIsNone(self.ledger.rows()[0]['usd'])

    def test_image_explicit_rejection_uses_backup_specialist(self):
        calls = []
        def image(cfg, *args):
            calls.append(cfg['image_model'])
            if cfg['provider'] == 'CherryIn':
                raise core.APIError(404, 'model not found')
            cfg['_usage']({'usage': {'input_tokens': 100, 'output_tokens': 1000, 'input_tokens_details': {'text_tokens': 100, 'image_tokens': 0}}})
            return {'kind': 'image', 'path': 'test.png'}
        with patch.object(core, 'generate_image', image):
            result, provider = self.run_request('GPT', prompt='画一朵花')
        self.assertEqual(calls, ['openai/gpt-image-2', 'gpt-image-2'])
        self.assertEqual(provider, 'AIHUBMIX')
        self.assertEqual(self.ledger.rows()[0]['kind'], '生图')
        self.assertAlmostEqual(self.ledger.rows()[0]['usd'], .0305)

    def test_accounting_cache_reasoning_long_context_and_unknown(self):
        raw = dict(promptTokenCount=300000, candidatesTokenCount=500, thoughtsTokenCount=500, cachedContentTokenCount=100000)
        self.assertAlmostEqual(engine.estimate('AIHUBMIX', 'Gemini', raw, 'Gemini 原生'), .858)
        raw = dict(input_tokens=100, output_tokens=20, cache_read_input_tokens=1000, cache_creation_input_tokens=200)
        self.assertAlmostEqual(engine.estimate('AIHUBMIX', 'Claude', raw, 'Claude Messages'), .0011)
        self.assertAlmostEqual(engine.estimate('CherryIn', 'Claude', raw, 'Claude Messages'), .0011)
        self.assertIsNone(engine.estimate('AIHUBMIX', 'GPT', {}, 'OpenAI Responses'))

    def test_direct_chat_and_route_survive_reload(self):
        store = core.Store(self.folder)
        c = store.direct('Claude')
        self.assertEqual(store.direct('Claude'), c)
        self.assertNotEqual(store.direct('GPT'), c)
        store.add(c, 'Claude', '你好', route='AIHUBMIX')
        store.db.close()
        store = core.Store(self.folder)
        self.assertEqual(store.target(c), 'Claude')
        self.assertEqual(store.messages(c)[0]['route'], 'AIHUBMIX')
        store.db.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
