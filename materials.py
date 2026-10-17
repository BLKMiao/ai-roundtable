"""Reference material for writing: documents, pasted text and web pages turned into plain text the models can use.

Everything here runs locally except fetching a link, which only ever happens when the user adds one.
"""
import html
import io
import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from html.parser import HTMLParser
from pathlib import Path

MAX_TEXT = 200000            # characters kept per material (what is sent to a model is trimmed again)
MAX_PAGE_BYTES = 3 * 1024 * 1024
TEXT_EXT = {'.txt', '.md', '.markdown', '.csv', '.json', '.log', '.srt', '.vtt', '.xml', '.yaml', '.yml', '.tex'}
HTML_EXT = {'.html', '.htm'}
IMAGE_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'}
SUPPORTED = '文本（txt、md、csv…）、网页（html）、Word（docx）、PDF、图片'


def decode(data):
    """Chinese files are often GBK; try the common encodings in a sensible order."""
    if data[:2] in (b'\xff\xfe', b'\xfe\xff'):
        return data.decode('utf-16', 'replace')
    for enc in ('utf-8-sig', 'gb18030'):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode('utf-8', 'replace')


def tidy(text):
    text = text.replace('\r\n', '\n').replace('\r', '\n').replace(' ', ' ').replace('​', '')
    text = re.sub(r'[ \t\f\v]+', ' ', text)
    text = '\n'.join(line.strip() for line in text.split('\n'))
    return re.sub(r'\n{3,}', '\n\n', text).strip()


class _Page(HTMLParser):
    SKIP = {'script', 'style', 'noscript', 'svg', 'iframe', 'form', 'nav', 'footer', 'aside', 'template', 'button', 'select'}
    BLOCK = {'p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'section', 'article', 'blockquote', 'pre', 'ul', 'ol', 'table', 'main'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.in_title = False
        self.title = ''
        self.og = ''
        self.all, self.article = [], []
        self.article_depth = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'meta' and (a.get('property') == 'og:title' or a.get('name') == 'twitter:title') and a.get('content'):
            self.og = self.og or a['content']
        if tag == 'title':
            self.in_title = True
        if tag in self.SKIP:
            self.skip += 1
        if tag == 'article':
            self.article_depth += 1
        if tag in self.BLOCK and not self.skip:
            self.put('\n' + ('\n' if tag in ('p', 'h1', 'h2', 'h3', 'h4', 'section', 'article', 'blockquote') else ''))

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag == 'article' and self.article_depth:
            self.article_depth -= 1
        if tag in self.BLOCK and not self.skip:
            self.put('\n')

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        elif not self.skip:
            self.put(data)

    def put(self, text):
        self.all.append(text)
        if self.article_depth:
            self.article.append(text)


def html_to_text(raw):
    """Return (title, readable text). Prefers the <article> element when the page has a substantial one."""
    parser = _Page()
    try:
        parser.feed(raw)
        parser.close()
    except Exception:
        pass
    whole, article = tidy(''.join(parser.all)), tidy(''.join(parser.article))
    return tidy(html.unescape(parser.og or parser.title)), (article if len(article) > 300 else whole)


def docx_text(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = z.read('word/document.xml').decode('utf-8', 'replace')
    xml = re.sub(r'</w:p>|<w:br[^>]*/>|</w:tr>', '\n', xml)
    xml = re.sub(r'<w:tab[^>]*/>', '\t', xml)
    return tidy(html.unescape(re.sub(r'<[^>]+>', '', xml)))


def pdf_text(data):
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent / 'vendor'))
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        try:
            reader.decrypt('')
        except Exception:
            raise ValueError('这个 PDF 有密码保护，读取不了。')
    pages = []
    for page in reader.pages[:200]:
        try:
            pages.append(page.extract_text() or '')
        except Exception:
            pages.append('')
    text = tidy('\n\n'.join(pages))
    if len(text) < 20:
        raise ValueError('这个 PDF 里读不到文字（可能是扫描件）。可以把页面截成图片再添加，或复制文字后用「粘贴文字资料」。')
    return text


def from_file(name, data):
    """Return (kind, title, text) for an uploaded document. Images are handled by the caller."""
    ext = Path(name).suffix.lower()
    if ext in TEXT_EXT:
        return 'file', Path(name).stem, tidy(decode(data))
    if ext in HTML_EXT:
        title, text = html_to_text(decode(data))
        return 'file', title or Path(name).stem, text
    if ext == '.docx':
        try:
            return 'file', Path(name).stem, docx_text(data)
        except (zipfile.BadZipFile, KeyError):
            raise ValueError('这个 Word 文件读取失败，可能已损坏。')
    if ext == '.pdf':
        return 'file', Path(name).stem, pdf_text(data)
    if ext in ('.doc', '.wps', '.pages', '.ppt', '.pptx', '.xls', '.xlsx'):
        raise ValueError(f'暂不支持 {ext} 文件。请另存为 docx 或 PDF，或复制文字后用「粘贴文字资料」。')
    raise ValueError(f'不支持这种文件。可以添加：{SUPPORTED}。')


# ---- web pages ---------------------------------------------------------------------------
def check_public(host, allow_private=False):
    """Refuse addresses that are not on the public internet (this machine, home/office network, cloud metadata)."""
    if allow_private:
        return
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise ValueError('打不开这个网址（找不到这个域名）。')
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split('%')[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise ValueError('不能读取本机或内网地址，只支持公开的网页。')


class _Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, allow_private):
        self.allow_private = allow_private

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme not in ('http', 'https'):
            raise ValueError('网页跳转到了不支持的地址。')
        check_public(parsed.hostname or '', self.allow_private)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_link(url, allow_private=False, timeout=15):
    """Download a page and reduce it to readable text. Returns dict(title, text, url)."""
    url = (url or '').strip()
    if re.match(r'^[\w.-]+\.[a-z]{2,}(/|$)', url, re.I):
        url = 'https://' + url
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username:
        raise ValueError('请填写完整的网页地址，例如 https://example.com/文章')
    check_public(parsed.hostname, allow_private)
    request = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6'})
    try:
        with urllib.request.build_opener(_Redirects(allow_private)).open(request, timeout=timeout) as response:
            kind = (response.headers.get('Content-Type') or '').lower()
            raw = response.read(MAX_PAGE_BYTES + 1)
            charset = response.headers.get_content_charset()
    except urllib.error.HTTPError as exc:
        raise ValueError(f'网页返回了错误（HTTP {exc.code}）。可能需要登录，或网站不允许程序读取；可以改用「粘贴文字资料」。') from None
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
        reason = getattr(exc, 'reason', exc)
        raise ValueError('读取网页失败：' + str(reason)[:120]) from None
    if len(raw) > MAX_PAGE_BYTES:
        raise ValueError('这个网页太大了（超过 3 MB）。')
    if 'pdf' in kind or url.lower().split('?')[0].endswith('.pdf'):
        return dict(title=Path(parsed.path).stem or parsed.hostname, text=pdf_text(raw)[:MAX_TEXT], url=url)
    if kind and not any(k in kind for k in ('html', 'text', 'xml', 'json')):
        raise ValueError('这个链接不是网页或文字（' + kind.split(';')[0] + '）。')
    text = None
    for enc in [charset] if charset else []:
        try:
            text = raw.decode(enc)
        except (LookupError, UnicodeDecodeError):
            text = None
    if text is None:
        head = raw[:4096].decode('ascii', 'ignore')
        found = re.search(r'charset=["\']?([\w-]+)', head, re.I)
        try:
            text = raw.decode(found.group(1)) if found else decode(raw)
        except (LookupError, UnicodeDecodeError):
            text = decode(raw)
    if 'html' in kind or '<html' in text[:2000].lower() or '<body' in text[:4000].lower():
        title, body = html_to_text(text)
    else:
        title, body = '', tidy(text)
    if len(body) < 200:
        raise ValueError('这个网页没有读到正文（可能需要登录，或内容由脚本生成）。可以复制文字后用「粘贴文字资料」。')
    return dict(title=title or parsed.hostname, text=body[:MAX_TEXT], url=url)
