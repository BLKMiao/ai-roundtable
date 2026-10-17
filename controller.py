"""Headless application logic: everything the old Tk window did, with no UI toolkit attached.

The web front end talks to this class through server.py. Keeping it UI-free also makes it testable.
"""
import copy
import io
import json
import queue
import re
import threading
import time
import urllib.parse
import uuid
from pathlib import Path

import core
import engine
from writing import Writer
from core import Cancel, Cancelled, NAMES, safe_error

CONTINUE_PROMPT = '请继续讨论，回应上面的观点，指出还没有聊清楚的地方。'

# Quick follow-ups offered under the last reply. mode "fresh": the first round is answered independently (nobody sees
# the others' answers of that round); "discuss": members read and respond to each other.
PRESETS = {
    'more': dict(label='再各出 3 个新方案', mode='fresh',
                 text='这些方案我还不太满意。请每人再各出 3 个新方案，要和上面已经出现过的方向明显不同，不要换个说法重复。'),
    'review': dict(label='互相点评一下', mode='discuss',
                   text='请简短点评一下大家刚才提出的方案：每人只挑最值得说的 2～3 点（好在哪、问题在哪），最后说你觉得哪个最值得做。这一轮不要再提新方案。'),
    'refine': dict(label='完善细化推荐的方案', mode='fresh',
                   text='请每人把自己最推荐的那一个方案完善细化：补全关键细节、具体怎么展开、可能遇到的问题和应对。只写这一个方案，不要再出新方案。'),
    'talk': dict(label='继续讨论', mode='discuss',
                 text='请继续讨论：针对上面的观点简短回应，说清同意或不同意的理由，补充还没说到的关键点，不要重复已经说过的内容。'),
    'sum': dict(label='汇总成一个方案', mode='discuss', single=True,
                text='请把上面的讨论汇总成一个最终方案：吸收大家说得好的地方，说清最终怎么做，并列出还需要我来决定的问题。'),
}
DISCUSS_TEXTS = {CONTINUE_PROMPT} | {p['text'] for p in PRESETS.values() if p['mode'] == 'discuss'}
IMAGE_PREFIX = '按以下描述生成图片：\n'
MAX_ATTACHMENTS = 4
MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
IMAGE_SIZES = ('1024x1024', '1536x1024', '1024x1536')


def mask(key):
    key = (key or '').strip()
    if not key:
        return ''
    return key[:3] + '••••' + key[-4:] if len(key) > 12 else '••••••••'


def normalize_base(url):
    """Accept what people paste: trailing slashes or the full .../chat/completions address."""
    url = (url or '').strip().rstrip('/')
    for tail in ('/chat/completions', '/completions'):
        if url.endswith(tail):
            url = url[:-len(tail)]
    if url:
        core.endpoint(url, 'check')            # raises ValueError with a readable message when invalid
    return url


def credits(rows):
    """Compact credit text used by the header pill (10 USD = 1000 credits)."""
    if not rows:
        return '0.00'
    known = [r for r in rows if r['usd'] is not None]
    if not known:
        return '待核对'
    mark = '≈' if any(r['basis'].startswith('估算') for r in known) else ''
    return mark + f"{sum(r['usd'] * 100 for r in known):.2f}" + ('*' if len(known) < len(rows) else '')


def totals(rows):
    """Structured usage total for the settings page: known credits, whether they are estimates, and how many calls are unsettled."""
    known = [r for r in rows if r['usd'] is not None]
    return dict(credits=sum(r['usd'] * 100 for r in known) if known else None,
                estimated=any(r['basis'].startswith('估算') for r in known),
                pending=len(rows) - len(known))



def clean_icon(value):
    """A chosen badge is "picture:colour" (two small numbers) or "img:<file>" (an uploaded photo); anything else means "automatic"."""
    value = str(value or '').strip()
    return value if re.fullmatch(r'\d{1,2}:\d{1,2}|img:badge-[0-9a-f]{32}\.png', value) else ''


def drop_badge_file(folder, icon):
    """Delete the photo behind an "img:" badge (when it is replaced or its chat / manuscript is deleted)."""
    if str(icon or '').startswith('img:') and clean_icon(icon):
        (Path(folder) / 'profile' / icon[4:]).unlink(missing_ok=True)

class Controller:
    def __init__(self, folder=None):
        self.folder = Path(folder) if folder else core.DATA
        core.DATA = self.folder
        self.lock = threading.RLock()
        self.settings = engine.load_settings(self.folder)
        self.store = core.Store(self.folder)
        self.ledger = engine.Ledger(self.folder)
        self.router = engine.Router(self.ledger)
        self.subscribers = set()
        self.uploads = {}
        self.routes = {}
        self.busy = False
        self.cancel = None
        self.live = None
        self.run_chat = None
        self.round_id = ''
        self.worker = None
        self.writer = Writer(self)

    # ---- event bus -------------------------------------------------------------------------
    def subscribe(self):
        q = queue.Queue()
        with self.lock:
            self.subscribers.add(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.subscribers.discard(q)

    def emit(self, kind, **data):
        event = dict(type=kind, **data)
        with self.lock:
            targets = list(self.subscribers)
        for q in targets:
            q.put(event)

    # ---- public views ----------------------------------------------------------------------
    def avatar_url(self):
        path = self.settings['_profile'].get('avatar') or ''
        name = Path(path).name
        file = self.folder / 'profile' / name
        if name and file.is_file():
            return '/files/profile/' + urllib.parse.quote(name) + '?v=' + str(int(file.stat().st_mtime))
        return ''

    def members(self):
        primary = next(iter(engine.active_lines(self.settings)), '')
        return [dict(name=n, display=core.DISPLAY_NAMES[n], bio=self.settings[n]['bio'], role=self.settings[n]['role'],
                     default_role=core.ROLES[n],
                     route=self.routes.get(n) or primary) for n in NAMES]

    def lines(self):
        """All connection lines in priority order, without any key (only a masked tail)."""
        out = []
        for line in self.settings['_line_order']:
            if line in engine.CUSTOM:
                cfg = self.settings['_custom'][line]
                out.append(dict(id=line, custom=True, name=cfg['name'], base_url=cfg['base_url'], models=dict(cfg['models']),
                                image_model=cfg['image_model'], configured=bool(cfg['key'].strip()), mask=mask(cfg['key']),
                                key_error=bool(cfg.get('key_error'))))
            else:
                cfg = self.settings['_platforms'][line]
                out.append(dict(id=line, custom=False, name=line, configured=bool(cfg.get('key', '').strip()),
                                mask=mask(cfg.get('key')), key_error=bool(cfg.get('key_error'))))
        return out

    def line_name(self, line):
        return engine.line_name(self.settings, line) if line in engine.LINES else (line or '')

    def bootstrap(self):
        profile = self.settings['_profile']
        return dict(
            version='3.0', busy=self.busy, run_chat=self.run_chat, connected=engine.connected(self.settings),
            members=self.members(), image_sizes=list(IMAGE_SIZES), limits_tokens=dict(self.settings.get('_limits') or {}, chat_default=engine.DEFAULT_CHAT_CAP, write_default=engine.DEFAULT_WRITE_CAP, range=list(engine.LIMIT_RANGE)),
            lines=self.lines(), primary=next(iter(engine.active_lines(self.settings)), ''),
            profile=dict(nickname=profile.get('nickname', '我'), bio=profile.get('bio', ''),
                         share_bio=bool(profile.get('share_bio')), avatar=self.avatar_url()),
            limits=dict(attachments=MAX_ATTACHMENTS, bytes=MAX_ATTACHMENT_BYTES),
            presets={k: dict(label=v['label'], text=v['text'], mode=v['mode'], single=bool(v.get('single'))) for k, v in PRESETS.items()})

    def chats(self):
        return [dict(item, running=self.busy and self.run_chat == item['id']) for item in self.store.overview()]

    @staticmethod
    def public_attachment(item):
        return dict(name=item.get('name', ''), kind=item.get('kind', 'image'), mime=item.get('mime', ''),
                    url='/files/attachments/' + urllib.parse.quote(Path(item.get('path', '')).name))

    def public_message(self, m):
        return dict(id=m.get('id'), speaker=m['speaker'], content=m['content'], status=m.get('status', 'complete'),
                    created=m.get('created', time.time()), route=m.get('route', ''), note=m.get('note', ''),
                    attachments=[self.public_attachment(a) for a in m.get('attachments') or []])

    def chat(self, chat_id):
        if not self.store.exists(chat_id):
            raise ValueError('这个讨论已不存在。')
        title = dict(self.store.chats())[chat_id]
        live = None
        if self.busy and self.run_chat == chat_id and self.live:
            live = dict(self.live)
        return dict(id=chat_id, title=title, target=self.store.target(chat_id), muted=self.store.muted(chat_id), order=self.store.order(chat_id), icon=self.store.icon(chat_id),
                    messages=[self.public_message(m) for m in self.store.messages(chat_id)],
                    live=live, usage=self.usage_summary(chat_id))

    # ---- chat management -------------------------------------------------------------------
    def new_chat(self):
        """Reuse the newest empty group chat instead of piling up blank 'new discussion' entries."""
        for item in self.store.overview():
            if item['count'] == 0 and not item['target'] and item['title'] == '新讨论':
                return item['id']
        return self.store.create()

    def direct_chat(self, name):
        if name not in NAMES:
            raise ValueError('未知成员。')
        return self.store.direct(name)

    def rename_chat(self, chat_id, title):
        self.store.rename(chat_id, title)

    def set_chat_icon(self, chat_id, icon):
        if not self.store.exists(chat_id):
            raise ValueError('这个讨论已不存在。')
        old, icon = self.store.icon(chat_id), clean_icon(icon)
        self.store.set_icon(chat_id, icon)
        if old != icon:
            drop_badge_file(self.folder, old)

    def make_badge_photo(self, data):
        """An uploaded photo, centre-cropped to a small square; returns the icon value to store."""
        from PIL import Image, ImageOps
        if len(data) > 25 * 1024 * 1024:
            raise ValueError('图片太大了（超过 25 MB）。')
        folder = self.folder / 'profile'
        folder.mkdir(parents=True, exist_ok=True)
        name = 'badge-' + uuid.uuid4().hex + '.png'
        try:
            with Image.open(io.BytesIO(data)) as image:
                ImageOps.fit(ImageOps.exif_transpose(image).convert('RGBA'), (192, 192)).save(folder / name)
        except Exception:
            raise ValueError('这张图片读取失败，可能已损坏或格式不支持。') from None
        return 'img:' + name

    def delete_chat(self, chat_id):
        if self.busy and self.run_chat == chat_id:
            raise ValueError('这个讨论正在回复，请先停止。')
        old = self.store.icon(chat_id)
        self.store.delete(chat_id, self.folder)
        drop_badge_file(self.folder, old)

    def set_order(self, chat_id, names):
        if sorted(names or []) != sorted(NAMES) or not self.store.exists(chat_id):
            raise ValueError('发言顺序无效。')
        self.store.set_order(chat_id, list(names))

    def set_muted(self, chat_id, name, muted):
        """Mute a member in one discussion: they stay in the room but are not asked, unless @-mentioned."""
        if name not in NAMES or not self.store.exists(chat_id):
            raise ValueError('未知成员或讨论。')
        current = set(self.store.muted(chat_id))
        (current.add if muted else current.discard)(name)
        if len(current) >= len(NAMES):
            raise ValueError('至少让一位 AI 发言。')
        self.store.set_muted(chat_id, current)
        self.emit('chat_muted', chat=chat_id, muted=self.store.muted(chat_id))

    # ---- uploads ---------------------------------------------------------------------------
    def upload(self, filename, data):
        name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', Path(filename or 'file').name)[:80] or 'file'
        suffix = Path(name).suffix.lower()
        tmp = self.folder / 'tmp'
        tmp.mkdir(parents=True, exist_ok=True)
        source = tmp / (uuid.uuid4().hex + suffix)
        source.write_bytes(data)
        try:
            item = core.import_media(source, self.folder)
        finally:
            source.unlink(missing_ok=True)
        item['name'] = name if suffix else name + '.png'
        ident = uuid.uuid4().hex
        self.uploads[ident] = item
        return dict(self.public_attachment(item), id=ident)

    def discard_upload(self, ident):
        item = self.uploads.pop(ident, None)
        if item:
            Path(item['path']).unlink(missing_ok=True)

    def take_uploads(self, ids):
        items = []
        for ident in ids or []:
            if ident not in self.uploads:
                raise ValueError('附件已失效，请重新添加。')
            items.append(self.uploads[ident])
        if len(items) > MAX_ATTACHMENTS:
            raise ValueError(f'每条消息最多 {MAX_ATTACHMENTS} 个附件。')
        if sum(Path(i['path']).stat().st_size for i in items) > MAX_ATTACHMENT_BYTES:
            raise ValueError('本条消息附件总大小请控制在 12 MB 以内。')
        return items

    # ---- sending ---------------------------------------------------------------------------
    def plan(self, chat_id, text, attachments, target='all'):
        """Who speaks, in what order: single chat > @mention > 'only ask X' > members not muted in this chat; video goes to Gemini first."""
        muted = self.store.muted(chat_id)
        names = [n for n in self.store.order(chat_id) if n not in muted]
        mentioned = [n for n in NAMES if re.search('@' + n + r'(?![A-Za-z0-9])', text, re.I)]
        direct = self.store.target(chat_id)
        if direct:
            names = [direct]
        elif mentioned:
            names = mentioned
        elif target in NAMES:
            names = [target]
        if not names:
            raise ValueError('所有 AI 都被禁言了，请先解除至少一位。')
        if any(a['kind'] == 'video' for a in attachments):
            names = ['Gemini'] + [n for n in names if n != 'Gemini']
        return names

    def require_idle(self):
        if self.busy:
            raise ValueError('上一轮还在进行，请等它完成或先停止。')
        if not engine.connected(self.settings):
            raise ConfigError('请先在「设置 → 连接」里填写至少一条线路的密钥。')

    def send(self, chat_id, text='', upload_ids=None, target='all', rounds=1, preset=''):
        with self.lock:
            self.require_idle()
            if not self.store.exists(chat_id):
                raise ValueError('这个讨论已不存在。')
            attachments = self.take_uploads(upload_ids)
            text = (text or '').strip()
            if preset:
                if preset not in PRESETS:
                    raise ValueError('未知的快捷操作。')
                if not self.store.messages(chat_id):
                    raise ValueError('先说点什么吧。')
                text = PRESETS[preset]['text']
            if not text and not attachments:
                if not self.store.messages(chat_id):
                    raise ValueError('先说点什么吧。')
                text = CONTINUE_PROMPT
            names = self.plan(chat_id, text, attachments, target)
            rounds = max(1, min(3, int(rounds or 1))) if len(names) > 1 else 1
            for ident in upload_ids or []:
                self.uploads.pop(ident, None)
            message_id = self.store.add(chat_id, '你', text, attachments=attachments)
            history = self.store.messages(chat_id)
            self.begin_run(chat_id)
            fresh = len(names) > 1 and text not in DISCUSS_TEXTS   # a new question: everyone first gives their own view
            self.worker = threading.Thread(target=self.run_turns, args=(chat_id, names, rounds, history, fresh), daemon=True)
            self.worker.start()
        return dict(message=self.public_message(dict(id=message_id, speaker='你', content=text, attachments=attachments,
                                                    created=time.time())), names=names, rounds=rounds)

    def begin_run(self, chat_id):
        self.busy = True
        self.run_chat = chat_id
        self.cancel = Cancel()
        self.round_id = uuid.uuid4().hex
        self.live = None
        self.emit('run_start', chat=chat_id)
        self.emit('chats_changed')

    def finish_run(self, chat_id, status, text):
        with self.lock:
            self.busy = False
            self.live = None
            self.cancel = None
        self.emit('run_end', chat=chat_id, status=status, text=text, usage=self.usage_summary(chat_id))
        self.emit('chats_changed')

    def stop(self):
        with self.lock:
            cancel = self.cancel
        if cancel:
            cancel.stop()

    def run_turns(self, chat_id, names, rounds, history, fresh=False):
        """fresh: in the first round every member answers the user's message on its own (without seeing the others'
        replies from this round); from the second round on, and for "让大家继续聊", they respond to each other."""
        token, settings, round_id = self.cancel, copy.deepcopy(self.settings), self.round_id
        start = history
        done = failed = streak = 0
        status, text = 'complete', '本轮讨论完成。你可以追问，或直接发送以继续讨论。'
        try:
            for number in range(rounds):
                for name in names:
                    token.check()
                    alone = fresh and number == 0
                    ok, fatal = self.turn(chat_id, name, start if alone else history, token,
                                          dict(settings, _fresh_turn=True) if alone else settings, round_id, number + 1, rounds)
                    if ok:
                        done += 1
                        streak = 0
                        history = self.store.messages(chat_id)
                    else:
                        failed += 1
                        streak += 1
                        if fatal or streak >= 2:
                            raise StopRound()
            if failed:
                status, text = 'partial', f'有 {failed} 位成员没有回复成功，可以点击对应消息上的「重试」。'
        except Cancelled:
            status, text = 'cancelled', '讨论已停止。'
        except StopRound:
            status, text = 'error', '连接没有成功，请查看提示并检查设置。'
        except Exception as exc:
            status, text = 'error', safe_error(exc, settings)
        finally:
            self.finish_run(chat_id, status, text)

    def turn(self, chat_id, name, history, token, settings, round_id, round_no, rounds):
        live = self.live = dict(speaker=name, text='', route='', round_no=round_no, rounds=rounds)
        self.emit('turn_start', chat=chat_id, speaker=name, round_no=round_no, rounds=rounds)

        def on_delta(piece):
            live['text'] += piece
            self.emit('delta', chat=chat_id, speaker=name, text=piece)

        def on_route(provider):
            live['text'], live['route'] = '', provider
            self.routes[name] = provider
            self.emit('route', chat=chat_id, speaker=name, provider=provider)

        try:
            result, provider = self.router.run(name, settings, history, token, on_delta, on_route, chat_id, round_id)
        except Cancelled:
            if live['text'].strip():
                self.save_turn(chat_id, name, live['text'], 'cancelled', live['route'], '已停止；已生成的部分保留在这里。')
            else:
                self.emit('turn_drop', chat=chat_id, speaker=name)
            raise
        except Exception as exc:
            self.save_turn(chat_id, name, live['text'], 'error', live['route'], safe_error(exc, settings))
            return False, isinstance(exc, ValueError)
        self.save_turn(chat_id, name, result, 'complete', provider)
        return True, False

    def save_turn(self, chat_id, speaker, content, status, route='', note='', attachments=None):
        mid = self.store.add(chat_id, speaker, content, status, attachments=attachments, route=route, note=note)
        message = dict(id=mid, speaker=speaker, content=content, status=status, route=route, note=note,
                       attachments=attachments or [], created=time.time())
        self.emit('turn_end', chat=chat_id, speaker=speaker, message=self.public_message(message))
        self.emit('usage_changed', chat=chat_id, usage=self.usage_summary(chat_id))
        self.emit('chats_changed')

    # ---- retry and image generation --------------------------------------------------------
    def retry(self, chat_id, message_id):
        with self.lock:
            self.require_idle()
            message = next((m for m in self.store.messages(chat_id) if m['id'] == message_id), None)
            if not message or message['status'] == 'complete':
                raise ValueError('这条消息不需要重试。')
            speaker = message['speaker']
            if speaker == '图片生成':
                prompt = message['content'].removeprefix(IMAGE_PREFIX)
                self.store.remove_message(message_id)
                return self.start_image(chat_id, prompt, IMAGE_SIZES[0])
            if speaker not in NAMES:
                raise ValueError('这条消息不能重试。')
            everything = self.store.messages(chat_id)
            at = next(i for i, m in enumerate(everything) if m['id'] == message_id)
            ask = max((i for i in range(at) if everything[i]['speaker'] == '你'), default=-1)
            # retrying a first-round answer: keep it independent (it sees the question, not the others' answers to it)
            fresh = (ask >= 0 and everything[ask]['content'] not in DISCUSS_TEXTS
                     and not any(m['speaker'] == speaker for m in everything[ask + 1:at]))
            self.store.remove_message(message_id)
            history = everything[:ask + 1] if fresh else self.store.messages(chat_id)
            self.begin_run(chat_id)
            self.worker = threading.Thread(target=self.run_turns, args=(chat_id, [speaker], 1, history, fresh), daemon=True)
            self.worker.start()
        return dict(names=[speaker])

    def generate_image(self, chat_id, prompt, size=IMAGE_SIZES[0]):
        with self.lock:
            self.require_idle()
            prompt = (prompt or '').strip()
            if not prompt:
                raise ValueError('请描述你想要的画面。')
            if not self.store.exists(chat_id):
                raise ValueError('这个讨论已不存在。')
            return self.start_image(chat_id, prompt, size if size in IMAGE_SIZES else IMAGE_SIZES[0])

    def start_image(self, chat_id, prompt, size):
        self.begin_run(chat_id)
        self.worker = threading.Thread(target=self.run_image, args=(chat_id, prompt, size), daemon=True)
        self.worker.start()
        return dict(names=['图片生成'])

    def run_image(self, chat_id, prompt, size):
        token, settings, round_id = self.cancel, copy.deepcopy(self.settings), self.round_id
        text_content = IMAGE_PREFIX + prompt
        self.live = dict(speaker='图片生成', text='', route='', round_no=1, rounds=1)
        self.emit('turn_start', chat=chat_id, speaker='图片生成', round_no=1, rounds=1)
        route = []
        status, text = 'complete', '图片已保存。点击预览打开原图，可以继续请大家分析。'
        try:
            item, provider = self.router.run('GPT', settings, [], token, lambda _: None, route.append, chat_id, round_id,
                                             image_prompt=prompt, image_size=size)
            self.save_turn(chat_id, '图片生成', text_content, 'complete', provider, attachments=[item])
        except Cancelled:
            self.save_turn(chat_id, '图片生成', text_content, 'cancelled', route[-1] if route else '',
                           '已停止；服务端可能仍在处理，请在平台调用记录核对。')
            status, text = 'cancelled', '图片生成已停止。'
        except Exception as exc:
            detail = safe_error(exc, settings)
            self.save_turn(chat_id, '图片生成', text_content, 'error', route[-1] if route else '', detail)
            status, text = 'error', '图片没有生成成功。'
        finally:
            self.finish_run(chat_id, status, text)

    # ---- settings --------------------------------------------------------------------------
    def save_settings(self, payload):
        with self.lock:
            draft = copy.deepcopy(self.settings)
            for provider, cfg in (payload.get('platforms') or {}).items():
                if provider in engine.PLATFORMS and cfg.get('key') is not None:
                    key = str(cfg['key']).strip()
                    draft['_platforms'][provider]['key'] = key
                    if key:
                        draft['_platforms'][provider].pop('key_error', None)
            for line, cfg in (payload.get('custom') or {}).items():
                if line not in engine.CUSTOM:
                    continue
                target = draft['_custom'][line]
                if 'name' in cfg:
                    target['name'] = str(cfg['name']).strip()[:20] or '自定义线路 ' + line[-1]
                if 'base_url' in cfg:
                    target['base_url'] = normalize_base(cfg['base_url'])
                for member, model in (cfg.get('models') or {}).items():
                    if member in NAMES:
                        target['models'][member] = str(model).strip()[:120]
                if 'image_model' in cfg:
                    target['image_model'] = str(cfg['image_model']).strip()[:120]
                if cfg.get('key') is not None:
                    target['key'] = str(cfg['key']).strip()
                    if target['key']:
                        target.pop('key_error', None)
                if target['key'] and not target['base_url']:
                    raise ValueError(target['name'] + '：填了密钥，还需要填写接口地址。')
            if isinstance(payload.get('limits'), dict):
                for kind in ('chat', 'write'):
                    if kind in payload['limits']:
                        raw = payload['limits'][kind]
                        value = engine.clean_limit(raw)
                        if raw not in (None, '') and value is None:
                            raise ValueError(f'回复长度上限请填 {engine.LIMIT_RANGE[0]} 到 {engine.LIMIT_RANGE[1]} 之间的整数（token），或留空使用默认值。')
                        draft['_limits'][kind] = value
            if payload.get('line_order'):
                order = [x for x in payload['line_order'] if x in engine.LINES]
                draft['_line_order'] = order + [x for x in engine.LINES if x not in order]
            profile = payload.get('profile') or {}
            if 'nickname' in profile:
                draft['_profile']['nickname'] = str(profile['nickname']).strip()[:30] or '我'
            if 'bio' in profile:
                draft['_profile']['bio'] = str(profile['bio']).strip()[:4000]
            if 'share_bio' in profile:
                draft['_profile']['share_bio'] = bool(profile['share_bio'])
            for name, cfg in (payload.get('members') or {}).items():
                if name in NAMES and 'role' in cfg:
                    draft[name]['role'] = str(cfg['role']).strip()[:4000] or core.ROLES[name]
            engine.save_settings(draft, self.folder)
            self.settings = draft
        self.emit('settings_changed')

    def set_avatar(self, data):
        from PIL import Image, ImageOps
        folder = self.folder / 'profile'
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / (uuid.uuid4().hex + '.png')
        with Image.open(io.BytesIO(data)) as image:
            ImageOps.fit(ImageOps.exif_transpose(image).convert('RGBA'), (512, 512)).save(target)
        with self.lock:
            old = self.settings['_profile'].get('avatar')
            self.settings['_profile']['avatar'] = str(target)
            engine.save_settings(self.settings, self.folder)
        if old and Path(old).parent.name == 'profile':
            Path(old).unlink(missing_ok=True)
        self.emit('settings_changed')
        return self.avatar_url()

    def clear_avatar(self):
        with self.lock:
            old = self.settings['_profile'].get('avatar')
            self.settings['_profile']['avatar'] = ''
            engine.save_settings(self.settings, self.folder)
        if old and Path(old).parent.name == 'profile':
            Path(old).unlink(missing_ok=True)
        self.emit('settings_changed')

    def check_connections(self, keys=None, custom=None):
        """Read each line's model catalogue. Sends no chat request, so it costs nothing."""
        settings = copy.deepcopy(self.settings)
        for line, key in (keys or {}).items():
            if key is None or not str(key).strip():
                continue
            if line in engine.PLATFORMS:
                settings['_platforms'][line]['key'] = str(key).strip()
            elif line in engine.CUSTOM:
                settings['_custom'][line]['key'] = str(key).strip()
        for line, cfg in (custom or {}).items():
            if line in engine.CUSTOM:
                target = settings['_custom'][line]
                try:
                    target['base_url'] = normalize_base(cfg.get('base_url', target['base_url']))
                except ValueError as exc:
                    target['base_url'] = ''
                    target['_bad'] = str(exc)
                target['models'].update({m: str(v).strip() for m, v in (cfg.get('models') or {}).items() if m in NAMES})
                target['image_model'] = str(cfg.get('image_model', target['image_model'])).strip()
        results = []
        for line in settings['_line_order']:
            name = engine.line_name(settings, line)
            if not engine.line_key(settings, line):
                continue
            try:
                if line in engine.CUSTOM:
                    cfg = settings['_custom'][line]
                    if cfg.get('_bad'):
                        raise ValueError(cfg['_bad'])
                    if not cfg['base_url']:
                        raise ValueError('还没有填写接口地址。')
                    models = core.fetch_models(engine.route(settings, 'GPT', line))
                    wanted = [cfg['models'][m] for m in NAMES if cfg['models'][m]]
                    missing = [v for v in wanted if models and v not in models]
                    unset = [core.DISPLAY_NAMES[m] for m in NAMES if not cfg['models'][m]]
                    note = '连接正常' + ('；列表里没有：' + '、'.join(missing) + '（部分网关不列出全部模型，可忽略，以实际发送为准）' if missing else '')
                    if unset:
                        note += '；还没有给 ' + '、'.join(unset) + ' 设置模型 ID，这条线路不会用于他们'
                    results.append(dict(provider=name, ok=not missing and not unset, message=note))
                else:
                    models = core.fetch_models(engine.route(settings, 'GPT', line))
                    ids = core.CHERRY_IDS if line == 'CherryIn' else core.MODEL_IDS
                    missing = [n for n in NAMES if ids[n] not in models]
                    results.append(dict(provider=name, ok=not missing,
                                        message=('连接正常，但模型列表里没有 ' + '、'.join(core.DISPLAY_NAMES[n] for n in missing)
                                                 if missing else '连接正常，三位成员的模型都在列表中')))
            except Exception as exc:
                results.append(dict(provider=name, ok=False, message=safe_error(exc, settings)))
        if not results:
            results.append(dict(provider='', ok=None, message='还没有填写任何线路的密钥'))
        return results

    # ---- usage -----------------------------------------------------------------------------
    def usage_summary(self, chat_id):
        rows = self.ledger.rows(chat_id)
        if self.busy and self.run_chat == chat_id:
            round_id = self.round_id
        else:
            round_id = rows[0]['round'] if rows else ''
        return dict(round=credits([r for r in rows if r['round'] == round_id]), chat=credits(rows))

    def usage_details(self, limit=200):
        rows = self.ledger.rows()
        titles = dict(self.store.chats())
        titles.update({-d['id']: '写作：' + d['title'] for d in self.writer.store.docs()})
        today = time.strftime('%Y-%m-%d')
        recent = [r for r in rows if time.strftime('%Y-%m-%d', time.localtime(r['created'])) == today]
        items = []
        for r in rows[:limit]:
            try:
                raw = json.loads(r['usage'] or '{}')
            except ValueError:
                raw = {}
            items.append(dict(id=r['id'], chat=r['chat'], chat_title=titles.get(r['chat'], '已删除的讨论'), member=r['member'],
                              kind=r['kind'], provider=self.line_name(r['provider']), model=r['model'], status=r['status'],
                              created=r['created'], credits=None if r['usd'] is None else r['usd'] * 100,
                              basis=r['basis'], note=r['note'], usage=raw))
        return dict(today=totals(recent), total=totals(rows), count=len(rows), items=items)

    def reconcile(self, record_id, usd):
        usd = float(usd)
        if not (usd >= 0) or usd > 10000:
            raise ValueError('请填写这一次请求的实际美元扣费（不是余额变化）。')
        with self.ledger.connect() as db:
            db.execute("UPDATE calls SET usd=?,basis='实际·账单核对',note=note || '；用户按平台账单核对' WHERE id=?", (usd, record_id))
        self.emit('usage_changed', chat=None, usage=None)

    # ---- export ----------------------------------------------------------------------------
    def export_markdown(self, chat_id):
        title = dict(self.store.chats()).get(chat_id, '讨论')
        nickname = self.settings['_profile'].get('nickname', '我')
        lines = [f'# {title}', '', time.strftime('导出时间 %Y-%m-%d %H:%M'), '']
        for m in self.store.messages(chat_id):
            who = nickname if m['speaker'] == '你' else core.DISPLAY_NAMES.get(m['speaker'], m['speaker'])
            flag = {'cancelled': '（已停止，部分回复）', 'error': '（未完成）'}.get(m['status'], '')
            lines += [f'## {who}{flag}', '', m['content'] or '（无内容）', '']
            lines += [f"> 附件：{a['name']}" for a in m['attachments']]
            if m.get('note') and m['status'] != 'complete':
                lines += ['', f"> {m['note']}"]
            lines.append('')
        return title, '\n'.join(lines)

    def shutdown(self):
        self.stop()
        worker = self.worker
        if worker and worker.is_alive():
            worker.join(3)


class ConfigError(ValueError):
    """Missing keys or settings: the UI answers with a pointer to the settings page."""


class StopRound(Exception):
    pass
