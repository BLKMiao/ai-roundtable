"""Writing mode: documents, versions, the three-AI workflow and its prompts (model calls are faked)."""
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
import writing
from controller import Controller


def wait_end(inbox, timeout=6):
    end, seen = time.monotonic() + timeout, []
    while time.monotonic() < end:
        try:
            ev = inbox.get(timeout=.1)
        except queue.Empty:
            continue
        seen.append(ev)
        if ev['type'] == 'run_end':
            return ev, seen
    raise AssertionError('no run_end; saw ' + str([e['type'] for e in seen]))


class WritingCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='work')
        self.folder = Path(self.temp.name).resolve()
        self.old_data = core.DATA
        self.app = Controller(self.folder)
        for p in engine.PLATFORMS:
            self.app.settings['_platforms'][p]['key'] = p + '-TEST'
        self.w = self.app.writer
        self.tasks, self.fail, self.truncate = [], {}, set()
        self.gate = None
        outer = self

        def fake_run(name, settings, history, token, on_delta, on_route, chat, round_id, image_prompt=None, image_size=None, task=None, label=None):
            outer.tasks.append((name, task, chat, label))
            if outer.gate:
                outer.gate.wait(3)
            if name in outer.fail:
                raise outer.fail[name]
            on_route('CherryIn')
            text = f'{name} 写的稿子' + (writing.MARK + '改了两处' if label and '润色' in label else '')
            for i in range(0, len(text), 4):
                token.check()
                on_delta(text[i:i + 4])
            if name in outer.truncate:
                raise RuntimeError('CherryIn：回复达到输出长度上限。可以提高上限后重试。')
            return text, 'CherryIn'
        self.app.router.run = fake_run
        self.inbox = self.app.subscribe()

    def tearDown(self):
        self.app.shutdown()
        self.app.store.db.close()
        self.w.store.db.close()
        core.DATA = self.old_data
        self.temp.cleanup()

    def doc(self, kind='article', work=''):
        return self.w.create(kind, '测试稿', work)

    def test_scene_definitions_are_complete(self):
        self.assertEqual(set(writing.SCENES), {'article', 'script', 'work', 'story'})
        for key, scene in writing.SCENES.items():
            self.assertEqual(set(writing.FOCUS[key]), set(core.NAMES))
            self.assertTrue(scene['actions'] and scene['chips'] and scene['rubric'])
            for act in scene['actions']:
                self.assertIn(act[3], ('replace', 'append', 'copy', 'brief'))
        self.assertEqual([a['key'] for a in self.w.scenes()['story']['actions']][-2:], ['storyboard', 'recap'])

    def test_create_save_versions_restore_and_works(self):
        a = self.doc('story', work='长夜')
        b = self.doc('story', work='长夜')
        self.assertEqual(self.w.get(a)['doc']['work_id'], self.w.get(b)['doc']['work_id'])
        self.w.save(a, dict(work_brief='主角是林川，怕黑', brief='第一章要求', body='第一版正文'))
        self.w.save(a, dict(body='第二版正文，更长一些', snapshot='采纳 GPT'))
        got = self.w.get(a)
        self.assertEqual((got['doc']['body'], got['doc']['words']), ('第二版正文，更长一些', 9))
        self.assertEqual([v['note'] for v in got['versions']], ['采纳 GPT'])
        self.assertEqual(self.w.get(b)['doc']['work_brief'], '主角是林川，怕黑')
        self.w.save(a, dict(body='又改了', snapshot='x'))
        version = got['versions'][0]['id']
        self.assertEqual(self.w.restore(a, version), '第一版正文')
        self.assertIn('恢复前', [v['note'] for v in self.w.get(a)['versions']])
        with self.assertRaises(ValueError):
            self.w.create('poem')
        self.w.delete(a)
        with self.assertRaises(ValueError):
            self.w.get(a)

    def test_three_drafts_run_in_parallel_with_context_and_usage_label(self):
        doc = self.doc('story', work='长夜')
        self.w.save(doc, dict(work_brief='设定：林川怕黑', brief='本章要求：他独自进入地下室', body='上一章结尾：灯灭了。'))
        res = self.w.start(doc, 'draft', prompt='续写下一章', use_body=True)
        self.assertEqual(res['started'], 3)
        end, seen = wait_end(self.inbox)
        self.assertEqual(end['status'], 'complete')
        self.assertEqual(sorted(t[0] for t in self.tasks), ['Claude', 'GPT', 'Gemini'])
        name, task, chat, label = self.tasks[0]
        self.assertEqual((chat, label), (-doc, '写作·起草'))
        system, user = task
        self.assertIn('设定：林川怕黑', user)
        self.assertIn('上一章结尾：灯灭了。', user)
        self.assertIn('续写下一章', user)
        self.assertIn(writing.FOCUS['story'][name], system)
        items = self.w.get(doc)['items']
        self.assertEqual([(i['kind'], i['status'], i['route']) for i in items], [('draft', 'complete', 'CherryIn')] * 3)
        kinds = [e['type'] for e in seen]
        self.assertEqual((kinds.count('w_item_start'), kinds.count('w_item_end')), (3, 3))
        self.assertIn('w_delta', kinds)
        self.assertFalse(self.app.busy)

    def test_one_failure_keeps_other_drafts(self):
        doc = self.doc()
        self.fail['GPT'] = RuntimeError('boom')
        self.w.start(doc, 'draft', prompt='写')
        end, _ = wait_end(self.inbox)
        self.assertEqual(end['status'], 'partial')
        by = {i['author']: i for i in self.w.get(doc)['items']}
        self.assertEqual((by['Claude']['status'], by['GPT']['status'], by['Gemini']['status']), ('complete', 'error', 'complete'))
        self.assertIn('boom', by['GPT']['note'])

    def test_stop_cancels_all_members_and_keeps_partial(self):
        doc = self.doc()
        self.gate = threading.Event()
        self.w.start(doc, 'draft', prompt='写')
        time.sleep(.3)
        self.app.stop()
        self.gate.set()
        end, _ = wait_end(self.inbox)
        self.assertEqual(end['status'], 'cancelled')
        self.assertTrue(all(i['status'] == 'cancelled' for i in self.w.get(doc)['items']))

    def test_stop_one_member_while_the_others_keep_writing(self):
        doc = self.doc()
        release = threading.Event()

        def slow(name, settings, history, token, on_delta, on_route, chat, round_id, image_prompt=None, image_size=None, task=None, label=None):
            on_route('CherryIn')
            on_delta(name + ' 写到一半')
            while not release.is_set():
                token.check()
                time.sleep(.02)
            return name + ' 写完了', 'CherryIn'
        self.app.router.run = slow
        self.w.start(doc, 'draft', prompt='写')
        deadline = time.monotonic() + 3
        while len(self.w.job_tokens) < 3 and time.monotonic() < deadline:
            time.sleep(.02)
        items = {i['author']: i for i in self.w.get(doc)['items']}
        self.assertEqual(len(self.w.job_tokens), 3)
        self.w.stop_item(items['GPT']['id'])
        self.w.stop_item(items['Gemini']['id'])
        time.sleep(.3)
        self.assertTrue(self.app.busy)                                    # Claude is still working, so the run goes on
        self.assertEqual(len(self.w.job_tokens), 1)
        release.set()
        end, _ = wait_end(self.inbox)
        self.assertEqual(end['status'], 'complete')                       # stopping individual cards is not a failure
        by = {i['author']: i for i in self.w.get(doc)['items']}
        self.assertEqual((by['Claude']['status'], by['Claude']['content']), ('complete', 'Claude 写完了'))
        self.assertEqual((by['GPT']['status'], by['GPT']['content']), ('cancelled', 'GPT 写到一半'))
        self.assertEqual(by['Gemini']['status'], 'cancelled')
        with self.assertRaisesRegex(ValueError, '已经结束'):
            self.w.stop_item(items['GPT']['id'])
        # stopping every card by hand ends the run as stopped
        release.clear()
        self.w.start(doc, 'draft', prompt='再写')
        while len(self.w.job_tokens) < 3 and time.monotonic() < deadline + 3:
            time.sleep(.02)
        for token_id in list(self.w.job_tokens):
            self.w.stop_item(token_id)
        end, _ = wait_end(self.inbox)
        self.assertEqual(end['status'], 'cancelled')

    def test_compare_merge_and_review_flow(self):
        doc = self.doc('article')
        with self.assertRaisesRegex(ValueError, '至少'):
            self.w.start(doc, 'compare')
        self.w.start(doc, 'draft', prompt='写一篇')
        wait_end(self.inbox)
        drafts = [i for i in self.w.get(doc)['items'] if i['kind'] == 'draft']
        self.tasks.clear()
        self.w.start(doc, 'compare', members=['Claude', 'Gemini'])
        wait_end(self.inbox)
        self.assertEqual(sorted(t[0] for t in self.tasks), ['Claude', 'Gemini'])
        user = self.tasks[0][1][1]
        for letter in ('稿 A', '稿 B', '稿 C'):
            self.assertIn(letter, user)
        reviews = [i for i in self.w.get(doc)['items'] if i['kind'] == 'review']
        self.assertEqual(len(reviews), 2)
        self.tasks.clear()
        self.w.start(doc, 'merge', members=['GPT'], base_item=drafts[1]['id'], prompt='语气更活泼')
        wait_end(self.inbox)
        self.assertEqual(len(self.tasks), 1)
        user = self.tasks[0][1][1]
        self.assertIn('底稿', user)
        self.assertIn('评审意见', user)
        self.assertIn('语气更活泼', user)
        self.assertIn(writing.MARK, self.tasks[0][1][0])
        merged = [i for i in self.w.get(doc)['items'] if i['kind'] == 'merge'][0]
        self.assertEqual(merged['meta']['base'], drafts[1]['id'])
        with self.assertRaisesRegex(ValueError, '正文'):
            self.w.start(doc, 'review')
        self.w.save(doc, dict(body='一段正文'))
        self.w.start(doc, 'review', members=['Claude'])
        wait_end(self.inbox)

    def test_polish_selection_context_actions_and_note_split(self):
        doc = self.doc('story')
        body = '前面一段。' * 5 + '林川推开门。' + '后面一段。' * 5
        self.w.save(doc, dict(body=body))
        start = body.index('林川推开门。')
        sel = dict(text='林川推开门。', start=start, end=start + 6)
        self.w.start(doc, 'polish', members=['Claude'], selection=sel, option='polish')
        wait_end(self.inbox)
        system, user = self.tasks[0][1]
        self.assertIn('【上文】', user)
        self.assertIn('【下文】', user)
        self.assertIn('林川推开门。', user)
        item = self.w.get(doc)['items'][0]
        self.assertEqual((item['kind'], item['content'], item['note']), ('edit', 'Claude 写的稿子', '改了两处'))
        self.assertEqual((item['meta']['selection'], item['meta']['start'], item['meta']['mode']), ('林川推开门。', start, 'replace'))
        self.w.start(doc, 'polish', members=['GPT'], selection=sel, option='storyboard')
        wait_end(self.inbox)
        self.assertIn('分镜', self.tasks[-1][1][1])
        self.assertEqual(self.w.get(doc)['items'][-1]['meta']['mode'], 'copy')
        self.w.start(doc, 'polish', members=['GPT'], option='recap')
        wait_end(self.inbox)
        self.assertEqual(self.w.get(doc)['items'][-1]['meta']['mode'], 'brief')
        with self.assertRaisesRegex(ValueError, '修改'):
            self.w.start(doc, 'polish', option='custom', prompt='')

    def test_rewrite_selection_and_revise_body_by_review(self):
        doc = self.doc('script')
        body = '开头一句。第二句话。结尾一句。'
        self.w.save(doc, dict(body=body))
        sel = dict(text='第二句话。', start=body.index('第二句'), end=body.index('第二句') + 5)
        self.w.start(doc, 'polish', members=['GPT'], selection=sel, option='rewrite')
        wait_end(self.inbox)
        self.assertIn('不同的写法重写', self.tasks[-1][1][1])
        self.assertEqual(self.w.get(doc)['items'][-1]['meta']['mode'], 'replace')
        with self.assertRaisesRegex(ValueError, '点评'):
            self.w.start(doc, 'revise', review_ids=[])
        self.w.start(doc, 'review', members=['Claude'])
        wait_end(self.inbox)
        review = [i for i in self.w.get(doc)['items'] if i['kind'] == 'review'][0]
        self.tasks.clear()
        self.w.start(doc, 'revise', members=['Claude', 'GPT'], review_ids=[review['id']], prompt='只改开头')
        wait_end(self.inbox)
        self.assertEqual(sorted(t[0] for t in self.tasks), ['Claude', 'GPT'])
        system, user = self.tasks[0][1]
        self.assertIn('评审意见', user)
        self.assertIn('只改开头', user)
        self.assertIn(body, user)
        self.assertIn(writing.MARK, system)
        edits = [i for i in self.w.get(doc)['items'] if i['kind'] == 'edit' and i['meta'].get('action') == '按点评修改']
        self.assertEqual(len(edits), 2)
        self.assertEqual((edits[0]['meta']['whole'], edits[0]['meta']['original']), (True, body))      # kept for the diff view
        self.w.save(doc, dict(body='长' * 13000))
        with self.assertRaisesRegex(ValueError, '选中'):
            self.w.start(doc, 'revise', review_ids=[review['id']])
        with self.assertRaisesRegex(ValueError, '选中'):
            self.w.start(doc, 'polish', option='oral')

    def test_rewrite_a_passage_of_a_draft_and_replace_it_in_the_draft(self):
        doc = self.doc('story')
        draft = self.w.store.add_item(doc, 'draft', 'Claude', 'complete', content='第一段。\n\n林川推开了门。\n\n第三段。', round_id='r1')
        other = self.w.store.add_item(doc, 'draft', 'GPT', 'complete', content='别的草稿', round_id='r1')
        with self.assertRaisesRegex(ValueError, '选中'):
            self.w.start(doc, 'polish', option='rewrite', source_item=draft, selection={})
        with self.assertRaisesRegex(ValueError, '找不到'):
            self.w.start(doc, 'polish', option='rewrite', source_item=9999, selection={'text': '林川推开了门。'})
        self.w.start(doc, 'polish', members=['Gemini'], option='rewrite', source_item=draft, selection={'text': '林川推开了门。'})
        wait_end(self.inbox)
        system, user = self.tasks[-1][1]
        self.assertIn('【上文】\n第一段。', user)
        self.assertIn('【下文】', user)
        self.assertIn('第三段。', user)
        self.assertIn('林川推开了门。', user)
        edit = [i for i in self.w.get(doc)['items'] if i['kind'] == 'edit'][0]
        self.assertEqual((edit['author'], edit['meta']['source'], edit['meta']['selection'], edit['meta']['start']), ('Gemini', draft, '林川推开了门。', 6))
        self.w.start(doc, 'polish', members=['GPT'], option='custom', prompt='再紧张一点', source_item=draft, selection={'text': '被改过的文字，不在草稿里'})
        wait_end(self.inbox)
        self.assertEqual(self.w.get(doc)['items'][-1]['meta']['start'], -1)       # not found verbatim: still rewritten, but no "replace in draft"
        self.w.set_item_content(draft, '第一段。\n\n改好的一段。\n\n第三段。')
        self.assertIn('改好的一段', self.w.store.item(draft)['content'])
        with self.assertRaisesRegex(ValueError, '草稿'):
            self.w.set_item_content(edit['id'], 'x')
        self.assertTrue(other)

    def test_marks_persist_and_blend_prompt_marks_the_new_pieces(self):
        doc = self.doc('article')
        body = '开头。新换的一段。中间。又一段新的。结尾。'
        a1 = body.index('新换的一段。')
        a2 = body.index('又一段新的。')
        self.w.save(doc, dict(body=body, marks=[[a1, a1 + 6], [a2, a2 + 6], [5, 5], ['x', 1]]))
        self.assertEqual(self.w.get(doc)['doc']['marks'], [[a1, a1 + 6], [a2, a2 + 6]])        # junk entries are dropped
        with self.assertRaisesRegex(ValueError, '没有需要融入'):
            self.w.start(doc, 'blend', marks=[])
        self.w.start(doc, 'blend', members=['GPT'], marks=[[a1, a1 + 6], [a2, a2 + 6]])
        wait_end(self.inbox)
        system, user = self.tasks[-1][1]
        self.assertIn('开头。⟦新换的一段。⟧中间。⟦又一段新的。⟧结尾。', user)
        self.assertIn('不要出现 ⟦ ⟧', system)
        edit = self.w.get(doc)['items'][-1]
        self.assertEqual((edit['meta']['action'], edit['meta']['whole'], edit['meta']['original'], edit['meta']['blend']), ('融入修改', True, body, True))
        self.w.save(doc, dict(body='x' * 14000, marks=[[100, 120], [13000, 13020]]))
        with self.assertRaisesRegex(ValueError, '太散'):
            self.w.start(doc, 'blend', marks=[[100, 120], [13000, 13020]])
        self.w.start(doc, 'blend', members=['Claude'], marks=[[6000, 6020], [6100, 6120]])           # long text: only the neighbourhood is sent
        wait_end(self.inbox)
        meta = self.w.get(doc)['items'][-1]['meta']
        self.assertEqual((meta['whole'], meta['start'], meta['end']), (False, 5200, 6920))
        self.w.save(doc, dict(body='x' * 14001, snapshot='存档'))
        self.w.save(doc, dict(body='y', marks=[[0, 1]]))
        version = self.w.get(doc)['versions'][0]['id']
        self.w.restore(doc, version)
        self.assertEqual(self.w.get(doc)['doc']['marks'], [])                       # an old version has no meaningful marks

    def test_output_limit_keeps_the_text_and_continue_appends_to_the_same_draft(self):
        doc = self.doc('story')
        self.truncate = {'Claude'}
        self.w.start(doc, 'draft', members=['Claude', 'GPT'], prompt='写第一章')
        end, _ = wait_end(self.inbox)
        self.assertEqual(end['status'], 'complete')                                  # not a failure
        by = {i['author']: i for i in self.w.get(doc)['items']}
        self.assertEqual((by['Claude']['status'], by['Claude']['meta']['truncated'], by['Claude']['content']), ('complete', True, 'Claude 写的稿子'))
        self.assertIn('接着写', by['Claude']['note'])
        self.assertFalse(by['GPT']['meta'].get('truncated'))
        self.assertEqual(self.tasks[0][1][0].count('限制'), 0)
        self.truncate = set()
        self.tasks.clear()
        self.w.start(doc, 'continue', source_item=by['Claude']['id'])
        wait_end(self.inbox)
        system, user = self.tasks[0][1]
        self.assertEqual(self.tasks[0][0], 'Claude')
        self.assertIn('从最后一句自然接续', system)
        self.assertIn('写第一章', user)
        self.assertIn('Claude 写的稿子', user)
        again = [i for i in self.w.get(doc)['items'] if i['id'] == by['Claude']['id']][0]
        self.assertEqual((again['status'], again['meta']['truncated']), ('complete', False))
        self.assertEqual(again['content'], 'Claude 写的稿子\n\nClaude 写的稿子')
        self.assertEqual(len(self.w.get(doc)['items']), 2)                            # appended in place, no extra card
        with self.assertRaisesRegex(ValueError, '续写'):
            self.w.start(doc, 'continue', source_item=99999)

    def test_two_modules_critique_continue_favorites_and_cleanup(self):
        doc = self.doc('story')
        with self.assertRaisesRegex(ValueError, '没有可续写'):
            self.w.start(doc, 'draft', option='continue')
        self.w.save(doc, dict(body='第一章的内容。林川关上门。'))
        self.w.start(doc, 'draft', members=['Claude'], prompt='让他发现一封信', option='continue')
        wait_end(self.inbox)
        system, user = self.tasks[-1][1]
        self.assertEqual(self.tasks[-1][3], '写作·续写')
        self.assertIn('第一章的内容。林川关上门。', user)
        self.assertIn('让他发现一封信', user)
        self.assertIn('只输出新增的部分', user)
        cont = self.w.get(doc)['items'][-1]
        self.assertTrue(cont['meta']['continue'])
        # review, then "generate": one card carrying the critique AND the new version
        self.w.start(doc, 'review', members=['GPT'])
        wait_end(self.inbox)
        review = [i for i in self.w.get(doc)['items'] if i['kind'] == 'review'][0]
        self.tasks.clear()
        self.w.start(doc, 'critique', members=['Claude', 'Gemini'], review_ids=[review['id']], prompt='节奏再快一点')
        wait_end(self.inbox)
        self.assertEqual(self.tasks[0][3], '写作·点评修改')
        system, user = self.tasks[0][1]
        self.assertIn('点评与修改说明', system)
        self.assertIn(writing.MARK, system)
        self.assertIn('已有评审意见', user)
        self.assertIn('节奏再快一点', user)
        combos = [i for i in self.w.get(doc)['items'] if i['meta'].get('combo')]
        self.assertEqual(len(combos), 2)
        self.assertEqual((combos[0]['meta']['whole'], combos[0]['meta']['mode'], combos[0]['meta']['original']), (True, 'replace', '第一章的内容。林川关上门。'))
        self.tasks.clear()
        self.w.start(doc, 'critique', members=['GPT'])
        wait_end(self.inbox)
        self.assertNotIn('已有评审意见', self.tasks[0][1][1])                          # works without any prior review too
        # favorites survive a cleanup of everything else
        self.w.set_favorite(combos[0]['id'], True)
        self.w.set_favorite(cont['id'], True)
        before = len(self.w.get(doc)['items'])
        removed = self.w.clean_items(doc, ['review', 'edit'])
        after = self.w.get(doc)['items']
        self.assertEqual(len(after), before - removed)
        self.assertIn(combos[0]['id'], [i['id'] for i in after])
        self.assertIn(cont['id'], [i['id'] for i in after])                           # drafts were not in the cleaned kinds
        self.assertTrue(all(i['meta'].get('fav') for i in after if i['kind'] in ('review', 'edit')))
        self.w.set_favorite(combos[0]['id'], False)
        self.assertFalse(self.w.store.item(combos[0]['id'])['meta']['fav'])
        with self.assertRaises(ValueError):
            self.w.set_favorite(99999, True)

    def test_auto_checkpoints_dedupe_and_previews(self):
        doc = self.doc()
        self.w.save(doc, dict(body='手写的第一段'))                      # first text: nothing earlier to keep
        self.assertEqual(self.w.get(doc)['versions'], [])
        self.w.save(doc, dict(body='手写的第一段，又加了一点'))
        self.assertEqual([v['note'] for v in self.w.get(doc)['versions']], ['自动保存'])
        self.w.save(doc, dict(body='手写的第一段，又加了一点点'))          # within 10 minutes: no new checkpoint
        self.assertEqual(len(self.w.get(doc)['versions']), 1)
        self.w.store.run('UPDATE versions SET created=created-1000 WHERE doc_id=?', (doc,))
        self.w.save(doc, dict(body='再改一次'))
        got = self.w.get(doc)['versions']
        self.assertEqual(len(got), 2)
        self.assertEqual(got[0]['preview'], '手写的第一段，又加了一点点')
        self.w.save(doc, dict(body='再改一次，adopt', snapshot='采纳 GPT'))
        self.w.save(doc, dict(body='再改一次，adopt', snapshot='采纳 GPT'))   # unchanged: not stored twice
        self.assertEqual(len(self.w.get(doc)['versions']), 3)
        self.w.store.snapshot(doc, '再改一次', '重复')                       # same as the latest snapshot
        self.assertEqual(len(self.w.get(doc)['versions']), 3)

    def test_rewrite_uses_the_typed_feeling_as_the_main_requirement(self):
        doc = self.doc('story')
        body = '开头。林川推开了门。结尾。'
        self.w.save(doc, dict(body=body))
        sel = dict(text='林川推开了门。', start=3, end=10)
        self.w.start(doc, 'polish', members=['Claude'], selection=sel, option='rewrite', prompt='更紧张，少一点解释')
        wait_end(self.inbox)
        user = self.tasks[-1][1][1]
        self.assertIn('「更紧张，少一点解释」', user)
        self.assertIn('按下面的要求和感觉重写这一段', user)
        self.w.start(doc, 'polish', members=['Claude'], selection=sel, option='rewrite', prompt='')
        wait_end(self.inbox)
        self.assertIn('不同的写法重写', self.tasks[-1][1][1])
        self.assertEqual(self.w.get(doc)['items'][-1]['meta']['selection'], '林川推开了门。')

    def test_guards_busy_and_empty_requirements(self):
        doc = self.doc()
        with self.assertRaisesRegex(ValueError, '需求'):
            self.w.start(doc, 'draft')
        self.gate = threading.Event()
        self.w.start(doc, 'draft', prompt='写')
        with self.assertRaisesRegex(ValueError, '还在进行'):
            self.w.start(doc, 'draft', prompt='再写')
        with self.assertRaisesRegex(ValueError, '正在'):
            self.w.delete(doc)
        self.assertTrue(self.w.get(doc)['running'])
        self.gate.set()
        wait_end(self.inbox)

    def test_export_delete_item_and_stale_running_items(self):
        doc = self.doc()
        self.w.save(doc, dict(title='我的标题', body='正文内容'))
        self.assertEqual(self.w.export(doc), ('我的标题', '正文内容'))
        item = self.w.store.add_item(doc, 'draft', 'Claude', 'running')
        again = writing.WriteStore(self.folder)
        self.assertEqual(again.item(item)['status'], 'error')
        again.db.close()
        self.w.delete_item(item)
        self.assertEqual(self.w.get(doc)['items'], [])

    def test_regenerate_a_card_repeats_the_same_request_for_the_same_author(self):
        doc = self.doc('script')
        body = '开头一句。第二句话。结尾一句。'
        self.w.save(doc, dict(body=body))
        sel = dict(text='第二句话。', start=body.index('第二句'), end=body.index('第二句') + 5)
        self.w.start(doc, 'polish', members=['GPT', 'Claude'], selection=sel, prompt='更紧张', option='rewrite')
        wait_end(self.inbox)
        first = [i for i in self.w.get(doc)['items'] if i['author'] == 'GPT'][0]
        self.tasks.clear()
        self.w.save(doc, dict(body='前面加了字。' + body))          # body shifted: the passage must be found again
        self.assertEqual(self.w.redo_item(first['id'])['started'], 1)
        wait_end(self.inbox)
        self.assertEqual([t[0] for t in self.tasks], ['GPT'])
        self.assertIn('更紧张', self.tasks[0][1][1])
        again = [i for i in self.w.get(doc)['items'] if i['author'] == 'GPT'][-1]
        self.assertNotEqual(again['id'], first['id'])
        self.assertEqual(again['meta']['selection'], '第二句话。')
        self.assertEqual(again['meta']['start'], '前面加了字。'.__len__() + body.index('第二句'))
        self.w.save(doc, dict(body='整段都换掉了'))
        with self.assertRaisesRegex(ValueError, '找不到'):
            self.w.redo_item(first['id'])

    def test_star_and_heart_both_survive_cleanup(self):
        doc = self.doc()
        self.w.start(doc, 'draft', prompt='写点什么')
        wait_end(self.inbox)
        a, b, c = [i['id'] for i in self.w.get(doc)['items']]
        self.w.set_favorite(a, True)
        self.w.set_favorite(b, True, 'star')
        self.assertEqual(self.w.clean_items(doc, ['draft']), 1)
        left = {i['id']: i['meta'] for i in self.w.get(doc)['items']}
        self.assertEqual(set(left), {a, b})
        self.assertTrue(left[a]['fav'] and not left[a].get('star'))
        self.assertTrue(left[b]['star'] and not left[b].get('fav'))
        self.w.set_favorite(b, False, 'star')
        self.assertEqual(self.w.clean_items(doc, ['draft']), 1)

    def test_custom_badges_for_chats_and_manuscripts(self):
        chat = self.app.new_chat()
        self.assertEqual(self.app.chats()[0]['icon'], '')
        self.app.set_chat_icon(chat, '7:3')
        self.assertEqual(self.app.chat(chat)['icon'], '7:3')
        self.assertEqual([c['icon'] for c in self.app.chats() if c['id'] == chat], ['7:3'])
        self.app.set_chat_icon(chat, 'javascript:alert(1)')       # anything that is not "n:n" falls back to automatic
        self.assertEqual(self.app.chat(chat)['icon'], '')
        d = self.doc()
        self.assertEqual(self.w.get(d)['doc']['icon'], '')
        self.w.save(d, dict(icon='12:5'))
        self.assertEqual(self.w.get(d)['doc']['icon'], '12:5')
        self.assertEqual(self.w.list()['docs'][0]['icon'], '12:5')
        self.w.save(d, dict(icon='<b>'))
        self.assertEqual(self.w.get(d)['doc']['icon'], '')
        with self.assertRaises(ValueError):
            self.app.set_chat_icon(9999, '1:1')

    def test_uploaded_photo_badges_are_stored_validated_and_cleaned_up(self):
        import io
        from PIL import Image
        buf = io.BytesIO()
        Image.new('RGB', (300, 120), (200, 30, 30)).save(buf, 'PNG')
        icon = self.app.make_badge_photo(buf.getvalue())
        self.assertRegex(icon, r'^img:badge-[0-9a-f]{32}\.png$')
        path = self.folder / 'profile' / icon[4:]
        with Image.open(path) as image:
            self.assertEqual(image.size, (192, 192))
        chat = self.app.new_chat()
        self.app.set_chat_icon(chat, icon)
        self.assertEqual(self.app.chat(chat)['icon'], icon)
        self.app.set_chat_icon(chat, 'img:../../secret.png')          # no path tricks
        self.assertEqual(self.app.chat(chat)['icon'], '')
        self.assertFalse(path.exists())                                # replaced -> old photo removed
        icon2 = self.app.make_badge_photo(buf.getvalue())
        d = self.doc()
        self.w.save(d, dict(icon=icon2))
        self.assertEqual(self.w.get(d)['doc']['icon'], icon2)
        self.w.delete(d)
        self.assertFalse((self.folder / 'profile' / icon2[4:]).exists())
        with self.assertRaises(ValueError):
            self.app.make_badge_photo(b'not an image')
        sticker = io.BytesIO()
        Image.new('RGBA', (100, 100), (0, 0, 0, 0)).save(sticker, 'PNG')      # a cut-out picture keeps its transparent edges
        with Image.open(self.folder / 'profile' / self.app.make_badge_photo(sticker.getvalue())[4:]) as image:
            self.assertEqual(image.convert('RGBA').getpixel((2, 2))[3], 0)

    def test_export_word_and_notes_never_leak(self):
        import io as _io, zipfile as _zip
        import docx_export
        body, note = writing.split_note('正文第一段。\n\n<<<说明：只改了对白。>>>\n\n正文第二段。')
        self.assertEqual(note, '只改了对白。')
        self.assertNotIn('<<<', body)
        self.assertIn('正文第二段', body)
        d = self.doc()
        self.w.save(d, dict(body='# 《沉灯》\n\n## 第一章\n\n他说**灯**亮了。\n<<<说明：编辑备注>>>\n\n- 要点 & <符号>'))
        title, text = self.w.export(d)
        self.assertNotIn('编辑备注', text)
        raw = docx_export.build(title, text)
        z = _zip.ZipFile(_io.BytesIO(raw))
        self.assertIn('word/document.xml', z.namelist())
        doc_xml = z.read('word/document.xml').decode('utf-8')
        for want in ('w:val="Title"', 'w:val="Heading1"', '<w:b/>', '&amp; &lt;符号&gt;', '沉灯'):
            self.assertIn(want, doc_xml)
        from xml.dom import minidom
        for name in z.namelist():
            minidom.parseString(z.read(name))

    def test_storyboard_turns_into_a_video_prompt_pack_with_the_chosen_style_and_can_be_continued(self):
        doc = self.doc('story')
        self.w.save(doc, dict(body='周衡把车停在路边，手机震了一下：今晚，别回家。'))
        self.w.start(doc, 'polish', members=['GPT'], option='storyboard', prompt='画风：国漫 2D 动画；画幅：竖屏 9:16。只输出中文，不要英文。')
        wait_end(self.inbox)
        system, user = self.tasks[-1][1][0], self.tasks[-1][1][1]
        blob = system + user
        for want in ('运镜：', '台词：', '音效：', '人物资产', '场景资产', '场景设定图，画面中没有人物', '国漫 2D 动画', '竖屏 9:16', '只输出中文', 'LibTV'):
            self.assertIn(want, blob)
        self.assertNotIn('关键帧提示词', blob)
        item = self.w.get(doc)['items'][-1]
        self.assertEqual((item['meta']['action'], item['meta']['mode']), ('转分镜提示词', 'copy'))
        # a prompt pack that hit the output limit can be continued, in the same format, from the source passage
        self.truncate.add('GPT')
        self.w.start(doc, 'polish', members=['GPT'], option='storyboard', prompt='画风：真人写实')
        wait_end(self.inbox)
        self.truncate.clear()
        cut = self.w.get(doc)['items'][-1]
        self.assertTrue(cut['meta'].get('truncated'))
        self.w.start(doc, 'continue', source_item=cut['id'])
        wait_end(self.inbox)
        user = self.tasks[-1][1][1]
        self.assertIn('【要转换的原文】', user)
        self.assertIn('今晚，别回家', user)
        self.assertIn('镜头编号接着排', user)
        self.assertTrue(self.w.get(doc)['items'][-1]['content'].startswith(cut['content'].rstrip()))

    def test_video_prompt_templates_store_default_and_drive_the_conversion(self):
        T = self.w.video_templates()
        self.assertEqual((T['default'], T['items'], T['builtin']['name']), ('builtin', [], '默认模板'))
        T = self.w.save_video_templates([dict(name='即梦竖屏', text='镜头N｜主体：…｜动作：…｜镜头语言：…'), dict(name='', text='第二种格式')])
        first = T['items'][0]['id']
        self.assertEqual([t['name'] for t in T['items']], ['即梦竖屏', '我的模板 2'])
        T = self.w.save_video_templates(T['items'], default=first)
        self.assertEqual(self.w.video_templates()['default'], first)                 # remembered on disk
        with self.assertRaisesRegex(ValueError, '最多'):
            self.w.save_video_templates([dict(name=str(i), text='x') for i in range(4)])
        with self.assertRaisesRegex(ValueError, '不能为空'):
            self.w.save_video_templates([dict(name='空', text='  ')])
        T = self.w.save_video_templates(T['items'][1:], default=first)               # deleting the default falls back to ours
        self.assertEqual(T['default'], 'builtin')
        import io, zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as z:
            z.writestr('word/document.xml', '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>镜头1｜主体：</w:t></w:r></w:p></w:body></w:document>')
        got = self.w.template_from_file('我的模板.docx', buf.getvalue())
        self.assertEqual((got['name'], got['text']), ('我的模板', '镜头1｜主体：'))
        doc = self.doc('story')
        self.w.save(doc, dict(body='周衡把车停在路边。'))
        self.w.start(doc, 'polish', members=['GPT'], option='storyboard', prompt='画风：国漫', template='镜头N｜主体：…｜镜头语言：…')
        wait_end(self.inbox)
        blob = self.tasks[-1][1][0] + self.tasks[-1][1][1]
        self.assertIn('【用户模板】', blob)
        self.assertIn('场景参考图提示词', blob)                                    # assets are added even if the template has none
        self.assertIn('镜头N｜主体：…｜镜头语言：…', blob)
        self.assertIn('画风：国漫', blob)
        self.assertNotIn('「运镜：」', blob)                                       # our own format is replaced
        self.assertEqual(self.w.get(doc)['items'][-1]['meta']['redo']['template'], '镜头N｜主体：…｜镜头语言：…')


if __name__ == '__main__':
    unittest.main(verbosity=2)
