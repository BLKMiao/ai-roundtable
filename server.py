"""Local HTTP + Server-Sent Events bridge between the web front end (web/) and Controller.

Listens on 127.0.0.1 only. Every request needs the per-launch token cookie and a local Host header, so another
web page open in the user's browser cannot talk to the app (CSRF / DNS rebinding).
"""
import json
import mimetypes
import queue
import re
import secrets
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import core
from controller import ConfigError

WEB = Path(__file__).resolve().parent / 'web'
MAX_BODY = 48 * 1024 * 1024
mimetypes.add_type('image/svg+xml', '.svg')
mimetypes.add_type('text/javascript', '.js')


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, controller, port=0):
        super().__init__(('127.0.0.1', port), Handler)
        self.controller = controller
        self.token = secrets.token_urlsafe(24)
        self.clients = 0
        self.ever_connected = False
        self.last_client = time.monotonic()

    @property
    def origin(self):
        return f'http://127.0.0.1:{self.server_port}'

    def url(self):
        return f'{self.origin}/?t={self.token}'


ROUTES = []


def route(method, pattern):
    def register(fn):
        ROUTES.append((method, re.compile('^' + pattern + '$'), fn))
        return fn
    return register


class Handler(BaseHTTPRequestHandler):
    server_version = 'AIRoundtable/3.0'

    def log_message(self, *args):
        pass

    # -- plumbing ----------------------------------------------------------------------------
    @property
    def app(self):
        return self.server.controller

    def local_host(self):
        host = (self.headers.get('Host') or '').lower()
        return host in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}')

    def authorized(self, query):
        cookie = self.headers.get('Cookie') or ''
        token = next((p.split('=', 1)[1] for p in (c.strip() for c in cookie.split(';')) if p.startswith('rt=')), '')
        return secrets.compare_digest(token, self.server.token) or \
            secrets.compare_digest(query.get('t', [''])[0], self.server.token)

    def send_json(self, data, status=200):
        raw = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_BODY:
            raise ValueError('文件太大。')
        return self.rfile.read(length) if length else b''

    def json_body(self):
        raw = self.body()
        return json.loads(raw.decode('utf-8')) if raw else {}

    def dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        if not self.local_host():
            return self.send_json(dict(error='forbidden'), 403)
        if method == 'POST':
            origin = self.headers.get('Origin')
            if origin and origin != self.server.origin and origin != f'http://localhost:{self.server.server_port}':
                return self.send_json(dict(error='forbidden'), 403)
        is_page = parsed.path in ('/', '/index.html')
        if not self.authorized(query):
            return self.send_json(dict(error='unauthorized'), 401)
        for verb, pattern, fn in ROUTES:
            found = pattern.match(parsed.path)
            if verb == method and found:
                try:
                    return fn(self, query, *[urllib.parse.unquote(g) for g in found.groups()])
                except ConfigError as exc:
                    return self.send_json(dict(error=str(exc), code='config'), 400)
                except (ValueError, KeyError, json.JSONDecodeError) as exc:
                    return self.send_json(dict(error=str(exc) or '请求无效。'), 400)
                except (BrokenPipeError, ConnectionError):
                    return
                except Exception as exc:
                    return self.send_json(dict(error=core.safe_error(exc, self.app.settings)), 500)
        if method == 'GET':
            return self.static(parsed.path, is_page)
        self.send_json(dict(error='not found'), 404)

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def static(self, path, is_page):
        name = 'index.html' if is_page else path.lstrip('/')
        target = (WEB / name).resolve()
        if not target.is_relative_to(WEB.resolve()) or not target.is_file():
            return self.send_json(dict(error='not found'), 404)
        self.send_file(target, cookie=is_page)

    def send_file(self, target, cookie=False, cache='no-cache'):
        raw = target.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', (mimetypes.guess_type(target.name)[0] or 'application/octet-stream') +
                         ('; charset=utf-8' if target.suffix in ('.html', '.js', '.css', '.svg') else ''))
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', cache)
        if cookie:
            self.send_header('Set-Cookie', f'rt={self.server.token}; Path=/; HttpOnly; SameSite=Strict')
        self.end_headers()
        self.wfile.write(raw)


# ---- routes ----------------------------------------------------------------------------------
@route('GET', r'/files/(attachments|profile)/([^/]+)')
def files(h, q, kind, name):
    target = (h.app.folder / kind / Path(name).name)
    if not target.is_file():
        return h.send_json(dict(error='not found'), 404)
    h.send_file(target, cache='private, max-age=86400')


@route('GET', r'/api/bootstrap')
def bootstrap(h, q):
    h.send_json(h.app.bootstrap())


@route('GET', r'/api/chats')
def chats(h, q):
    h.send_json(h.app.chats())


@route('GET', r'/api/chat/(\d+)')
def chat(h, q, chat_id):
    h.send_json(h.app.chat(int(chat_id)))


@route('POST', r'/api/chat/new')
def new_chat(h, q):
    h.send_json(dict(id=h.app.new_chat()))


@route('POST', r'/api/chat/direct')
def direct_chat(h, q):
    h.send_json(dict(id=h.app.direct_chat(h.json_body().get('name', ''))))


@route('POST', r'/api/icon/upload')
def icon_upload(h, q):
    h.send_json(dict(icon=h.app.make_badge_photo(h.body())))


@route('POST', r'/api/chat/(\d+)/icon')
def chat_icon(h, q, chat_id):
    h.app.set_chat_icon(int(chat_id), h.json_body().get('icon', ''))
    h.send_json(dict(ok=True))


@route('POST', r'/api/chat/(\d+)/rename')
def rename_chat(h, q, chat_id):
    h.app.rename_chat(int(chat_id), h.json_body().get('title', ''))
    h.send_json(dict(ok=True))


@route('POST', r'/api/chat/(\d+)/delete')
def delete_chat(h, q, chat_id):
    h.app.delete_chat(int(chat_id))
    h.send_json(dict(ok=True))


@route('GET', r'/api/chat/(\d+)/export')
def export(h, q, chat_id):
    title, text = h.app.export_markdown(int(chat_id))
    h.send_json(dict(title=title, text=text))


@route('POST', r'/api/send')
def send(h, q):
    d = h.json_body()
    h.send_json(h.app.send(int(d['chat']), d.get('text', ''), d.get('uploads') or [], d.get('target', 'all'), d.get('rounds', 1),
                           d.get('preset', '')))


@route('POST', r'/api/stop')
def stop(h, q):
    h.app.stop()
    h.send_json(dict(ok=True))


@route('POST', r'/api/retry')
def retry(h, q):
    d = h.json_body()
    h.send_json(h.app.retry(int(d['chat']), int(d['message'])))


@route('POST', r'/api/image')
def image(h, q):
    d = h.json_body()
    h.send_json(h.app.generate_image(int(d['chat']), d.get('prompt', ''), d.get('size', '')))


@route('POST', r'/api/upload')
def upload(h, q):
    h.send_json(h.app.upload(q.get('name', ['file'])[0], h.body()))


@route('POST', r'/api/upload/discard')
def discard(h, q):
    h.app.discard_upload(h.json_body().get('id', ''))
    h.send_json(dict(ok=True))


@route('POST', r'/api/chat/(\d+)/mute')
def mute(h, q, chat_id):
    d = h.json_body()
    h.app.set_muted(int(chat_id), d.get('name', ''), bool(d.get('muted')))
    h.send_json(dict(muted=h.app.store.muted(int(chat_id))))


@route('POST', r'/api/chat/(\d+)/order')
def order(h, q, chat_id):
    h.app.set_order(int(chat_id), h.json_body().get('order'))
    h.send_json(dict(order=h.app.store.order(int(chat_id))))


@route('POST', r'/api/settings')
def settings(h, q):
    h.app.save_settings(h.json_body())
    h.send_json(h.app.bootstrap())


@route('POST', r'/api/avatar')
def avatar(h, q):
    h.send_json(dict(avatar=h.app.set_avatar(h.body())))


@route('POST', r'/api/avatar/clear')
def avatar_clear(h, q):
    h.app.clear_avatar()
    h.send_json(dict(ok=True))


@route('POST', r'/api/check')
def check(h, q):
    d = h.json_body()
    h.send_json(h.app.check_connections(d.get('keys'), d.get('custom')))


@route('GET', r'/api/usage')
def usage(h, q):
    h.send_json(h.app.usage_details())


@route('POST', r'/api/usage/reconcile')
def reconcile(h, q):
    d = h.json_body()
    h.app.reconcile(d['id'], d['usd'])
    h.send_json(dict(ok=True))


@route('GET', r'/api/write/scenes')
def write_scenes(h, q):
    h.send_json(h.app.writer.scenes())


@route('GET', r'/api/write/docs')
def write_docs(h, q):
    h.send_json(h.app.writer.list())


@route('POST', r'/api/write/doc/new')
def write_new(h, q):
    d = h.json_body()
    h.send_json(dict(id=h.app.writer.create(d.get('kind', ''), d.get('title', ''), d.get('work', ''))))


@route('GET', r'/api/write/doc/(\d+)')
def write_get(h, q, doc_id):
    h.send_json(h.app.writer.get(int(doc_id)))


@route('POST', r'/api/write/doc/(\d+)/save')
def write_save(h, q, doc_id):
    h.app.writer.save(int(doc_id), h.json_body())
    h.send_json(dict(ok=True))


@route('POST', r'/api/write/doc/(\d+)/snapshot')
def write_snapshot(h, q, doc_id):
    h.app.writer.snapshot_now(int(doc_id), h.json_body().get('note', ''))
    h.send_json(dict(ok=True))


@route('POST', r'/api/write/doc/(\d+)/restore')
def write_restore(h, q, doc_id):
    h.send_json(dict(body=h.app.writer.restore(int(doc_id), int(h.json_body().get('version')))))


@route('POST', r'/api/write/doc/(\d+)/delete')
def write_delete(h, q, doc_id):
    h.app.writer.delete(int(doc_id))
    h.send_json(dict(ok=True))


@route('GET', r'/api/write/doc/(\d+)/export')
def write_export(h, q, doc_id):
    title, text = h.app.writer.export(int(doc_id))
    h.send_json(dict(title=title, text=text))


@route('GET', r'/api/write/doc/(\d+)/export\.docx')
def write_export_docx(h, q, doc_id):
    import docx_export
    title, text = h.app.writer.export(int(doc_id))
    raw = docx_export.build(title, text)
    h.send_response(200)
    h.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    h.send_header('Content-Length', str(len(raw)))
    h.send_header('Cache-Control', 'no-store')
    h.end_headers()
    h.wfile.write(raw)


@route('POST', r'/api/write/run')
def write_run(h, q):
    d = h.json_body()
    h.send_json(h.app.writer.start(int(d['doc']), d.get('action', ''), d.get('members'), d.get('prompt', ''), bool(d.get('use_body')),
                                   d.get('selection'), d.get('option', ''), d.get('base_item'), d.get('review_ids'), d.get('source_item'), d.get('marks'),
                                   d.get('template', '')))


@route('GET', r'/api/write/vtemplates')
def write_vtemplates(h, q):
    h.send_json(h.app.writer.video_templates())


@route('POST', r'/api/write/vtemplates')
def write_vtemplates_save(h, q):
    d = h.json_body()
    h.send_json(h.app.writer.save_video_templates(d.get('items') or [], d.get('default', 'builtin')))


@route('POST', r'/api/write/vtemplates/parse')
def write_vtemplates_parse(h, q):
    h.send_json(h.app.writer.template_from_file(q.get('name', ['模板.txt'])[0], h.body()))


@route('POST', r'/api/write/item/(\d+)/redo')
def write_item_redo(h, q, item_id):
    h.send_json(h.app.writer.redo_item(int(item_id)))


@route('POST', r'/api/write/item/(\d+)/content')
def write_item_content(h, q, item_id):
    h.app.writer.set_item_content(int(item_id), h.json_body().get('content', ''))
    h.send_json(dict(ok=True))


@route('POST', r'/api/write/doc/(\d+)/clean')
def write_clean(h, q, doc_id):
    h.send_json(dict(removed=h.app.writer.clean_items(int(doc_id), h.json_body().get('kinds') or [])))


@route('POST', r'/api/write/item/(\d+)/favorite')
def write_item_favorite(h, q, item_id):
    d = h.json_body()
    h.app.writer.set_favorite(int(item_id), d.get('value'), d.get('kind', 'fav'))
    h.send_json(dict(ok=True))


@route('POST', r'/api/write/doc/(\d+)/ref/file')
def write_ref_file(h, q, doc_id):
    h.send_json(h.app.writer.add_ref_file(int(doc_id), q.get('name', ['资料'])[0], h.body()))


@route('POST', r'/api/write/doc/(\d+)/ref/text')
def write_ref_text(h, q, doc_id):
    d = h.json_body()
    h.send_json(h.app.writer.add_ref_text(int(doc_id), d.get('name', ''), d.get('text', '')))


@route('POST', r'/api/write/doc/(\d+)/ref/link')
def write_ref_link(h, q, doc_id):
    h.send_json(h.app.writer.add_ref_link(int(doc_id), h.json_body().get('url', '')))


@route('GET', r'/api/write/ref/(\d+)')
def write_ref_get(h, q, ref_id):
    h.send_json(h.app.writer.ref_text(int(ref_id)))


@route('POST', r'/api/write/ref/(\d+)/delete')
def write_ref_delete(h, q, ref_id):
    h.app.writer.remove_ref(int(ref_id))
    h.send_json(dict(ok=True))


@route('POST', r'/api/write/item/(\d+)/stop')
def write_item_stop(h, q, item_id):
    h.app.writer.stop_item(int(item_id))
    h.send_json(dict(ok=True))


@route('POST', r'/api/write/item/(\d+)/delete')
def write_item_delete(h, q, item_id):
    h.app.writer.delete_item(int(item_id))
    h.send_json(dict(ok=True))


@route('GET', r'/events')
def events(h, q):
    h.send_response(200)
    h.send_header('Content-Type', 'text/event-stream; charset=utf-8')
    h.send_header('Cache-Control', 'no-store')
    h.send_header('Connection', 'close')
    h.end_headers()
    app, server = h.app, h.server
    inbox = app.subscribe()
    server.clients += 1
    server.ever_connected = True
    try:
        h.wfile.write(b'retry: 1500\n\n')
        h.wfile.flush()
        while True:
            try:
                event = inbox.get(timeout=12)
                payload = 'data: ' + json.dumps(event, ensure_ascii=False) + '\n\n'
            except queue.Empty:
                payload = ': ping\n\n'
            h.wfile.write(payload.encode('utf-8'))
            h.wfile.flush()
    except (BrokenPipeError, ConnectionError, OSError):
        pass
    finally:
        app.unsubscribe(inbox)
        server.clients -= 1
        server.last_client = time.monotonic()
