/* Small, safe Markdown renderer for chat replies.
   Everything is HTML-escaped first; only tags produced here reach the DOM. */
(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function inline(text) {
    const codes = [];
    text = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => { codes.push(code.trim()); return '\u0001' + (codes.length - 1) + '\u0001'; });
    text = esc(text);
    text = text.replace(/\\([\\`*_{}\[\]()#+\-.!~|])/g, (_, c) => '\u0002' + c.charCodeAt(0) + '\u0002');
    text = text.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
      (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    text = text.replace(/(^|[\s(（])(https?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?，。；：！？、'"&])/g,
      (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^\w*])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
    text = text.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\w|\*)/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
    text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    text = text.replace(/\u0002(\d+)\u0002/g, (_, n) => esc(String.fromCharCode(+n)));
    return text.replace(/\u0001(\d+)\u0001/g, (_, i) => '<code>' + esc(codes[+i]) + '</code>');
  }

  const isTableSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('-') && l.includes('|');
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const listMatch = (l) => /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(l);

  function blocks(lines, codeBlocks) {
    const out = [];
    let i = 0;
    const special = (l, next) => /^\u0000B\d+\u0000$/.test(l.trim()) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || listMatch(l) ||
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) || (l.includes('|') && next !== undefined && isTableSep(next));
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const code = /^\u0000B(\d+)\u0000$/.exec(line.trim());
      if (code) {
        const { lang, text } = codeBlocks[+code[1]];
        out.push(`<div class="code"><div class="code-head"><span>${esc(lang || '代码')}</span><button type="button" data-copy-code>复制</button></div><pre><code>${esc(text)}</code></pre></div>`);
        i++; continue;
      }
      const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + blocks(quote, codeBlocks) + '</blockquote>');
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        const aligns = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
        const td = (tag, c, n) => `<${tag}${aligns[n] ? ` style="text-align:${aligns[n]}"` : ''}>${inline(c || '')}</${tag}>`;
        out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c, n) => td('th', c, n)).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_, n) => td('td', r[n], n)).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }
      if (listMatch(line)) {
        const items = [];
        while (i < lines.length) {
          const m = listMatch(lines[i]);
          if (m) { items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] }); i++; }
          else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length && !/^\u0000B/.test(lines[i].trim())) { items[items.length - 1].text += '\n' + lines[i].trim(); i++; }
          else if (!lines[i].trim() && i + 1 < lines.length && listMatch(lines[i + 1])) { i++; }
          else break;
        }
        out.push(buildList(items));
        continue;
      }
      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !special(lines[i], lines[i + 1])) { para.push(lines[i]); i++; }
      out.push('<p>' + para.map((l) => inline(l.trim())).join('<br>') + '</p>');
    }
    return out.join('');
  }

  function buildList(items) {
    let html = '';
    const stack = [];
    const open = (item) => { const tag = item.ordered ? 'ol' : 'ul'; html += `<${tag}${item.ordered && item.start > 1 ? ` start="${item.start}"` : ''}>`; stack.push({ tag, indent: item.indent }); };
    const close = () => { html += `</li></${stack.pop().tag}>`; };
    items.forEach((item, n) => {
      if (!stack.length) { open(item); }
      else if (item.indent > stack[stack.length - 1].indent + 1) { open(item); }
      else {
        while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) close();
        if (stack[stack.length - 1].tag !== (item.ordered ? 'ol' : 'ul')) { close(); open(item); }
        else html += '</li>';
      }
      html += '<li>' + inline(item.text).replace(/\n/g, '<br>');
    });
    while (stack.length) close();
    return html;
  }

  function render(src) {
    src = String(src || '').replace(/\r\n?/g, '\n');
    const codeBlocks = [];
    src = src.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([^\s`~]*)[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[`~]*[ \t]*(?=\n|$)|$)/g, (_, pre, _f, lang, text) => {
      codeBlocks.push({ lang, text: text.replace(/\n$/, '') });
      return pre + '\u0000B' + (codeBlocks.length - 1) + '\u0000';
    });
    return blocks(src.split('\n'), codeBlocks);
  }

  window.md = { render, esc };
})();
