"""Turn a manuscript (plain text with light Markdown) into a Word .docx file, using only the standard library.

Handled: # / ## / ### headings, "- " / "* " / "1. " list lines, **bold**, *italic*, blank-line paragraphs and
single line breaks inside a paragraph. Everything else is kept as plain text.
"""
import io
import re
import time
import zipfile
from xml.sax.saxutils import escape

FONT_CN, FONT_EN = '微软雅黑', 'Calibri'

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>'''

DOC_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''


def _style(sid, name, size, bold=False, before=0, after=160, color=None, base='Normal'):
    color_xml = '<w:color w:val="%s"/>' % color if color else ''
    return (f'<w:style w:type="paragraph" w:styleId="{sid}"><w:name w:val="{name}"/><w:basedOn w:val="{base}"/><w:next w:val="Normal"/><w:qFormat/>'
            f'<w:pPr><w:keepNext/><w:spacing w:before="{before}" w:after="{after}"/></w:pPr>'
            f'<w:rPr>{"<w:b/>" if bold else ""}{color_xml}<w:sz w:val="{size}"/><w:szCs w:val="{size}"/></w:rPr></w:style>')


STYLES = ('''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="%s" w:hAnsi="%s" w:eastAsia="%s" w:cs="%s"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
''' % (FONT_EN, FONT_EN, FONT_CN, FONT_EN)
          + _style('Title', 'Title', 40, True, 0, 300)
          + _style('Heading1', 'heading 1', 32, True, 360, 200)
          + _style('Heading2', 'heading 2', 28, True, 300, 160)
          + _style('Heading3', 'heading 3', 26, True, 240, 120)
          + '<w:style w:type="paragraph" w:styleId="ListLine"><w:name w:val="List Line"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="80"/><w:ind w:left="420" w:hanging="300"/></w:pPr></w:style>'
          + '</w:styles>')


def _runs(text):
    """**bold** and *italic* inside a line -> Word runs; line breaks inside a paragraph -> <w:br/>."""
    out = []
    for i, line in enumerate(text.split('\n')):
        if i:
            out.append('<w:r><w:br/></w:r>')
        for part in re.split(r'(\*\*[^*\n]+\*\*|(?<![*\w])\*[^*\n]+\*(?![*\w]))', line):
            if not part:
                continue
            props = ''
            if part.startswith('**') and part.endswith('**') and len(part) > 4:
                part, props = part[2:-2], '<w:rPr><w:b/></w:rPr>'
            elif part.startswith('*') and part.endswith('*') and len(part) > 2:
                part, props = part[1:-1], '<w:rPr><w:i/></w:rPr>'
            out.append(f'<w:r>{props}<w:t xml:space="preserve">{escape(part)}</w:t></w:r>')
    return ''.join(out)


def _para(text, style=None):
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ''
    return f'<w:p>{ppr}{_runs(text)}</w:p>'


def body_xml(text, title=''):
    paras, first_heading_done = [], False
    shift = 1 if re.search(r'(?m)^\s*#\s', text or '') else 0      # "# 书名" on top: "##" becomes the first heading level
    blocks = re.split(r'\n\s*\n', (text or '').replace('\r\n', '\n').strip())
    if title and not re.match(r'^#\s', blocks[0] if blocks else ''):
        paras.append(_para(title, 'Title'))
        first_heading_done = True
    for block in blocks:
        lines = block.split('\n')
        pending = []
        for line in lines:
            m = re.match(r'^(#{1,6})\s+(.*)$', line.strip())
            li = re.match(r'^\s*(?:[-*•]|\d+[.、)])\s+(.*)$', line)
            if m or li:
                if pending:
                    paras.append(_para('\n'.join(pending)))
                    pending = []
                if m:
                    level, words = len(m.group(1)), m.group(2).strip()
                    if level == 1 and not first_heading_done:
                        style, first_heading_done = 'Title', True
                    else:
                        style = 'Heading%d' % min(3, max(1, level - shift))
                    paras.append(_para(words, style))
                else:
                    bullet = re.match(r'^\s*(\d+[.、)])', line)
                    mark = bullet.group(1) if bullet else '•'
                    paras.append(_para(mark + ' ' + li.group(1), 'ListLine'))
            elif line.strip() in ('---', '***', '___'):
                continue
            else:
                pending.append(line)
        if pending:
            paras.append(_para('\n'.join(pending)))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
            + ''.join(paras or [_para('')])
            + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'
            '</w:body></w:document>')


def build(title, text):
    stamp = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f'<dc:title>{escape(title or "")}</dc:title><dc:creator>AI 圆桌</dc:creator>'
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{stamp}</dcterms:created>'
            f'<dcterms:modified xsi:type="dcterms:W3CDTF">{stamp}</dcterms:modified></cp:coreProperties>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES)
        z.writestr('_rels/.rels', RELS)
        z.writestr('word/_rels/document.xml.rels', DOC_RELS)
        z.writestr('word/styles.xml', STYLES)
        z.writestr('word/document.xml', body_xml(text, title))
        z.writestr('docProps/core.xml', core)
    return buf.getvalue()
