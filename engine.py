"""Two-provider routing, encrypted preferences and per-attempt local accounting."""
import base64
import copy
import json
import os
import math
import re
import socket
import sqlite3
import threading
import time
import urllib.error
import uuid
from contextlib import contextmanager
from pathlib import Path
import core

PLATFORMS = ('CherryIn', 'AIHUBMIX')           # built-in lines (known endpoints and public prices)
CUSTOM = ('Custom1', 'Custom2')                 # user-defined lines: any OpenAI-compatible gateway
LINES = PLATFORMS + CUSTOM
BIOS = {
    'Claude': 'Anthropic 的 AI 助手。注重细致推敲、文字表达与独立判断。',
    'GPT': 'OpenAI 的 AI 助手。协助梳理问题、提出方案并整理行动步骤。',
    'Gemini': 'Google 的 AI 助手。参与多角度讨论，并负责优先解读视频内容。',
}


def defaults():
    value = core.defaults()
    value['_platforms'] = {p: {'key': ''} for p in PLATFORMS}
    value['_custom'] = {c: dict(name='自定义线路 ' + c[-1], base_url='', key='', image_model='',
                                models={n: '' for n in core.NAMES}) for c in CUSTOM}
    value['_line_order'] = list(LINES)
    value['_profile'] = dict(nickname='我', bio='', avatar='', share_bio=False)
    value['_limits'] = dict(chat=None, write=None)      # None = built-in default
    for name in core.NAMES:
        value[name]['bio'] = BIOS[name]
    return value


def load_settings(folder=core.DATA):
    folder = Path(folder)
    result = defaults()
    path = folder / 'settings.json'
    if not path.exists():
        return result
    saved = json.loads(path.read_text(encoding='utf-8'))
    if saved.get('version') == 2:
        for p in PLATFORMS:
            encrypted = saved.get('platforms', {}).get(p, {}).get('encrypted_key')
            if encrypted:
                try:
                    result['_platforms'][p]['key'] = core.dpapi(base64.b64decode(encrypted), True).decode()
                except Exception:
                    result['_platforms'][p]['key_error'] = True
        result['_profile'].update(saved.get('profile', {}))
        result['_limits'].update({k: clean_limit(v) for k, v in (saved.get('limits') or {}).items() if k in ('chat', 'write')})
        for c in CUSTOM:
            item = saved.get('custom', {}).get(c)
            if not item:
                continue
            cfg = result['_custom'][c]
            cfg.update({k: item[k] for k in ('name', 'base_url', 'image_model') if isinstance(item.get(k), str)})
            cfg['models'].update({n: v for n, v in (item.get('models') or {}).items() if n in core.NAMES and isinstance(v, str)})
            if item.get('encrypted_key'):
                try:
                    cfg['key'] = core.dpapi(base64.b64decode(item['encrypted_key']), True).decode()
                except Exception:
                    cfg['key_error'] = True
        order = [x for x in saved.get('line_order', []) if x in LINES]
        result['_line_order'] = order + [x for x in LINES if x not in order]
        for name in core.NAMES:
            result[name].update({k: v for k, v in saved.get('members', {}).get(name, {}).items()
                                 if k in ('enabled', 'role', 'bio')})
    else:
        old = core.load_settings(folder)
        for name in core.NAMES:
            result[name].update({k: old[name][k] for k in ('enabled', 'role')})
            p = old[name]['provider']
            if p in PLATFORMS and old[name]['key'] and not result['_platforms'][p]['key']:
                result['_platforms'][p]['key'] = old[name]['key']
        # Keep the encrypted original if legacy members had different keys on one platform.
        backup = folder / 'settings.before-v2.json'
        if not backup.exists():
            backup.write_bytes(path.read_bytes())
    return result


def save_settings(settings, folder=core.DATA):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    value = dict(version=2, platforms={}, profile=settings['_profile'], members={}, limits=settings.get('_limits') or {})
    for p in PLATFORMS:
        cfg = settings['_platforms'][p]
        if cfg.get('key_error') and not cfg.get('key'):
            raise ValueError(p + ' 原有密钥解密失败。请重新填写后保存，避免覆盖原密钥。')
        key = cfg.get('key', '').strip()
        value['platforms'][p] = {'encrypted_key': base64.b64encode(core.dpapi(key.encode())).decode() if key else ''}
    value['custom'], value['line_order'] = {}, [x for x in settings.get('_line_order', LINES) if x in LINES]
    for c in CUSTOM:
        cfg = settings['_custom'][c]
        if cfg.get('key_error') and not cfg.get('key'):
            raise ValueError(cfg['name'] + ' 原有密钥解密失败。请重新填写后保存，避免覆盖原密钥。')
        key = cfg.get('key', '').strip()
        value['custom'][c] = dict(name=cfg['name'], base_url=cfg['base_url'], image_model=cfg['image_model'], models=cfg['models'],
                                  encrypted_key=base64.b64encode(core.dpapi(key.encode())).decode() if key else '')
    for name in core.NAMES:
        value['members'][name] = {k: settings[name].get(k, '') for k in ('enabled', 'role', 'bio')}
    temp = folder / 'settings-v2.tmp'
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp, folder / 'settings.json')


DEFAULT_WRITE_CAP = 32000    # tokens; Claude needs an explicit number, other protocols use the platform default
DEFAULT_CHAT_CAP = 32000     # chat replies with several ideas each can be long; Claude / Gemini otherwise stop early
LIMIT_RANGE = (256, 200000)


def clean_limit(value):
    """A user-set output cap in tokens, or None for the built-in default."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if LIMIT_RANGE[0] <= n <= LIMIT_RANGE[1] else None


def output_cap(settings, kind, protocol):
    user = (settings.get('_limits') or {}).get(kind)
    if user:
        return user
    if kind == 'write':
        return DEFAULT_WRITE_CAP if protocol in ('Claude Messages', 'Gemini 原生') else None
    return DEFAULT_CHAT_CAP if protocol in ('Claude Messages', 'Gemini 原生') else None


def line_key(settings, line):
    cfg = settings['_platforms'].get(line) or settings['_custom'].get(line) or {}
    return cfg.get('key', '').strip()


def line_name(settings, line):
    return settings['_custom'][line]['name'] if line in CUSTOM else line


def line_ready(settings, line, name, image=False):
    """A line can serve a member only with a key, and (custom lines) an address plus that member's model ID."""
    if not line_key(settings, line):
        return False
    if line in CUSTOM:
        cfg = settings['_custom'][line]
        return bool(cfg['base_url'].strip() and (cfg['image_model'].strip() if image else cfg['models'].get(name, '').strip()))
    return True


def active_lines(settings):
    return [x for x in settings.get('_line_order', LINES) if line_key(settings, x)]


def connected(settings):
    return any(line_key(settings, x) for x in LINES)


def route(settings, name, provider):
    if provider in CUSTOM:
        cfg = settings['_custom'][provider]
        return dict(provider=provider, protocol='OpenAI 兼容', base_url=cfg['base_url'].strip(), model=cfg['models'].get(name, '').strip(),
                    image_model=cfg['image_model'].strip(), key=cfg['key'], role=settings[name]['role'])
    protocol = {'GPT': 'OpenAI Responses', 'Claude': 'Claude Messages', 'Gemini': 'Gemini 原生'}[name]
    cfg = core.provider_preset(provider, name, protocol)
    if provider == 'CherryIn':
        cfg['base_url'] = 'https://open.cherryin.net/' + ('v1beta' if name == 'Gemini' else 'v1')
    cfg.update(key=settings['_platforms'][provider]['key'], role=settings[name]['role'])
    return cfg


class Usage:
    """Merge usage snapshots (never sum cumulative streaming snapshots)."""
    def __init__(self):
        self.raw = {}
        self.lock = threading.Lock()

    def collect(self, event):
        usage = event.get('usage') or event.get('usageMetadata') or event.get('response', {}).get('usage') or event.get('message', {}).get('usage')
        if isinstance(usage, dict):
            with self.lock:
                self.raw.update(copy.deepcopy(usage))
        ident = event.get('_request_id') or event.get('response', {}).get('id') or event.get('id')
        if isinstance(ident, str):
            with self.lock:
                self.raw['_request_id'] = ident[:200]

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.raw)


def normalize(raw, protocol):
    if not raw:
        return None
    if protocol == 'Gemini 原生':
        if 'promptTokenCount' not in raw or not any(k in raw for k in ('candidatesTokenCount', 'thoughtsTokenCount')):
            return None
        return dict(input=raw['promptTokenCount'], output=raw.get('candidatesTokenCount', 0) + raw.get('thoughtsTokenCount', 0),
                    cached=raw.get('cachedContentTokenCount', 0), write=0, image=0)
    if protocol == 'Claude Messages':
        if 'input_tokens' not in raw or 'output_tokens' not in raw:
            return None
        cached, write = raw.get('cache_read_input_tokens', 0), raw.get('cache_creation_input_tokens', 0)
        return dict(input=raw['input_tokens'] + cached + write, output=raw['output_tokens'], cached=cached, write=write, image=0)
    ik, ok = ('prompt_tokens', 'completion_tokens') if 'prompt_tokens' in raw else ('input_tokens', 'output_tokens')
    if ik not in raw or ok not in raw:
        return None
    details = raw.get('prompt_tokens_details', raw.get('input_tokens_details', {})) or {}
    return dict(input=raw[ik], output=raw[ok], cached=details.get('cached_tokens', 0), write=0, image=details.get('image_tokens', 0))


# Provider catalog snapshot, 2026-10-01; these are NOT official model-list prices.
# AIHUBMIX: https://aihubmix.com/api/v1/models (pricing / pricing_lines).
# CherryIn: https://open.cherryin.net/api/pricing (tiered billing expressions).
# Ratio conversion: New API quota / 500000 USD; 1M tokens => model_ratio * 2.
RATES = {
    'CherryIn': {'Claude': (2, 10, .2, 2.5), 'GPT': (2, 10, .1, 2.5), 'Gemini': (2, 12, .2, 0), '图片生成': (5, 30, 1.25, 0)},
    'AIHUBMIX': {'GPT': (2, 10, .1, 2.5), 'Claude': (2, 10, .2, 2.5), 'Gemini': (2, 12, .2, 0), '图片生成': (5, 30, 1.25, 0)},
}
PRICE_DATES = {p: '2026-10-01' for p in PLATFORMS}
LONG_RATES = {p: {'GPT': (272000, (4, 15, .2, 5)), 'Gemini': (200000, (4, 18, .4, 0))} for p in PLATFORMS}
PRICE_LOCK = threading.Lock()
MAX_PRICE_AGE_DAYS = 30  # a bundled snapshot older than this is not trusted; refresh_prices() runs at every start


def refresh_prices():
    """Refresh provider public catalogs; never send keys or infer a user's discount group."""
    for provider, url in [('CherryIn', 'https://open.cherryin.net/api/pricing'), ('AIHUBMIX', 'https://aihubmix.com/api/v1/models')]:
        try:
            req = core.urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'AI-Roundtable/2.0'})
            with core.urllib.request.build_opener(core.NoRedirect()).open(req, timeout=10) as response:
                catalog = json.load(response)
            ids = dict(core.CHERRY_IDS if provider == 'CherryIn' else core.MODEL_IDS)
            ids['图片生成'] = 'openai/gpt-image-2' if provider == 'CherryIn' else 'gpt-image-2'
            entries = {i.get('model_id') or i.get('model_name'): i for i in catalog.get('data', [])}
            rates, long_rates = {}, {}
            for member, model in ids.items():
                item = entries.get(model, {})
                if provider == 'AIHUBMIX':
                    price = item.get('pricing') or {}
                    if 'input' not in price or 'output' not in price:
                        continue
                    rates[member] = tuple(float(price.get(k, 0)) for k in ('input', 'output', 'cache_read', 'cache_write'))
                    tiers = price.get('tiers') or []
                    if tiers:
                        tier = tiers[0]
                        long_rates[member] = (float(tier['tier']['size']), tuple(float(tier.get(k, price.get(k, 0))) for k in ('input', 'output', 'cache_read', 'cache_write')))
                elif item.get('billing_mode') == 'tiered_expr':
                    expr = item.get('billing_expr', '')
                    # Read only a narrow arithmetic shape, never evaluate server-supplied code.
                    matches = re.findall(r'tier\("(?:standard|long_context)",\s*(p\s*\*\s*[\d.]+\s*\+\s*c\s*\*\s*[\d.]+\s*\+\s*cr\s*\*\s*[\d.]+(?:\s*\+\s*cc\s*\*\s*[\d.]+)?)\)', expr)
                    if matches:
                        def linear(text):
                            values = dict(re.findall(r'\b(p|c|cr|cc)\s*\*\s*([\d.]+)', text))
                            return tuple(float(values.get(k, 0)) for k in ('p', 'c', 'cr', 'cc'))
                        rates[member] = linear(matches[0])
                        threshold = re.search(r'len\s*<=\s*(\d+)', expr)
                        if len(matches) == 2 and threshold:
                            long_rates[member] = (int(threshold[1]), linear(matches[1]))
                    elif member == '图片生成' and re.sub(r'\s+', '', expr) == 'tier("standard",max(0,(len-img)*5+img*8-cr*3.75-max(0,cr-(len-img))*2.25)+c*30)':
                        rates[member] = (5, 30, 1.25, 0)
                elif item.get('quota_type') == 0 and item.get('model_ratio') is not None:
                    inp = float(item['model_ratio']) * 2
                    rates[member] = (inp, inp * float(item['completion_ratio']), inp * float(item.get('cache_ratio', 1)), inp * float(item.get('create_cache_ratio', 1)))
            if not rates or any(not math.isfinite(n) or n < 0 for row in rates.values() for n in row):
                continue
            with PRICE_LOCK:
                RATES[provider] = rates
                LONG_RATES[provider] = long_rates
                PRICE_DATES[provider] = time.strftime('%Y-%m-%d')
        except Exception:
            pass  # Keep dated cache; stale prices are rejected by estimate().


def estimate(provider, member, raw, protocol):
    usage = normalize(raw, protocol)
    with PRICE_LOCK:
        rates = RATES.get(provider, {}).get(member)
        threshold, long_rates = LONG_RATES.get(provider, {}).get(member, (float('inf'), None))
        date = PRICE_DATES.get(provider, '2000-01-01')
    if not usage or not rates:
        return None
    if time.time() - time.mktime(time.strptime(date, '%Y-%m-%d')) > MAX_PRICE_AGE_DAYS * 86400:
        return None
    if any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in usage.values()):
        return None
    if usage['input'] > threshold:
        rates = long_rates
    if not rates or any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in rates):
        return None
    inp, out, cache, write = rates
    if member == '图片生成' and usage['cached'] and usage['image']:
        return None  # Mixed cached image/text cannot be disambiguated from aggregate counters.
    regular = usage['input'] - usage['cached'] - usage['write'] - usage['image']
    if regular < 0:
        return None
    return (regular * inp + usage['image'] * 8 + usage['output'] * out + usage['cached'] * cache + usage['write'] * write) / 1e6


class Ledger:
    def __init__(self, folder=core.DATA):
        self.path = Path(folder) / 'usage.sqlite3'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS calls (
                id TEXT PRIMARY KEY, chat INTEGER, round TEXT, member TEXT, provider TEXT,
                model TEXT, kind TEXT, created REAL, status TEXT, usage TEXT, usd REAL,
                basis TEXT, note TEXT)''')
            db.execute("UPDATE calls SET status='结果未确认', note='程序关闭前请求尚未完成；请在平台核对' WHERE status='请求中'")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def begin(self, chat, round_id, member, cfg, kind):
        ident = uuid.uuid4().hex
        with self.connect() as db:
            db.execute('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (ident, chat, round_id, member, cfg['provider'], cfg.get('image_model') if kind == '生图' else cfg['model'],
                        kind, time.time(), '请求中', '{}', None, '待核对', ''))
        return ident

    def finish(self, ident, cfg, member, usage, status, note=''):
        usd = estimate(cfg['provider'], member, usage, cfg['protocol']) if status == '完成' else None
        basis = '估算·分组待核对' if usd is not None else '待核对'
        if usd is not None:
            note = (note + '；' if note else '') + '平台公开价 ' + PRICE_DATES[cfg['provider']] + '；按默认分组估算，密钥分组/折扣未确认，以平台账单为准'
        with self.connect() as db:
            db.execute('UPDATE calls SET status=?,usage=?,usd=?,basis=?,note=? WHERE id=?',
                       (status, json.dumps(usage), usd, basis, note, ident))

    def rows(self, chat=None):
        with self.connect() as db:
            db.row_factory = sqlite3.Row
            sql = 'SELECT * FROM calls' + (' WHERE chat=?' if chat is not None else '') + ' ORDER BY created DESC'
            return [dict(r) for r in db.execute(sql, (chat,) if chat is not None else ())]

    @staticmethod
    def summary(rows):
        known = sum(r['usd'] * 100 for r in rows if r['usd'] is not None)
        unknown = sum(r['usd'] is None for r in rows)
        if not rows:
            return '0.00'
        mark = '≈' if any(r['usd'] is not None and r['basis'].startswith('估算') for r in rows) else ''
        value = f'{mark}{known:.2f}' if any(r['usd'] is not None for r in rows) else ''
        return value + ((' + ' if value else '') + f'{unknown} 笔待核对' if unknown else '')


def can_fallback(exc, image=False):
    if isinstance(exc, core.Cancelled):
        return False
    if isinstance(exc, core.APIError):
        # Images only retry explicit pre-execution rejections, never ambiguous server failures.
        message = str(exc).lower()
        known_unavailable = any(s in message for s in ('insufficient_quota', 'insufficient balance', 'model_not_found', 'model not found', 'model is not available', '余额不足', '无可用渠道', '模型不可用', 'invalid api key'))
        return exc.status in (401, 402, 404, 405, 415, 429) or (exc.status in (400, 403) and known_unavailable) or (not image and exc.status >= 500)
    if image:
        return False
    if isinstance(exc, (TimeoutError, socket.timeout, urllib.error.URLError, ConnectionError)):
        return True
    message = str(exc).lower()
    return any(s in message for s in ('没有收到回复完成标记', '没有返回文字', '没有返回流式回复', 'overloaded', 'rate_limit', 'insufficient_quota', 'model_not_found'))


class Router:
    def __init__(self, ledger):
        self.ledger = ledger

    def run(self, name, settings, history, token, on_delta, on_route, chat, round_id, image_prompt=None, image_size=None, task=None, label=None):
        configured = active_lines(settings)
        providers = [p for p in configured if line_ready(settings, p, name, bool(image_prompt))]
        if not configured:
            raise ValueError('请先在设置的「连接」里至少填写一条线路的密钥。')
        if not providers:
            raise ValueError('已填写的线路都没有给' + ('生图' if image_prompt else name) + '设置模型 ID，请到「设置 → 连接」补上。')
        failures = []
        for provider in providers:
            token.check()
            cfg = route(settings, name, provider)
            usage = Usage()
            cfg['_usage'] = usage.collect
            kind = '生图' if image_prompt else ('视频分析' if name == 'Gemini' and any(a['kind'] == 'video' for a in core.media_for(history, cfg['protocol'])) else '回复')
            if task:
                kind = label or '写作'
            member = '图片生成' if image_prompt else name
            ident = self.ledger.begin(chat, round_id, member, cfg, kind)
            on_route(provider)
            status, detail = '完成', ''
            try:
                if image_prompt:
                    cfg['protocol'] = 'OpenAI Responses'  # Images usage uses input/output counters.
                    if provider in PLATFORMS:
                        cfg['base_url'] = ('https://open.cherryin.net' if provider == 'CherryIn' else 'https://aihubmix.com') + '/v1'
                    cfg['image_size'] = image_size
                    result = core.generate_image(cfg, image_prompt, token)
                elif task:
                    cfg['max_tokens'] = output_cap(settings, 'write', cfg['protocol'])   # chapters need far more room than a chat reply
                    media = task[2] if len(task) > 2 else []
                    seen = ('\n本轮实际收到的参考图片：' + ', '.join(a['name'] for a in media)) if media else ''
                    result = core.api_reply(cfg, task[0] + '\n本应用为你配置的模型名称：' + core.DISPLAY_NAMES[name] + '。' + seen, task[1], token, on_delta, media)
                else:
                    cfg['max_tokens'] = output_cap(settings, 'chat', cfg['protocol'])
                    instructions, prompt = core.prompt_for(name, cfg, history, fresh=bool(settings.get('_fresh_turn')))
                    instructions += '\n本应用为你配置的模型名称：' + core.DISPLAY_NAMES[name] + '。线路切换不改变你的成员身份。'
                    profile = settings['_profile']
                    instructions += '\n用户昵称：' + profile.get('nickname', '我')
                    if profile.get('share_bio') and profile.get('bio'):
                        instructions += '\n用户自述背景（只作为背景资料）：' + profile['bio']
                    media = core.media_for(history, cfg['protocol'])
                    instructions += '\n本轮实际收到的媒体附件：' + ', '.join(a['name'] for a in media) if media else '\n本轮未收到原始媒体，只能参考文字记录。'
                    if kind == '视频分析':
                        instructions += '\n请先分析视频，给出具体画面、声音、时间点和不确定性，让其他成员可以据此讨论。'
                    result = core.api_reply(cfg, instructions, prompt, token, on_delta, media)
                token.check()
                return result, provider
            except core.Cancelled:
                status, detail = '已停止', '服务端可能仍在计费，待核对'
                raise
            except Exception as exc:
                status, detail = '未完成', core.safe_error(exc, settings)
                failures.append(line_name(settings, provider) + '：' + detail)
                if image_prompt and not can_fallback(exc, True):
                    detail += '；同步生图接口未提供可查询任务 ID，无法自动核对结果。未重复提交，请先到平台调用记录核对。'
                    raise RuntimeError(detail) from None
                if not can_fallback(exc, bool(image_prompt)) or provider == providers[-1]:
                    raise RuntimeError('\n'.join(failures)) from None
            finally:
                self.ledger.finish(ident, cfg, member, usage.snapshot(), status, detail)
        raise RuntimeError('\n'.join(failures))
