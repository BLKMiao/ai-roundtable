/* AI 圆桌 — 写作模式：稿件、三位 AI 起草 / 点评 / 融合 / 润色。依赖 app.js 暴露的 window.RT。 */
(() => {
  const { $, $$, esc, icon, api, prefs, toast, menu, modal, confirmBox, clock, short, bucket } = ui;
  const MEMBERS = ['Claude', 'GPT', 'Gemini'];
  const KIND = { draft: '草稿', merge: '融合稿', review: '点评', edit: '修改建议' };
  const W = {
    entered: false, scenes: null, docs: [], works: [], query: '', doc: null, items: [], versions: [], usage: null, tab: 'draft',
    refs: [], pick: { Claude: true, GPT: true, Gemini: true }, sel: null, useBody: null, prompt: '', prompt2: '', favOnly: '', saveTimer: null, state: 'saved', openRound: null,
  };
  const RT = () => window.RT;
  const running = () => RT().S.running && RT().S.runChat === -(W.doc?.id || 0);
  const busyElsewhere = () => RT().S.running && !running();
  const words = (t) => ((t || '').match(/[一-鿿]/g) || []).length + ((t || '').replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
  const scene = () => W.scenes[W.doc.kind];

  // ---------- entering / lists ----------
  async function enter() {
    if (!W.scenes) { W.scenes = await api('/api/write/scenes'); shell(); }
    await refreshDocs();
    if (W.doc) { renderMain(); return; }
    const saved = prefs.get('wdoc', null);
    const id = W.docs.find((d) => d.id === saved)?.id ?? W.docs[0]?.id;
    if (id !== undefined) await openDoc(id); else renderMain();
  }
  async function refreshDocs() {
    const r = await api('/api/write/docs');
    W.docs = r.docs; W.works = r.works; renderList();
  }
  function renderList() {
    const box = $('#wlist');
    if (!box || !W.scenes) return;
    const q = W.query.trim().toLowerCase();
    const docs = W.docs.filter((d) => !q || d.title.toLowerCase().includes(q) || d.work.toLowerCase().includes(q) || d.preview.toLowerCase().includes(q));
    const row = (d) => `<div class="chat-item ${W.doc?.id === d.id ? 'on' : ''}" data-doc="${d.id}">
      ${d.icon ? RT().chatBadge(d.id, 40, d.icon) : `<span class="av kindav k-${d.kind}" style="width:40px;height:40px">${icon(W.scenes[d.kind].icon)}</span>`}
      <div class="body"><div class="row"><span class="title">${esc(d.title)}</span><span class="time">${short(d.updated)}</span></div>
      <div class="preview">${esc(W.scenes[d.kind].short)} · ${d.size ? esc((d.preview || '').replace(/\s+/g, ' ')) || '已有正文' : '还没有正文'}</div></div>
      <button class="more" type="button" data-wmore="${d.id}" aria-label="更多">${icon('more')}</button></div>`;
    let html = '';
    const works = [...new Set(docs.filter((d) => d.work).map((d) => d.work))];
    for (const w of works) html += `<div class="group-label">作品 · ${esc(w)}</div>` + docs.filter((d) => d.work === w).sort((a, b) => a.id - b.id).map(row).join('');
    let current = '';
    for (const d of docs.filter((x) => !x.work)) {
      const g = bucket(d.updated);
      if (g !== current) { current = g; html += `<div class="group-label">${g}</div>`; }
      html += row(d);
    }
    box.querySelector('.chats').innerHTML = html || `<div class="empty-list">${q ? '没有找到相关稿件' : '还没有稿件，点右上角 + 新建'}</div>`;
  }
  function shell() {
    const box = $('#wlist');
    box.innerHTML = `<div class="list-head"><h1>写作</h1><button class="icon-btn solid" id="wNew" data-tip="新建稿件">${icon('plus')}</button></div>
      <label class="search">${icon('search')}<input id="wSearch" placeholder="搜索稿件" autocomplete="off"></label>
      <div class="chats" id="wChats"></div>`;
    $('#wNew').onclick = newDoc;
    $('#wSearch').oninput = (e) => { W.query = e.target.value; renderList(); };
    box.querySelector('.chats').addEventListener('click', (e) => {
      const more = e.target.closest('[data-wmore]');
      if (more) { e.stopPropagation(); docMenu(more, +more.dataset.wmore, { align: 'right' }); return; }
      const item = e.target.closest('[data-doc]'); if (item) openDoc(+item.dataset.doc);
    });
    box.querySelector('.chats').addEventListener('contextmenu', (e) => { const item = e.target.closest('[data-doc]'); if (item) { e.preventDefault(); docMenu({ x: e.clientX, y: e.clientY }, +item.dataset.doc); } });
  }
  function changeDocIcon(id) {
    const d = W.docs.find((x) => x.id === id); if (!d) return;
    const save = async (icon) => {
      try {
        await api(`/api/write/doc/${id}/save`, { icon }); d.icon = icon;
        if (W.doc && W.doc.id === id) { W.doc.icon = icon; const h = $('#wIcon'); if (h) h.innerHTML = icon ? RT().chatBadge(id, 40, icon) : `<span class="av kindav k-${W.doc.kind}" style="width:40px;height:40px">${icon(scene().icon)}</span>`; }
        renderList();
      } catch (e) { toast(e.message, 'err'); }
    };
    RT().pickBadge({ start: d.icon || (id % RT().BADGE_N[0]) + ':' + (id % RT().BADGE_N[1]), onSave: save, onReset: () => save('') });
  }
  function docMenu(anchor, id, opts) {
    const d = W.docs.find((x) => x.id === id);
    menu(anchor, [
      { label: '重命名', icon: 'pencil', run: () => { (W.doc?.id === id ? Promise.resolve() : openDoc(id)).then(startRename); } },
      { label: '更换图标', icon: 'sparkles', run: () => changeDocIcon(id) },
      { label: '导出 Word（.docx）', icon: 'doc', run: () => exportDoc(id, 'docx') },
      { label: '导出 Markdown（.md）', icon: 'download', run: () => exportDoc(id, 'md') },
      '-',
      { label: '删除稿件', icon: 'trash', danger: true, run: () => removeDoc(id, d?.title) },
    ], opts);
  }

  // ---------- documents ----------
  async function newDoc() {
    let kind = 'article';
    const d = modal({ title: '新建稿件', cls: 'mid', body: `<div class="scene-grid">${Object.entries(W.scenes).map(([k, s]) => `<button type="button" class="scene-card ${k === kind ? 'on' : ''}" data-kind="${k}">${icon(s.icon)}<b>${esc(s.label)}</b><span>${esc(s.desc)}</span></button>`).join('')}</div>
      <label class="field" style="margin-top:14px"><span>标题（可以先空着）</span><input class="input" id="nTitle" maxlength="60" placeholder="例如：我辞职后的第一年"></label>
      <label class="field hidden" id="nWorkBox"><span>所属作品（同一作品的各章/各集共用设定集，可留空）</span><input class="input" id="nWork" list="nWorks" maxlength="40" placeholder="选择已有作品或输入新名字"><datalist id="nWorks">${W.works.map((w) => `<option value="${esc(w.name)}">`).join('')}</datalist></label>` });
    const sync = () => { $('#nWorkBox', d.el).classList.toggle('hidden', !['story', 'work'].includes(kind)); $$('.scene-card', d.el).forEach((c) => c.classList.toggle('on', c.dataset.kind === kind)); };
    d.el.addEventListener('click', (e) => { const c = e.target.closest('[data-kind]'); if (c) { kind = c.dataset.kind; sync(); } });
    d.foot.innerHTML = '<button class="btn" data-close type="button">取消</button><button class="btn primary" id="nGo" type="button">创建</button>';
    $('#nGo', d.foot).onclick = async () => {
      try {
        const r = await api('/api/write/doc/new', { kind, title: $('#nTitle', d.el).value, work: $('#nWork', d.el).value });
        d.close(); await refreshDocs(); await openDoc(r.id); setTab('draft');
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#nTitle', d.el).focus();
  }
  async function removeDoc(id, title) {
    if (!await confirmBox({ title: '删除这篇稿件？', text: `「${title || '未命名'}」的正文、草稿、点评和历史版本都会从本机删除，无法恢复。`, ok: '删除', danger: true })) return;
    try {
      await api(`/api/write/doc/${id}/delete`, {});
      if (W.doc?.id === id) { W.doc = null; W.items = []; }
      await refreshDocs();
      if (!W.doc && W.docs.length) await openDoc(W.docs[0].id); else renderMain();
      toast('已删除', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function exportDoc(id, fmt = 'md') {
    try {
      if (W.doc?.id === id) await flush();
      const { title, text } = await api(`/api/write/doc/${id}/export`);
      let blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      if (fmt === 'docx') {
        const r = await fetch(`/api/write/doc/${id}/export.docx`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '导出 Word 失败。');
        blob = await r.blob();
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (title || '稿件').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) + (fmt === 'docx' ? '.docx' : '.md');
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('已导出，在「下载」文件夹里', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function openDoc(id) {
    await flush();
    try {
      const r = await api('/api/write/doc/' + id);
      W.doc = r.doc; W.items = r.items; W.versions = r.versions; W.usage = r.usage; W.refs = r.refs || []; W.sel = null; W.useBody = null; W.prompt = ''; W.prompt2 = ''; W.favOnly = ''; W.tab = 'draft';
      prefs.set('wdoc', id);
      renderMain(); renderList();
      if (r.running) RT().S.running = true, RT().S.runChat = -id;
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- main ----------
  function renderMain() {
    const main = $('#wmain');
    if (!main) return;
    if (!W.doc) {
      main.innerHTML = `<div class="scroller"><div class="welcome" style="max-width:820px"><div class="hero"><img src="/logo.png?v=6" alt=""><h3>三位顶级 AI，帮你写、改、优化</h3></div>
        <p>Claude、GPT、Gemini 各有所长：同一个要求，三位同时各写一版，并排比较、互相点评，再融合成最好的一稿。<br>选一个场景开始：</p>
        <div class="scene-grid">${Object.entries(W.scenes).map(([k, s]) => `<button type="button" class="scene-card" data-new="${k}">${icon(s.icon)}<b>${esc(s.label)}</b><span>${esc(s.desc)}</span></button>`).join('')}</div></div></div>`;
      main.onclick = (e) => { const c = e.target.closest('[data-new]'); if (c) quickCreate(c.dataset.new); };
      return;
    }
    main.onclick = null;
    const d = W.doc, sc = scene();
    main.innerHTML = `<div class="head">
        <button class="icon-btn only-narrow" type="button" id="wNav" aria-label="菜单">${icon('menu')}</button>
        <button type="button" class="head-ic" id="wIcon" data-tip="点击更换图标">${d.icon ? RT().chatBadge(d.id, 40, d.icon) : `<span class="av kindav k-${d.kind}" style="width:40px;height:40px">${icon(sc.icon)}</span>`}</button>
        <div class="titles"><h2 id="wTitle" title="双击重命名">${esc(d.title)}</h2><div class="sub"><span>${esc(sc.label)}</span>${d.work ? `<span style="color:var(--line-strong)">|</span><span>作品：${esc(d.work)}</span>` : ''}<span id="wWords"></span><span id="wSave" class="savestate"></span></div></div>
        <button class="pill" type="button" id="wUsage" data-tip="本稿累计积分，点击查看用量明细"></button>
        <button class="btn small" type="button" id="wBrief" data-tip="写作要求、人物和世界观设定">${icon('sliders')}设定</button>
        <button class="btn small" type="button" id="wVersions">${icon('refresh')}历史版本</button>
        <button class="icon-btn" type="button" id="wExport" data-tip="导出 Word 或 Markdown">${icon('download')}</button>
        <button class="icon-btn" type="button" id="wMore" aria-label="更多">${icon('more')}</button></div>
      <div class="wgrid">
        <section class="weditor"><div class="wedbar hidden" id="wEdBar"></div><div class="wedit"><div class="whl" id="wHl" aria-hidden="true"></div><textarea id="wBody" spellcheck="false" placeholder="${esc(placeholder())}"></textarea></div></section>
        <aside class="wpanel"><div class="wsplit" id="wSplit" data-tip="左右拖动，调整工作区宽度" data-tip-side="right"></div><div class="wtabs"><div class="seg" id="wTabs">${[['draft', '基础起稿'], ['review', '点评修改']].map(([k, l]) => `<button type="button" data-tab="${k}" class="${W.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          <div class="wrunbar hidden" id="wRunBar"></div><div class="wpanel-body" id="wPanel"></div><div class="listfoot" id="wListFoot"></div><div class="wdock" id="wDock"></div></aside></div>`;
    const ta = $('#wBody');
    ta.value = d.body; W.last = d.body; d.marks = d.marks || [];

    ta.addEventListener('input', () => { W.sel = null; W.doc.marks = shiftMarks(W.last, ta.value, W.doc.marks || []); W.last = ta.value; W.doc.body = ta.value; markDirty(); updateCounts(); renderMarks(); });
    ta.addEventListener('scroll', () => { const hl = $('#wHl'); if (hl) hl.scrollTop = ta.scrollTop; });
    $('#wEdBar').onclick = (e) => { if (e.target.closest('[data-barx]')) { if (W.applying) { W.applyCancel = true; renderMarks(); } else clearMarks(); return; } const bw = e.target.closest('[data-bwho]'); if (bw) { const w = blendWho(); w[bw.dataset.bwho] = !w[bw.dataset.bwho]; if (!MEMBERS.some((m) => w[m])) w[bw.dataset.bwho] = true; renderMarks(); return; } if (e.target.closest('#wBlend')) openBlend(); if (e.target.closest('#wClearMarks')) clearMarks(); };
    ['select', 'mouseup', 'keyup'].forEach((ev) => ta.addEventListener(ev, trackSelection));
    ['keyup', 'mouseup', 'blur'].forEach((ev) => ta.addEventListener(ev, () => { W.caret = ta.selectionStart; }));
    ta.addEventListener('blur', () => flush());
    $('#wTabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); };
    $('#wIcon').onclick = () => changeDocIcon(W.doc.id);
    $('#wTitle').ondblclick = startRename;
    $('#wUsage').onclick = () => RT().openSettings('usage');
    $('#wVersions').onclick = openVersions;
    $('#wBrief').onclick = openBrief;
    $('#wExport').onclick = (e) => menu(e.currentTarget, [{ label: '导出为', icon: null },
      { label: 'Word 文档（.docx）', icon: 'doc', run: () => exportDoc(d.id, 'docx') },
      { label: 'Markdown（.md）', icon: 'download', run: () => exportDoc(d.id, 'md') }], { align: 'right' });
    $('#wMore').onclick = (e) => menu(e.currentTarget, [
      { label: '重命名', icon: 'pencil', run: startRename },
      { label: '保存为一个版本', icon: 'refresh', run: snapshotNow },
      { label: '复制全文', icon: 'copy', run: () => copyText(W.doc.body) },
      '-',
      { label: '删除稿件', icon: 'trash', danger: true, run: () => removeDoc(d.id, d.title) },
    ], { align: 'right' });
    $('#wNav').onclick = () => document.body.classList.toggle('nav-open');
    $('#wPanel').addEventListener('click', onPanelClick);
    $('#wListFoot').addEventListener('click', onPanelClick);
    $('#wDock').addEventListener('click', onDockClick);
    const grid = $('.wgrid'), saved = prefs.get('wpanel', 0);
    if (saved) grid.style.setProperty('--wpanel', saved + 'px');
    $('#wSplit').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const left = $('.wpanel').getBoundingClientRect().left, total = grid.getBoundingClientRect().width;
      const move = (ev) => { const w = Math.round(Math.max(380, Math.min(ev.clientX - left, total * 0.72))); grid.style.setProperty('--wpanel', w + 'px'); W.panelW = w; };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; document.body.classList.remove('resizing'); if (W.panelW) prefs.set('wpanel', W.panelW); };
      document.body.style.cursor = 'col-resize'; document.body.classList.add('resizing');
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    $('#wDock').addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) { e.preventDefault(); addRefFiles(files); return; }
      const text = e.clipboardData?.getData('text') || '';
      if (looksLikeUrl(text)) toast('这是个网址，要把网页内容当作参考资料吗？', '', { label: '添加', run: () => askRefLink(text.trim()) });
    });
    $('#wDock').addEventListener('input', (e) => { if (e.target.id === 'wPrompt') W.prompt = e.target.value; if (e.target.id === 'wPrompt2') W.prompt2 = e.target.value; });
    $('#wDock').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && e.target.matches('textarea')) { e.preventDefault(); onDockClick({ target: $(W.tab === 'draft' ? '[data-do="gen"]' : '[data-do="make"]') || e.target }); } });
    $('#wRunBar').addEventListener('click', (e) => { if (e.target.closest('[data-stop]')) api('/api/stop', {}).catch(() => {}); });
    updateCounts(); setUsage(W.usage); renderPanel(); renderMarks();
  }
  const PLACE = { article: '在这里写正文，或到右侧让三位 AI 各起草一版…', script: '在这里写口播脚本，或让三位 AI 各写一条…', work: '在这里写文档，或让三位 AI 起草…', story: '在这里写正文（一章 / 一集），或让三位 AI 各写一版…' };
  const placeholder = () => PLACE[W.doc.kind];
  async function quickCreate(kind) {
    try { const r = await api('/api/write/doc/new', { kind, title: '' }); await refreshDocs(); await openDoc(r.id); } catch (e) { toast(e.message, 'err'); }
  }
  function updateCounts() { const el = $('#wWords'); if (el) el.textContent = words(W.doc.body) + ' 字'; syncDock(); }
  function setUsage(u) { W.usage = u || W.usage; const p = $('#wUsage'); if (p && W.usage) p.innerHTML = `本稿 <b>${esc(W.usage.chat)}</b> 积分`; }
  function setSaveState(s) { W.state = s; const el = $('#wSave'); if (el) el.textContent = { saved: '已保存', dirty: '未保存…', saving: '保存中…', error: '保存失败' }[s]; }
  function startRename() {
    const h = $('#wTitle'); if (!h) return;
    const input = document.createElement('input');
    input.value = W.doc.title; input.maxLength = 60; h.replaceChildren(input); input.focus(); input.select();
    let done = false;
    const commit = async (save) => {
      if (done) return; done = true;
      const t = input.value.trim();
      if (save && t && t !== W.doc.title) { try { await api(`/api/write/doc/${W.doc.id}/save`, { title: t }); W.doc.title = t; refreshDocs(); } catch (e) { toast(e.message, 'err'); } }
      h.textContent = W.doc.title;
    };
    input.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) commit(true); if (e.key === 'Escape') commit(false); };
    input.onblur = () => commit(true);
  }

  // ---------- marks: pieces recently swapped / inserted by AI, shown as a soft highlight ----------
  function normMarks(list) {
    const sorted = list.filter((m) => m[1] > m[0]).map((m) => [m[0], m[1]]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const m of sorted) { const last = out[out.length - 1]; if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); else out.push(m); }
    return out;
  }
  // Keep marks glued to their text while the user types: find the changed region and shift everything after it.
  function shiftMarks(oldT, newT, marks) {
    if (!marks.length || oldT === newT) return marks;
    let p = 0; const max = Math.min(oldT.length, newT.length);
    while (p < max && oldT[p] === newT[p]) p++;
    let sfx = 0;
    while (sfx < max - p && oldT[oldT.length - 1 - sfx] === newT[newT.length - 1 - sfx]) sfx++;
    const removedEnd = oldT.length - sfx, delta = newT.length - oldT.length, insEnd = newT.length - sfx;
    const out = [];
    for (let [a, b] of marks) {
      if (b <= p) { out.push([a, b]); continue; }
      if (a >= removedEnd) { out.push([a + delta, b + delta]); continue; }
      if (a <= p && b >= removedEnd) { out.push([a, b + delta]); continue; }           // edit inside the mark
      if (a < p) { out.push([a, p]); continue; }                                       // overlaps the start of the edit
      if (b > removedEnd) { out.push([insEnd, b + delta]); continue; }                 // overlaps the end of the edit
    }
    return normMarks(out);
  }
  function renderMarks() {
    const hl = $('#wHl'), ta = $('#wBody');
    if (!hl || !ta || !W.doc) return;
    const text = W.doc.body, n = text.length, marks = W.doc.marks || [];
    const sel = W.sel && W.sel.end <= n && text.slice(W.sel.start, W.sel.end) === W.sel.text ? W.sel : null;   // ignore a stale selection
    const cuts = new Set([0, n]);
    marks.forEach(([a, b]) => { cuts.add(Math.min(a, n)); cuts.add(Math.min(b, n)); });
    if (sel) { cuts.add(sel.start); cuts.add(sel.end); }
    // our own caret (wider, in the accent colour) is drawn in this layer; the textarea's native one is hidden
    const caretAt = document.activeElement === ta && ta.selectionStart === ta.selectionEnd ? Math.min(ta.selectionStart, n) : -1;
    if (caretAt >= 0) cuts.add(caretAt);
    const pts = [...cuts].sort((x, y) => x - y);
    let html = '';
    const CARET = '<span class="wcaret"></span>';
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a === caretAt) html += CARET;
      if (a === b) continue;
      const inMark = marks.some(([x, y]) => a >= x && b <= y), inSel = !!sel && a >= sel.start && b <= sel.end, seg = esc(text.slice(a, b));
      html += inMark || inSel ? `<mark class="${inMark ? 'mk' : ''} ${inSel ? 'sel' : ''}">${seg}</mark>` : seg;
    }
    hl.innerHTML = html + (caretAt === n ? CARET : '') + '\u200b';
    hl.scrollTop = ta.scrollTop;
    const bar = $('#wEdBar');
    if (bar) {
      const n = marks.length;
      const busy = W.applying && !W.applyCancel;
      bar.classList.toggle('hidden', !n && !busy);
      bar.classList.toggle('busy', !!busy);
      if (busy) bar.innerHTML = `<span class="spinner-s"></span><span class="mk-text">${esc(W.applying)}</span><button type="button" class="icon-btn barx" data-barx data-tip="不想弄了，取消">${icon('x')}</button>`;
      else bar.innerHTML = n ? `<span class="mk-dot"></span><span class="mk-text">有 <b>${n}</b> 处刚换进来的片段（浅色标出）</span><span class="mk-who" data-tip="谁来融合（可多选，各出一版供你挑）">${MEMBERS.map((m) => `<button type="button" class="dot-av m-${m} ${blendWho()[m] ? 'on' : ''}" data-bwho="${m}" data-tip="${esc(RT().displayName(m))}">${RT().avatar(m, 24)}</button>`).join('')}</span><button class="btn small primary" id="wBlend" type="button" data-tip="让选中的 AI 通读全文，把这些片段和上下文自然融合（统一语气、理顺衔接，情节不变），结果可对比后再替换，随时可撤销">融入修改</button><button class="btn small" id="wClearMarks" type="button" data-tip="只去掉浅色标记，不改正文">清除标记</button><button type="button" class="icon-btn barx" data-barx data-tip="关闭这一栏（去掉标记，不改正文）">${icon('x')}</button>` : '';
    }
  }
  let markTimer = null;
  function persistMarks() { clearTimeout(markTimer); markTimer = setTimeout(() => { if (W.doc) api(`/api/write/doc/${W.doc.id}/save`, { marks: W.doc.marks || [] }).catch(() => {}); }, 500); }
  function addMark(a, b) { W.doc.marks = normMarks([...(W.doc.marks || []), [a, b]]); persistMarks(); renderMarks(); }
  function clearMarks() { W.doc.marks = []; persistMarks(); renderMarks(); }
  // who blends the marked pieces in: picked right on the bar (one click on "融入修改" starts it)
  const blendWho = () => (W.blendWho = W.blendWho || Object.fromEntries(MEMBERS.map((m, i) => [m, i === Math.max(0, MEMBERS.findIndex((x) => W.pick[x]))])));
  async function openBlend() {
    const marks = W.doc.marks || [];
    if (!marks.length) return;
    const who = MEMBERS.filter((m) => blendWho()[m]);
    await flush(); clearMarks();   // the marks travel with the request; once AI is blending them in, the highlight is done
    runAction('blend', { members: who.length ? who : ['Claude'], marks });
  }

  // ---------- saving ----------
  function markDirty() { setSaveState('dirty'); clearTimeout(W.saveTimer); W.saveTimer = setTimeout(flush, 900); }
  async function flush() {
    clearTimeout(W.saveTimer);
    if (W.state !== 'dirty' || !W.doc) return;
    const doc = W.doc, body = doc.body;
    setSaveState('saving');
    try { await api(`/api/write/doc/${doc.id}/save`, { body, marks: doc.marks || [] }); if (W.doc === doc && doc.body === body) setSaveState('saved'); else if (W.doc === doc) markDirty(); }
    catch (e) { setSaveState('error'); toast('保存失败：' + e.message, 'err'); }
    refreshDocs();
  }
  // Putting text into the editor with execCommand keeps it in the browser's undo history,
  // so Ctrl+Z walks back through typing, adopted drafts, replaced paragraphs and restored versions alike.
  function putInEditor(text) {
    const ta = $('#wBody'); if (!ta) return;
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok || ta.value !== text) { ta.value = text; }
    if (W.last !== text) { W.doc.marks = shiftMarks(W.last, text, W.doc.marks || []); W.last = text; }
    W.doc.body = text; ta.setSelectionRange(0, 0); ta.scrollTop = 0; renderMarks();
  }
  function undoEditor(redo) {
    const ta = $('#wBody'); if (!ta) return false;
    const before = ta.value; ta.focus();
    try { document.execCommand(redo ? 'redo' : 'undo'); } catch (e) { return false; }
    if (ta.value === before) return false;
    W.doc.marks = shiftMarks(W.last, ta.value, W.doc.marks || []); W.last = ta.value; W.doc.body = ta.value; markDirty(); updateCounts(); renderMarks(); return true;
  }
  async function setBody(text, note) {
    const old = W.doc.body;
    if (W.applyCancel) throw Object.assign(new Error('cancelled'), { cancel: true });   // user closed the bar before anything was written
    await api(`/api/write/doc/${W.doc.id}/save`, { body: text, snapshot: note });
    if (W.applyCancel) {   // closed while the save was in flight: put the old text back and leave the editor alone
      await api(`/api/write/doc/${W.doc.id}/save`, { body: old, snapshot: '取消前恢复' }).catch(() => {}); reloadVersions();
      throw Object.assign(new Error('cancelled'), { cancel: true });
    }
    putInEditor(text);
    setSaveState('saved'); updateCounts(); refreshDocs(); reloadVersions();
    toast(note + '。可按 Ctrl+Z 撤销。', 'ok', { label: '撤销', run: async () => {
      if (undoEditor(false)) return;
      await api(`/api/write/doc/${W.doc.id}/save`, { body: old, snapshot: '撤销前' }); putInEditor(old); updateCounts(); reloadVersions();
    } });
  }
  async function reloadVersions() { try { const r = await api('/api/write/doc/' + W.doc.id); W.versions = r.versions; } catch (e) { /* ignore */ } }
  async function snapshotNow() { await flush(); try { await api(`/api/write/doc/${W.doc.id}/snapshot`, { note: '手动保存' }); await reloadVersions(); toast('已保存为一个版本', 'ok'); } catch (e) { toast(e.message, 'err'); } }
  function openVersions() {
    flush().then(reloadVersions).then(() => {
      const row = (v) => {
        const diff = v.size - W.doc.body.length;
        return `<div class="vrow"><div class="vtop"><b>${esc(v.note || '版本')}</b><span class="itime">${new Date(v.created * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></div>
          <div class="vprev">${esc((v.preview || '').replace(/\s+/g, ' ')) || '（空）'}${v.size > 90 ? '…' : ''}</div>
          <div class="vbot"><span class="hint">${v.size} 字符 · 比现在${diff === 0 ? '一样长' : (diff > 0 ? '多 ' : '少 ') + Math.abs(diff)}</span><button class="btn small primary" data-restore="${v.id}" type="button">用这一版替换现在的</button></div></div>`;
      };
      const recent = W.versions.slice(0, 3), older = W.versions.slice(3);
      const d = modal({ title: '历史版本', cls: 'mid', body: W.versions.length
        ? `<p class="hint" style="margin:0 0 10px">最近的 ${recent.length} 个版本。选一个，会直接替换现在的正文；现在的正文也会先自动存成一个版本，随时能换回来，Ctrl+Z 同样可以撤销。</p>${recent.map(row).join('')}
           ${older.length ? `<button class="btn small" id="vMore" type="button" style="margin-top:6px">更早的版本（${older.length}）</button><div id="vOlder" class="hidden">${older.map(row).join('')}</div>` : ''}`
        : '<div class="empty-list">还没有历史版本。采纳 AI 的内容、替换文字、手动保存，或连续编辑超过 10 分钟时，会自动留下一个版本。</div>' });
      d.foot.innerHTML = '<button class="btn" data-close type="button">关闭</button>';
      d.el.addEventListener('click', async (e) => {
        if (e.target.closest('#vMore')) { $('#vOlder', d.el).classList.remove('hidden'); e.target.closest('#vMore').remove(); return; }
        const btn = e.target.closest('[data-restore]'); if (!btn) return;
        try {
          const r = await api(`/api/write/doc/${W.doc.id}/restore`, { version: +btn.dataset.restore });
          putInEditor(r.body); clearMarks(); setSaveState('saved'); updateCounts(); d.close(); reloadVersions(); refreshDocs();
          toast('已换成所选版本。可按 Ctrl+Z 撤销。', 'ok');
        } catch (err) { toast(err.message, 'err'); }
      });
    });
  }
  function trackSelection() {
    const ta = $('#wBody'); if (!ta) return;
    const before = W.sel;
    W.sel = ta.selectionEnd > ta.selectionStart ? { start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) } : W.sel && ta === document.activeElement ? null : W.sel;
    if ((before && before.start) !== (W.sel && W.sel.start) || (before && before.end) !== (W.sel && W.sel.end) || !before !== !W.sel) renderMarks();
    syncDock();
  }
  const selInfo = () => (W.sel ? `${icon('check')}已选中 <b>${words(W.sel.text)}</b> 字：下面写这一段想要的感觉，点「重写本段」` : `${icon('info')}没选中文字：对整篇操作。想只改一段，先在右侧底稿里选中它`);

  // ---------- panel: two modules (基础起稿 / 点评修改) with the input docked at the bottom ----------
  function setTab(t) { W.follow = true; W.tab = t; $$('#wTabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); renderPanel(); }
  function renderRunBar() {
    const bar = $('#wRunBar'); if (!bar) return;
    const run = running();
    bar.classList.toggle('hidden', !run);
    bar.innerHTML = run ? `<span class="spinner-s"></span><span class="rb-text">${esc(runText())}</span><button class="btn small" data-stop type="button">${W.items.filter((i) => i.status === 'running').length > 1 ? '全部停止' : '停止'}</button>` : '';
  }
  const VERB = { draft: '起草', review: '点评', compare: '互评', merge: '融合', polish: '润色', revise: '按点评修改', critique: '点评修改', blend: '融入修改', continue: '续写' };
  const KIND_VERB = { draft: '起草', merge: '融合', review: '点评' };
  const shortName = (m) => RT().displayName(m).split(' ')[0];
  // "Claude、GPT 正在起草…（1/2 已完成）": built from the cards that are still running, so it stays right after a reload too
  function runText() {
    const live = W.items.filter((i) => i.status === 'running');
    const info = W.runInfo || {};
    const names = (live.length ? live.map((i) => i.author) : info.members || []).filter((v, n, a) => a.indexOf(v) === n).map(shortName);
    const first = live[0];
    const verb = info.verb || (first ? (first.kind === 'edit' ? (first.meta.action || '修改') : first.meta.continue ? '续写' : KIND_VERB[first.kind]) : '处理');
    const total = info.total || live.length;
    const done = Math.max(0, total - live.length);
    return `${names.length ? names.join('、') : '正在'} 正在${verb}…` + (total > 1 ? `（${done}/${total} 已完成）` : '');
  }
  const picked = () => MEMBERS.filter((m) => W.pick[m]);
  const tabKinds = () => (W.tab === 'draft' ? ['draft', 'merge'] : ['review', 'edit']);
  const latestBodyReviews = () => {
    const done = W.items.filter((i) => i.kind === 'review' && i.status === 'complete' && i.meta.scope === 'body');
    return done.length ? done.filter((i) => i.round === done[done.length - 1].round) : [];
  };
  const latestDrafts = () => {
    const done = W.items.filter((i) => i.kind === 'draft' && i.status === 'complete');
    return done.length ? done.filter((i) => i.round === done[done.length - 1].round) : [];
  };
  function renderPanel() {
    const box = $('#wPanel'); if (!box || !W.doc) return;
    renderRunBar();
    const all = W.items.filter((i) => tabKinds().includes(i.kind));
    const hearts = all.filter((i) => i.meta.fav).length, stars = all.filter((i) => i.meta.star).length;
    const shown = W.favOnly ? all.filter((i) => i.meta[W.favOnly]) : all;
    const loose = all.filter((i) => !i.meta.fav && !i.meta.star && i.status !== 'running').length;
    const foot = $('#wListFoot');
    if (foot) foot.innerHTML = all.length ? `<button type="button" class="foot-btn ${W.favOnly === 'fav' ? 'on' : ''}" data-favfilter="fav" data-tip="只显示标了爱心的">${icon('heart', W.favOnly === 'fav' ? 'filled' : '')}爱心${hearts ? '（' + hearts + '）' : ''}</button><button type="button" class="foot-btn ${W.favOnly === 'star' ? 'on' : ''}" data-favfilter="star" data-tip="只显示收藏的">${icon('star', W.favOnly === 'star' ? 'filled' : '')}收藏${stars ? '（' + stars + '）' : ''}</button>${loose ? `<button type="button" class="foot-btn" data-clean data-tip="删掉既没标爱心、也没收藏的卡片">清理未标记（${loose}）</button>` : ''}` : '';
    let html = '';
    if (!shown.length) {
      html += `<div class="empty-note">${W.favOnly ? (W.favOnly === 'star' ? '还没有收藏的内容。点卡片右下角的五角星，它会一直留在这里。' : '还没有标爱心的内容。点卡片右下角的心，它会一直留在这里，下次写的时候还能用。')
        : W.tab === 'draft' ? '三位的草稿会出现在这里。喜欢的一版点「设为底稿」放进右边；也想留着以后用的，点卡片右下角的心。' : '点评和修改结果会出现在这里。先在右边写好底稿，再点「点评」或「生成」。'}</div>`;
    } else {
      // one block per batch (everything produced by one click), with a clear gap and a labelled divider between batches
      const batches = [...new Set(shown.map((d) => d.round))];
      html += batches.map((rd, n) => {
        const list = shown.filter((d) => d.round === rd), first = list[0];
        const what = W.tab === 'draft' ? (first.meta.continue ? '续写' : esc((first.meta.prompt || '').slice(0, 20) || '起草'))
          : esc(first.kind === 'edit' ? (first.meta.action || '修改') : first.meta.scope === 'drafts' ? '互评' : '点评');
        return `<div class="batch"><div class="round-sep"><span>${clock(first.created)} · ${what}${n === batches.length - 1 ? ' · 最新' : ''}</span></div>${list.map(itemCard).join('')}</div>`;
      }).join('');
    }
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 140, top = box.scrollTop;
    box.innerHTML = html;
    box.scrollTop = (W.follow || near) ? box.scrollHeight : top;
    W.follow = false;
    syncDock();
  }
  const dotsHTML = () => `<div class="dots">${MEMBERS.map((m) => `<button type="button" class="dot-av m-${m}" data-pick="${m}" data-tip="${esc(RT().displayName(m))}">${RT().avatar(m, 30)}</button>`).join('')}<span class="hint">${W.tab === 'draft' ? '谁来写（可多选）' : '谁来改（可多选）'}</span><button type="button" class="btn small ghost refadd" data-refadd data-tip="加参考资料：文档、图片、网页链接、文字">${icon('clip')}资料</button></div>`;
  function dockHTML() {
    const sc = scene();
    if (W.tab === 'draft') {
      return `<div class="dchips">${sc.chips.map((c) => `<button type="button" class="qchip" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <div class="refs" id="wRefs"></div>
        <textarea class="textarea" id="wPrompt" rows="2" placeholder="这次要写什么？例如：${esc(sc.chips[0])}。可以写主题、角度、字数、语气……也可以点「资料」加文档、图片、链接。">${esc(W.prompt)}</textarea>
        ${dotsHTML()}
        <div class="dbtns"><button class="btn primary" type="button" data-do="gen" data-tip="选中的 AI 各写一版（不参考右边的底稿）">${icon('sparkles')}生成</button>
          <button class="btn" type="button" data-do="regen" data-tip="按同样的要求，整稿重新出一轮">重写</button>
          <button class="btn" type="button" data-do="cont" data-tip="接着右边的底稿往下写，各出一版续写">续写</button>
          <button class="btn" type="button" data-do="compare" data-tip="把最新一轮的几版并排对照着看">并排对比</button></div>
        <div class="hint">每位 AI 各算一次调用，选几位，费用就约是单人的几倍。</div>`;
    }
    return `<div class="dchips">${sc.actions.map((a) => `<button type="button" class="qchip" data-act="${a.key}">${esc(a.label)}</button>`).join('')}</div>
      <div class="selinfo" id="wSelInfo"></div>
      <div class="refs" id="wRefs"></div>
      <textarea class="textarea" id="wPrompt2" rows="2" placeholder="想怎么改？写下你的要求（可以不写，让 AI 自己找问题并修改）">${esc(W.prompt2)}</textarea>
      ${dotsHTML()}
      <div class="dbtns"><button class="btn" type="button" data-do="review" data-tip="只给点评和打分，不改稿">点评</button>
        <button class="btn primary" type="button" data-do="make" data-tip="对整篇点评 + 修改：每位给出「点评与修改说明」和一个新版本">${icon('sparkles')}生成</button>
        <button class="btn" type="button" data-do="rewritesel" data-tip="先在右边底稿里选中一段">重写本段</button>
        <button class="btn" type="button" data-do="compare2" data-tip="把底稿和最新一轮的新版本并排对照着看">并排对比</button></div>
      <div class="hint hidden" id="wRevHint"></div>`;
  }
  function syncDock() {
    const dock = $('#wDock'); if (!dock || !W.doc) return;
    if (dock.dataset.tab !== W.tab) { dock.dataset.tab = W.tab; dock.innerHTML = dockHTML(); }
    const busy = RT().S.running, hasSel = !!(W.sel && W.sel.text);
    $$('[data-pick]', dock).forEach((b) => b.classList.toggle('on', !!W.pick[b.dataset.pick]));
    $$('[data-do]', dock).forEach((b) => {
      const k = b.dataset.do; let off = busy;
      if (k === 'rewritesel' && !hasSel) off = true;
      if (k === 'compare' && latestDrafts().length < 2) off = true;
      if (k === 'compare2' && !W.items.some((i) => i.meta && i.meta.combo && i.status === 'complete')) off = true;
      if (k === 'cont' && !W.doc.body.trim()) off = true;
      b.disabled = off;
    });
    $$('[data-act]', dock).forEach((b) => { b.disabled = busy; });
    const rg = $('[data-do="rewritesel"]', dock), mk = $('[data-do="make"]', dock);
    if (rg) { rg.dataset.tip = hasSel ? `只重写选中的 ${words(W.sel.text)} 字，按文本框里写的感觉` : '先在右边底稿里选中一段'; rg.classList.toggle('primary', hasSel); }
    if (mk) { mk.dataset.tip = hasSel ? '对整篇点评 + 修改（不受选中影响）' : '对整篇点评 + 修改：每位给出「点评与修改说明」和一个新版本'; mk.classList.toggle('primary', !hasSel); }
    const p2 = $('#wPrompt2', dock);
    if (p2) p2.placeholder = hasSel ? '这一段想改成什么感觉？例如：更紧张、更口语、少一点解释、多一点动作……' : '想怎么改整篇？写下你的要求或感觉（可以不写，让 AI 自己找问题并修改）';
    const rf = $('#wRefs', dock); if (rf) { rf.innerHTML = refsHTML(); rf.classList.toggle('hidden', !W.refs.length); }
    const si = $('#wSelInfo', dock); if (si) si.innerHTML = selInfo();
    const rh = $('#wRevHint', dock);
    if (rh) { const n = latestBodyReviews().length; rh.textContent = n ? `已有 ${n} 条点评，点「生成」时会一并采纳（不想用，就把它们删掉）。` : ''; rh.classList.toggle('hidden', !n); }
  }
  // ---------- reference materials ----------
  const REF_ICON = { image: 'image', link: 'link', text: 'doc', file: 'doc' };
  const refsHTML = () => W.refs.map((r) => `<span class="refchip ${r.kind}" data-ref="${r.id}" data-tip="${esc(r.kind === 'image' ? '图片：' + r.name : r.name + ' · ' + r.chars + ' 字，点开查看')}">${r.kind === 'image' && r.url ? `<img src="${esc(r.url)}" alt="">` : icon(REF_ICON[r.kind] || 'doc')}<span class="rn">${esc(r.name)}</span><button type="button" class="rx" data-refdel="${r.id}" aria-label="移除">${icon('x')}</button></span>`).join('');
  const addRef = (r) => { W.refs.push(r); syncDock(); };
  async function addRefFiles(files) {
    if (!W.doc) { toast('请先打开一篇稿件。'); return; }
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) { toast(`「${file.name}」太大了（超过 25 MB）。`, 'err'); continue; }
      const name = file.name && file.name !== 'image.png' ? file.name : '截图-' + new Date().toTimeString().slice(0, 8).replace(/:/g, '') + '.png';
      toast('正在读取「' + name + '」…');
      try { addRef(await api(`/api/write/doc/${W.doc.id}/ref/file?name=` + encodeURIComponent(name), file)); toast('已加入参考资料：' + name, 'ok'); } catch (e) { toast(e.message, 'err'); }
    }
  }
  function askRefLink(preset = '') {
    const d = modal({ title: '添加网页链接', body: `<p class="hint" style="margin:0 0 8px">程序会读取网页正文作为参考资料（只读公开网页；需要登录的页面请复制文字后用「粘贴文字资料」）。</p><input class="input" id="refUrl" placeholder="https://…" value="${esc(preset)}">` });
    d.foot.innerHTML = '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" data-ok>读取并添加</button>';
    const go = $('[data-ok]', d.foot), input = $('#refUrl', d.el);
    const run = async () => {
      if (!input.value.trim()) return;
      go.disabled = true; go.textContent = '读取中…';
      try { addRef(await api(`/api/write/doc/${W.doc.id}/ref/link`, { url: input.value.trim() })); toast('已加入参考资料', 'ok'); d.close(); } catch (e) { toast(e.message, 'err'); go.disabled = false; go.textContent = '读取并添加'; }
    };
    go.onclick = run; input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) run(); }); input.focus();
  }
  function askRefText() {
    const d = modal({ title: '粘贴文字资料', body: `<input class="input" id="refName" maxlength="60" placeholder="给它起个名字（可不填），例如：采访记录" style="margin-bottom:8px"><textarea class="textarea" id="refBody" rows="10" placeholder="把相关的文字粘贴到这里：背景、素材、人设、对标文章……"></textarea>` });
    d.foot.innerHTML = '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" data-ok>添加</button>';
    $('[data-ok]', d.foot).onclick = async () => {
      try { addRef(await api(`/api/write/doc/${W.doc.id}/ref/text`, { name: $('#refName', d.el).value, text: $('#refBody', d.el).value })); d.close(); } catch (e) { toast(e.message, 'err'); }
    };
    $('#refBody', d.el).focus();
  }
  function pickRefFile() {
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
    input.accept = '.txt,.md,.markdown,.csv,.json,.srt,.html,.htm,.docx,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp';
    input.onchange = () => addRefFiles([...input.files]); input.click();
  }
  async function showRef(id) {
    const ref = W.refs.find((r) => r.id === id); if (!ref) return;
    if (ref.kind === 'image') { modal({ title: ref.name, cls: 'wide2', body: `<img src="${esc(ref.url)}" alt="" style="max-width:100%;max-height:70vh;display:block;margin:auto;border-radius:10px">` }); return; }
    try {
      const r = await api('/api/write/ref/' + id);
      const d = modal({ title: r.name, cls: 'wide2', body: `${r.source ? `<div class="hint" style="margin-bottom:6px">${esc(r.source)}</div>` : ''}<pre class="refview">${esc(r.text)}</pre>${r.chars > r.text.length ? `<div class="hint">只显示前 ${r.text.length} 字，共 ${r.chars} 字。</div>` : ''}` });
      d.foot.innerHTML = '<button class="btn" type="button" data-close>关闭</button>';
    } catch (e) { toast(e.message, 'err'); }
  }
  async function removeRef(id) {
    try { await api(`/api/write/ref/${id}/delete`, {}); W.refs = W.refs.filter((r) => r.id !== id); syncDock(); } catch (e) { toast(e.message, 'err'); }
  }
  const looksLikeUrl = (t) => /^https?:\/\/\S+$/i.test((t || '').trim());
  // 转分镜提示词: choose a look and a frame shape first (remembered), then each picked AI writes a full prompt pack
  const VIDEO_STYLES = ['真人写实电影感', '古装真人', '国漫 2D 动画', '日系动漫', '3D 动画（皮克斯风）', '韩系条漫', '水墨国风', '赛博朋克', '暗黑悬疑写实', '温暖治愈插画'];
  const VIDEO_RATIOS = ['竖屏 9:16', '横屏 16:9', '方形 1:1'];
  const VIDEO_EN = '另外，每个中文代码块后面紧接着给一个 ```English 代码块，内容与中文一一对应。';
  // templates: ours ("默认模板") + up to 3 of the user's own (uploaded or pasted); one of them is the default
  async function loadTemplates() { return api('/api/write/vtemplates'); }
  async function saveTemplates(T) { return api('/api/write/vtemplates', { items: T.items, default: T.default }); }
  function editTemplate(T, tpl, done) {
    const isNew = !tpl;
    const d = modal({ title: isNew ? '新建模板' : '编辑模板', cls: 'wide2', body: `<p class="hint" style="margin:0 0 10px">把你常用的分镜提示词格式贴进来，或上传 txt / md / Word / PDF 文件。可以是一段要求，也可以是一个写好的示例镜头，AI 会照着它的结构和写法来出，内容换成你的剧情。</p>
      <input class="input" id="tplName" maxlength="30" placeholder="模板名称，例如：即梦竖屏短剧" value="${esc(tpl ? tpl.name : '')}" style="margin-bottom:8px">
      <textarea class="textarea" id="tplText" rows="14" placeholder="例如：\n镜头 1｜5 秒｜近景\n主体：……\n场景：……\n动作：……\n镜头语言：……\n台词：……">${esc(tpl ? tpl.text : '')}</textarea>
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px"><button class="btn small" type="button" id="tplUpload">${icon('clip')}上传模板文件</button><span class="hint" id="tplInfo"></span></div>` });
    d.foot.innerHTML = '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="tplSave">保存</button>';
    $('#tplUpload', d.el).onclick = () => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.txt,.md,.markdown,.docx,.pdf,.html,.htm';
      input.onchange = async () => {
        const f = input.files[0]; if (!f) return;
        try {
          const r = await api('/api/write/vtemplates/parse?name=' + encodeURIComponent(f.name), f);
          $('#tplText', d.el).value = r.text; if (!$('#tplName', d.el).value.trim()) $('#tplName', d.el).value = r.name;
          $('#tplInfo', d.el).textContent = `已读入 ${r.text.length} 字` + (r.cut ? '（太长，只保留了前 8000 字）' : '');
        } catch (e) { toast(e.message, 'err'); }
      };
      input.click();
    };
    $('#tplSave', d.foot).onclick = async () => {
      const name = $('#tplName', d.el).value.trim(), text = $('#tplText', d.el).value.trim();
      if (!text) { toast('模板内容不能为空。'); return; }
      const items = T.items.map((t) => (tpl && t.id === tpl.id ? { ...t, name, text } : t));
      if (isNew) items.push({ id: '', name, text });
      try { const next = await saveTemplates({ items, default: T.default }); d.close(); done(next, isNew ? next.items[next.items.length - 1].id : tpl.id); toast('模板已保存', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
  }
  async function pickVideoStyle(go) {
    const saved = prefs.get('vstyle', { style: VIDEO_STYLES[0], ratio: VIDEO_RATIOS[0], custom: '', en: false });
    let style = saved.style, ratio = saved.ratio, T;
    try { T = await loadTemplates(); } catch (e) { toast(e.message, 'err'); return; }
    let chosen = T.default;
    const d = modal({ title: '转分镜提示词', cls: 'mid', body: `<p class="hint" style="margin:0 0 10px">会生成：人物资产和场景资产提示词（先出角色和场景参考图），以及每个镜头一段完整的视频提示词（风格、人物、场景、动作、运镜、台词、音效写在一起），每段一键复制，直接拿去 LibTV、即梦等工具出片。选中一段就只转那一段。</p>
      <div class="plabel">模板</div><div class="tpl-list" id="tplList"></div>
      <div class="plabel" style="margin-top:12px">画风</div><div class="vs-grid" id="vsStyle">${VIDEO_STYLES.map((s) => `<button type="button" class="chip ${s === style ? 'on' : ''}" data-vs="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <input class="input" id="vsCustom" maxlength="120" placeholder="或者自己描述画风，例如：90 年代港片质感、胶片颗粒、霓虹夜景" value="${esc(saved.custom || '')}" style="margin:8px 0 12px">
      <div class="plabel">画幅</div><div class="vs-grid" id="vsRatio">${VIDEO_RATIOS.map((r) => `<button type="button" class="chip ${r === ratio ? 'on' : ''}" data-vr="${esc(r)}">${esc(r)}</button>`).join('')}</div>
      <label class="vs-en"><input type="checkbox" id="vsEn" ${saved.en ? 'checked' : ''}> 同时输出英文提示词（默认只出中文）</label>` });
    d.foot.innerHTML = '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="vsGo">开始生成</button>';
    const list = $('#tplList', d.body);
    const paint = () => {
      const all = [T.builtin, ...T.items];
      if (!all.some((t) => t.id === chosen)) chosen = T.default;
      list.innerHTML = all.map((t) => `<div class="tpl-row ${t.id === chosen ? 'on' : ''}" data-tpl="${esc(t.id)}">
          <span class="tpl-dot"></span><span class="tpl-name">${esc(t.name)}</span>${t.id === T.default ? '<span class="tag">默认</span>' : ''}
          <span class="tpl-acts">${t.id !== T.default ? `<button type="button" class="act" data-tdef="${esc(t.id)}">设为默认</button>` : ''}
          <button type="button" class="act" data-tview="${esc(t.id)}">${t.id === 'builtin' ? '查看' : '编辑'}</button>
          ${t.id !== 'builtin' ? `<button type="button" class="act" data-tdel="${esc(t.id)}">删除</button>` : ''}</span></div>`).join('')
        + (T.items.length < T.max ? `<button type="button" class="btn small" id="tplAdd">${icon('plus')}新建模板（上传或粘贴，最多 ${T.max} 个）</button>` : `<div class="hint">已有 ${T.max} 个自己的模板，想加新的请先删掉一个。</div>`);
    };
    paint();
    d.body.addEventListener('click', async (e) => {
      const s = e.target.closest('[data-vs]'), r = e.target.closest('[data-vr]');
      if (s) { style = s.dataset.vs; $$('[data-vs]', d.body).forEach((b) => b.classList.toggle('on', b === s)); return; }
      if (r) { ratio = r.dataset.vr; $$('[data-vr]', d.body).forEach((b) => b.classList.toggle('on', b === r)); return; }
      const def = e.target.closest('[data-tdef]'), view = e.target.closest('[data-tview]'), del = e.target.closest('[data-tdel]');
      try {
        if (def) { T = await saveTemplates({ items: T.items, default: def.dataset.tdef }); chosen = T.default; paint(); toast('已设为默认模板', 'ok'); return; }
        if (del) {
          const t = T.items.find((x) => x.id === del.dataset.tdel);
          if (!await confirmBox({ title: '删除模板？', text: `「${t.name}」会被删除，不能恢复。`, ok: '删除', danger: true })) return;
          T = await saveTemplates({ items: T.items.filter((x) => x.id !== t.id), default: T.default === t.id ? 'builtin' : T.default }); paint(); return;
        }
        if (view) {
          if (view.dataset.tview === 'builtin') { const v = modal({ title: '默认模板（内置）', cls: 'wide2', body: `<pre class="refview">${esc(T.builtin.text)}</pre>` }); v.foot.innerHTML = '<button class="btn" type="button" data-close>关闭</button>'; return; }
          editTemplate(T, T.items.find((x) => x.id === view.dataset.tview), (next, id) => { T = next; chosen = id; paint(); });
          return;
        }
      } catch (err) { toast(err.message, 'err'); return; }
      if (e.target.closest('#tplAdd')) { editTemplate(T, null, (next, id) => { T = next; chosen = id; paint(); }); return; }
      const row = e.target.closest('[data-tpl]');
      if (row) { chosen = row.dataset.tpl; paint(); }
    });
    $('#vsGo', d.foot).onclick = () => {
      const custom = $('#vsCustom', d.body).value.trim();
      const en = $('#vsEn', d.body).checked;
      prefs.set('vstyle', { style, ratio, custom, en });
      const tpl = T.items.find((t) => t.id === chosen);
      d.close();
      go(`画风：${custom || style}；画幅：${ratio}。所有提示词都按这个画风和画幅来写。` + (en ? VIDEO_EN : '只输出中文，不要英文。'), tpl ? tpl.text : '');
    };
  }
  // 点评修改 works on the manuscript on the right. People often paste their draft into the box below instead: offer to move it.
  async function ensureBody() {
    if (W.doc.body.trim()) return true;
    const text = (W.prompt2 || '').trim();
    if (text.length >= 120 || text.split('\n').filter((l) => l.trim()).length >= 4) {
      const ok = await confirmBox({ title: '把这段放进底稿？', ok: '放进底稿并继续',
        text: `右边的底稿还是空的。「点评修改」针对的是右边的正文。要把输入框里这段 ${words(text)} 字的文字放进底稿，再继续吗？` });
      if (!ok) return false;
      await setBody(text, '把输入框里的稿子放进底稿');
      W.prompt2 = ''; const p2 = $('#wPrompt2'); if (p2) p2.value = '';
      return true;
    }
    toast('右边的底稿还是空的。请先把你的稿子粘贴到右边的正文区，再点「点评」或「生成」；下面的输入框是写修改要求的。');
    return false;
  }
  const pickedCount = () => MEMBERS.filter((m) => W.pick[m]).length;
  const currentSel = () => (W.sel && W.sel.text ? { start: W.sel.start, end: W.sel.end, text: W.sel.text } : null);
  async function onDockClick(e) {
    const t = e.target;
    const del = t.closest('[data-refdel]');
    if (del) { removeRef(+del.dataset.refdel); return; }
    const rchip = t.closest('[data-ref]');
    if (rchip) { showRef(+rchip.dataset.ref); return; }
    const add = t.closest('[data-refadd]');
    if (add) {
      menu(add, [{ label: '添加参考资料', icon: null },
        { label: '上传文档或图片', icon: 'clip', run: pickRefFile },
        { label: '添加网页链接', icon: 'link', run: () => askRefLink() },
        { label: '粘贴文字资料', icon: 'doc', run: askRefText }], { up: true });
      return;
    }
    const pick = t.closest('[data-pick]');
    if (pick) {
      const who = pick.dataset.pick;
      W.pick[who] = !W.pick[who]; if (!pickedCount()) W.pick[who] = true;
      // turning a member off while it is still writing stops its running cards too
      if (!W.pick[who]) W.items.filter((i) => i.status === 'running' && i.author === who).forEach((i) => api(`/api/write/item/${i.id}/stop`, {}).catch(() => {}));
      syncDock(); return;
    }
    const chip = t.closest('[data-chip]');
    if (chip) { W.prompt = chip.dataset.chip; const ta = $('#wPrompt'); if (ta) { ta.value = W.prompt; ta.focus(); } return; }
    const act = t.closest('[data-act]');
    if (act) {
      if (!(await ensureBody())) return;
      if (act.dataset.act === 'storyboard') { pickVideoStyle((style, template) => runAction('polish', { option: 'storyboard', prompt: style, template, selection: currentSel() })); return; }
      runAction('polish', { option: act.dataset.act, prompt: '', selection: currentSel() }); return;
    }
    const btn = t.closest('[data-do]');
    if (!btn || btn.disabled) return;
    switch (btn.dataset.do) {
      case 'gen': runAction('draft', { prompt: W.prompt }); break;
      case 'regen': {
        const last = W.items.filter((i) => i.kind === 'draft').slice(-1)[0];
        const prompt = W.prompt.trim() || (last && !last.meta.continue && last.meta.prompt) || '';
        if (last && last.meta.continue) { runAction('draft', { prompt: W.prompt, option: 'continue' }); break; }
        if (!prompt) { toast('先在下面写下这次要写什么。'); $('#wPrompt')?.focus(); break; }
        runAction('draft', { prompt });
        break;
      }
      case 'cont': runAction('draft', { prompt: W.prompt, option: 'continue' }); break;
      case 'compare': openCompare(); break;
      case 'review': if (await ensureBody()) runAction('review'); break;
      case 'make': if (await ensureBody()) runAction('critique', { prompt: W.prompt2, selection: null, review_ids: latestBodyReviews().map((x) => x.id) }); break;
      case 'rewritesel': runAction('polish', { option: 'rewrite', prompt: W.prompt2, selection: currentSel() }); break;
      case 'compare2': openCompare2(); break;
    }
  }
  function briefHTML() {
    const d = W.doc, sc = scene();
    return `${d.kind === 'story' || d.kind === 'work' ? `<label class="field"><span>所属作品（各章 / 各集共用下面的「作品设定」）</span><input class="input" id="bWork" list="bWorks" value="${esc(d.work)}" placeholder="留空表示单篇"><datalist id="bWorks">${W.works.filter((w) => w.kind === d.kind).map((w) => `<option value="${esc(w.name)}">`).join('')}</datalist></label>` : ''}
      ${d.work ? `<label class="field"><span>作品设定集（世界观、人物小传、主线、前情摘要……所有章节共用）</span><textarea class="textarea" id="bWorkBrief" rows="9" placeholder="${esc(sc.brief_hint)}">${esc(d.work_brief)}</textarea></label>` : ''}
      <label class="field"><span>${d.work ? '本篇要求（这一章 / 这一集要写什么）' : '写作要求与背景'}</span><textarea class="textarea" id="bBrief" rows="${d.work ? 5 : 9}" placeholder="${esc(sc.brief_hint)}">${esc(d.brief)}</textarea></label>
      <p class="hint">这里的内容会交给三位 AI 参考：起草、点评、修改时都会带上。设定越具体，三位写得越贴合。${d.kind === 'story' ? '<br>写完一章后，选中底稿用「前情摘要」，再追加到作品设定里，长篇才不会前后矛盾。' : ''}</p>`;
  }
  function openBrief() {
    const d = modal({ title: '设定与要求', cls: 'mid', body: briefHTML() });
    d.foot.innerHTML = '<button class="btn primary" data-close type="button">完成</button>';
    const save = (field, id) => { const el = $(id, d.el); if (!el) return; let t; el.oninput = () => { clearTimeout(t); t = setTimeout(async () => { try { await api(`/api/write/doc/${W.doc.id}/save`, { [field]: el.value }); W.doc[field] = el.value; } catch (e) { toast(e.message, 'err'); } }, 600); }; };
    save('brief', '#bBrief'); save('work_brief', '#bWorkBrief');
    const w = $('#bWork', d.el);
    if (w) w.onchange = async () => { try { await api(`/api/write/doc/${W.doc.id}/save`, { work: w.value }); d.close(); await openDoc(W.doc.id); refreshDocs(); openBrief(); } catch (e) { toast(e.message, 'err'); } };
  }

  // ---------- items ----------
  function diffHTML(a, b) {
    if (!a || a.length * b.length > 4e6) return md.render(b);
    const A = [...a], B = [...b], n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0, out = '', mode = '';
    const put = (kind, ch) => { if (kind !== mode) { out += mode ? '</span>' : ''; out += kind ? `<span class="d-${kind}">` : ''; mode = kind; } out += esc(ch).replace(/\n/g, '<br>'); };
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { put('', A[i]); i++; j++; }
      else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { put('add', B[j]); j++; }
      else { put('del', A[i]); i++; }
    }
    if (mode) out += '</span>';
    return `<div class="diff">${out}</div>`;
  }
  function itemCard(it) {
    const done = it.status === 'complete', run = it.status === 'running';
    const combo = !!it.meta.combo && done;
    const label = it.kind === 'edit' ? (it.meta.action || '修改建议') : it.meta.continue ? '续写' : KIND[it.kind];
    const text = it.content || '';
    const fav = !!it.meta.fav, star = !!it.meta.star;
    let bodyHTML;
    if (run && !text) bodyHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    else if (it.kind === 'edit' && done && it.meta.mode === 'replace' && (it.meta.selection || it.meta.original)) bodyHTML = diffHTML(it.meta.selection || it.meta.original, text);
    else bodyHTML = `<div class="md">${md.render(text)}</div>`;
    const long = text.length > 900 && !run;
    const act = [];
    if (done) {
      if (['draft', 'merge'].includes(it.kind)) {
        if (it.meta.truncated) act.push(`<button class="act primary" data-continue type="button">接着写</button>`);
        if (it.meta.continue) act.push(`<button class="act primary" data-apply="append" type="button">接到底稿后面</button>`, `<button class="act" data-apply="replace" type="button">设为底稿</button>`);
        else act.push(`<button class="act primary" data-apply="replace" type="button">设为底稿</button>`);
      } else if (it.kind === 'edit' && it.meta.source) {
        act.push(`<button class="act primary" data-apply="insert" type="button">${insertLabel()}</button>`);
        if (it.meta.start >= 0 && W.items.some((x) => x.id === it.meta.source)) act.push(`<button class="act" data-apply="swapsrc" type="button">替换草稿里的原段</button>`);
      } else if (it.kind === 'edit') {
        const m = it.meta.mode;
        if (it.meta.truncated && m === 'copy') act.push(`<button class="act primary" data-continue type="button">接着写</button>`);
        act.push(`<button class="act primary" data-apply="${m === 'replace' ? 'swap' : m === 'append' ? 'append' : m === 'brief' ? 'brief' : 'copy'}" type="button">${{ replace: it.meta.whole ? '设为底稿' : '融入底稿', append: '追加到底稿', brief: '追加到作品设定', copy: '复制' }[m] || '复制'}</button>`);
      }
      if (it.kind === 'review' && it.meta.scope === 'body') act.push(`<button class="act primary" data-blendreview type="button" data-tip="让下方「谁来改」里选中的 AI 按这条点评各改出一个新版本（选中了一段就只改那一段）。改好后在新卡片上查看，满意再点「设为底稿 / 融入底稿」，不满意可以「重新生成」">按点评修改</button>`);
      if (!(it.kind === 'edit' && it.meta.mode === 'copy' && !it.meta.source)) act.push(`<button class="act" data-copy type="button">复制</button>`);
    }
    if (run) act.push(`<button class="act stop" data-stopitem type="button">${icon('stop')}停止这一个</button>`);
    else {
      act.push(`<button class="act" data-del type="button">删除</button>`);
      if (it.meta.redo && ['complete', 'cancelled', 'error'].includes(it.status)) act.push(`<button class="act" data-redo type="button" data-tip="按同样的要求（同一位 AI、同一段）再写一次；原来这张保留，不满意可以删掉">${icon('refresh')}重新生成</button>`);
    }
    if (done) act.push(`<button class="act star ${star ? 'on' : ''}" data-star type="button" data-tip="${star ? '取消收藏' : '收藏：会一直留着，不会被清理'}" aria-label="收藏">${icon('star', star ? 'filled' : '')}</button>`);
    if (done) act.push(`<button class="act heart ${fav ? 'on' : ''}" data-fav type="button" data-tip="${fav ? '取消爱心' : '标上爱心：会一直留着，下次还能用'}" aria-label="爱心">${icon('heart', fav ? 'filled' : '')}</button>`);
    const noteBlock = combo && it.note ? `<div class="cnote"><div class="cnote-h">点评与修改说明</div><div class="md">${md.render(it.note)}</div></div><div class="cnote-h">新版本<span>（红绿是和底稿相比的改动）</span></div>` : '';
    return `<div class="icard m-${it.author} ${fav ? 'faved' : star ? 'starred' : ''}" data-item="${it.id}"><div class="ihead">${RT().avatar(it.author, 26)}<b>${esc(RT().displayName(it.author))}</b><span class="tag">${esc(label)}</span>
      ${RT().isBackup(it.route) ? '<span class="tag route">备用线路</span>' : ''}${it.status === 'cancelled' ? '<span class="tag stopped">已停止</span>' : ''}${it.status === 'error' ? '<span class="tag failed">未完成</span>' : ''}${fav ? `<span class="favmark">${icon('heart', 'filled')}</span>` : ''}
      <span class="itime">${run ? '正在写…' : clock(it.created)}${done && text ? ' · ' + words(text) + ' 字' : ''}</span></div>
      ${noteBlock}<div class="ibody ${long ? 'clamp' : ''}" data-ibody>${bodyHTML}</div>${long ? '<button class="more-btn" data-expand type="button">展开全文</button>' : ''}
      ${it.note && !run && !combo ? `<div class="notice ${it.status === 'complete' ? 'soft' : ''}">${icon(it.status === 'complete' ? 'info' : 'alert')}<span>${esc(it.note)}</span></div>` : ''}
      <div class="iacts">${act.join('')}</div></div>`;
  }
  async function onPanelClick(e) {
    const t = e.target;
    const cc = t.closest('[data-copy-code]');
    if (cc) { copyText(cc.closest('.code').querySelector('code').textContent); toast('已复制', 'ok'); return; }
    const ff = t.closest('[data-favfilter]');
    if (ff) { W.favOnly = W.favOnly === ff.dataset.favfilter ? '' : ff.dataset.favfilter; renderPanel(); return; }
    if (t.closest('[data-clean]')) {
      const kinds = tabKinds(), n = W.items.filter((i) => kinds.includes(i.kind) && !i.meta.fav && !i.meta.star && i.status !== 'running').length;
      if (!await confirmBox({ title: '清理没标记的内容？', text: `这一页里 ${n} 张没标爱心、也没收藏的卡片会被删除，标了爱心或收藏的会保留。底稿和历史版本不受影响。`, ok: '清理', danger: true })) return;
      try { await api(`/api/write/doc/${W.doc.id}/clean`, { kinds }); W.items = W.items.filter((i) => !kinds.includes(i.kind) || i.meta.fav || i.meta.star || i.status === 'running'); renderPanel(); toast('已清理', 'ok'); } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const card = t.closest('[data-item]');
    if (!card) return;
    const it = W.items.find((x) => x.id === +card.dataset.item);
    if (!it) return;
    if (t.closest('[data-expand]')) { card.querySelector('[data-ibody]').classList.remove('clamp'); t.closest('[data-expand]').remove(); return; }
    if (t.closest('[data-redo]')) {
      if (busyElsewhere() || running()) { toast('正在生成中，请等这一轮结束或先停止。'); return; }
      try {
        await flush(); await api(`/api/write/item/${it.id}/redo`, {});
        const verb = it.kind === 'edit' ? (it.meta.action || '重新生成') : VERB[it.meta.redo.action] || '重新生成';
        W.runInfo = { verb, members: [it.author], total: 1 };
        RT().S.running = true; RT().S.runChat = -W.doc.id; W.follow = true; renderPanel();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (t.closest('[data-stopitem]')) { try { await api(`/api/write/item/${it.id}/stop`, {}); } catch (err) { toast(err.message, 'err'); } return; }
    if (t.closest('[data-copy]')) { copyText(it.content); toast('已复制', 'ok'); return; }
    if (t.closest('[data-star]')) {
      const value = !it.meta.star;
      try { await api(`/api/write/item/${it.id}/favorite`, { value, kind: 'star' }); it.meta.star = value; renderPanel(); toast(value ? '已收藏，它会一直留在「收藏」里' : '已取消收藏', 'ok'); } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (t.closest('[data-fav]')) {
      const value = !it.meta.fav;
      try { await api(`/api/write/item/${it.id}/favorite`, { value }); it.meta.fav = value; renderPanel(); toast(value ? '已标上爱心，它会一直留在「只看爱心」里' : '已取消爱心', 'ok'); } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (t.closest('[data-del]')) { try { await api(`/api/write/item/${it.id}/delete`, {}); W.items = W.items.filter((x) => x.id !== it.id); renderPanel(); } catch (err) { toast(err.message, 'err'); } return; }
    if (t.closest('[data-continue]')) { runAction('continue', { members: [it.author], source_item: it.id }); return; }
    if (t.closest('[data-blendreview]')) {
      // the members picked below rewrite the manuscript by this review; each result is a new card to check, redo or put in like any other
      if (busyElsewhere() || running()) { toast('正在生成中，请等这一轮结束或先停止。'); return; }
      runAction('revise', { review_ids: [it.id], prompt: W.prompt2 || '', selection: currentSel() });
      return;
    }
    const apply = t.closest('[data-apply]');
    if (apply) applyItem(it, apply.dataset.apply);
  }

  const insertLabel = () => (W.sel && W.sel.text ? '替换底稿里选中的段落' : W.caret ? '加入底稿（光标处）' : '加入底稿（末尾）');
  async function insertIntoBody(text, note) {
    await flush();
    const body = W.doc.body, ta = $('#wBody');
    let start, end;
    if (W.sel && W.sel.text && body.slice(W.sel.start, W.sel.end) === W.sel.text) { start = W.sel.start; end = W.sel.end; }
    else { start = end = Math.min(W.caret == null ? body.length : W.caret, body.length); }
    // keep a blank line between the inserted passage and its neighbours
    const padBefore = start === 0 ? '' : body.slice(Math.max(0, start - 2), start) === '\n\n' || body.slice(0, start) === '\n' ? '' : body[start - 1] === '\n' ? '\n' : '\n\n';
    const padAfter = end >= body.length ? '' : body.slice(end, end + 2) === '\n\n' ? '' : body[end] === '\n' ? '\n' : '\n\n';
    const piece = padBefore + text.trim() + padAfter;
    await setBody(body.slice(0, start) + piece + body.slice(end), note);
    if (ta) {
      const a = start + padBefore.length, b = a + text.trim().length;
      ta.setSelectionRange(a, b); W.caret = b; W.sel = null; addMark(a, b);
      ta.scrollTop = Math.max(0, (a / Math.max(1, ta.value.length)) * ta.scrollHeight - ta.clientHeight / 3);
    }
  }
  // Putting a version into the editor can take a few seconds on a long piece: say so, block double clicks, then clear.
  const APPLYING = { replace: '正在设为底稿…', swap: '正在设为底稿…', append: '正在加入底稿…', insert: '正在加入底稿…' };
  async function applyItem(it, how) {
    if (W.applying) return;
    W.applyCancel = false;
    const label = how === 'swap' && !(it.meta && it.meta.whole) ? '正在准备融入底稿…' : APPLYING[how];
    if (label) { W.applying = label; $('#wPanel')?.classList.add('applying'); renderMarks(); await new Promise((r) => setTimeout(r, 40)); }
    try { await applyCore(it, how); }
    finally { W.applyCancel = false; if (label) { W.applying = ''; $('#wPanel')?.classList.remove('applying'); renderMarks(); } }
  }
  async function applyCore(it, how) {
    await flush();
    const body = W.doc.body;
    const who = RT().displayName(it.author).split(' ')[0];
    try {
      if (how === 'copy') { copyText(it.content); toast('已复制', 'ok'); return; }
      if (how === 'insert') { await insertIntoBody(it.content, `已加入底稿（${who}）`); return; }
      if (how === 'swapsrc') {
        const src = W.items.find((x) => x.id === it.meta.source); if (!src) { toast('找不到原来的草稿了。', 'err'); return; }
        let a = it.meta.start, b = it.meta.end;
        if (src.content.slice(a, b) !== it.meta.selection) { a = src.content.indexOf(it.meta.selection); b = a + it.meta.selection.length; }
        if (a < 0) { toast('原草稿里的这段已经变了，找不到要替换的位置。', 'err'); return; }
        const next = src.content.slice(0, a) + it.content + src.content.slice(b);
        await api(`/api/write/item/${src.id}/content`, { content: next }); src.content = next; setTab('draft'); toast('已替换草稿里的这一段。', 'ok'); return;
      }
      if (how === 'replace') { await setBody(it.content, `已把 ${who} 的${KIND[it.kind]}设为底稿`); clearMarks(); return; }
      if (how === 'append') { await setBody(body + (body && !body.endsWith('\n') ? '\n\n' : '') + it.content, `已把 ${who} 的内容接到底稿后面`); return; }
      if (how === 'brief') {
        const field = W.doc.work ? 'work_brief' : 'brief';
        const old = W.doc[field] || '';
        const next = old + (old ? '\n\n' : '') + '【前情摘要】\n' + it.content;
        await api(`/api/write/doc/${W.doc.id}/save`, { [field]: next }); W.doc[field] = next;
        toast('已追加到' + (W.doc.work ? '作品设定' : '写作要求'), 'ok'); if (W.tab === 'brief') renderPanel(); return;
      }
      if (how === 'swap') {
        const m = it.meta;
        if (m.whole) { await setBody(it.content, `已把 ${who} 的新版本融入底稿`); if (m.blend) clearMarks(); return; }
        let start = m.start, end = m.end;
        if (body.slice(start, end) !== m.selection) { start = body.indexOf(m.selection); end = start + m.selection.length; }
        if (start < 0) { toast('这段原文已经被你改动过，找不到要替换的位置了。可以复制修改结果手动粘贴。', 'err'); return; }
        await setBody(body.slice(0, start) + it.content + body.slice(end), m.blend ? `已融入修改（${who}）` : `已替换选中的段落（${who}）`);
        W.sel = null;
        if (m.blend) clearMarks(); else addMark(start, start + it.content.length);
        return;
      }
    } catch (e) { if (e.cancel) toast('已取消，底稿没有改动。'); else toast(e.message, 'err'); }
  }

  // ---------- running ----------
  async function runAction(action, extra = {}) {
    if (busyElsewhere()) { toast('另一个任务正在进行，请稍等或先停止。'); return; }
    if (running()) return;
    await flush();
    const body = { doc: W.doc.id, action, members: picked(), prompt: '', use_body: false, ...extra };
    try {
      await api('/api/write/run', body);
      const verb = action === 'polish' ? (extra.option === 'rewrite' ? '重写' : extra.option === 'custom' ? '修改' : (scene().actions.find((a) => a.key === extra.option)?.label || '润色'))
        : action === 'draft' && extra.option === 'continue' ? '续写' : VERB[action];
      W.runInfo = { verb, members: body.members, total: body.members.length };
      RT().S.running = true; RT().S.runChat = -W.doc.id; renderPanel();
    } catch (e) {
      if (e.code === 'config') { toast(e.message, 'err'); RT().openSettings('connect'); } else toast(e.message, 'err');
    }
  }
  const runPolish = (option) => runAction('polish', { option, prompt: '', selection: currentSel() });
  function openCompare2() {
    const done = W.items.filter((i) => i.meta && i.meta.combo && i.status === 'complete');
    if (!done.length) return;
    const round = done[done.length - 1].round, list = done.filter((i) => i.round === round);
    const original = list[0].meta.selection || list[0].meta.original || '';
    const d = modal({ title: '并排对比', cls: 'wide2', body: `<div class="compare" style="grid-template-columns:repeat(${list.length + 1},minmax(0,1fr))">
      <div class="ccol"><div class="ihead"><b>${list[0].meta.whole ? '当前底稿' : '底稿里选中的这一段'}</b><span class="itime">${words(original)} 字</span></div><div class="ibody"><div class="md">${md.render(original)}</div></div></div>
      ${list.map((it) => `<div class="ccol m-${it.author}"><div class="ihead">${RT().avatar(it.author, 26)}<b>${esc(RT().displayName(it.author))}</b><span class="itime">${words(it.content)} 字</span></div><div class="ibody">${diffHTML(original, it.content)}</div><div class="iacts"><button class="act primary" data-pick-it="${it.id}" type="button">${list[0].meta.whole ? '设为底稿' : '融入底稿'}</button></div></div>`).join('')}</div>` });
    d.foot.innerHTML = '<button class="btn" data-close type="button">关闭</button>';
    d.el.addEventListener('click', (e) => { const b = e.target.closest('[data-pick-it]'); if (b) { d.close(); applyItem(W.items.find((x) => x.id === +b.dataset.pickIt), 'swap'); } });
  }
  function openCompare() {
    const done = W.items.filter((i) => i.kind === 'draft' && i.status === 'complete');
    if (!done.length) return;
    const round = done[done.length - 1].round, list = done.filter((i) => i.round === round);
    const d = modal({ title: '并排对比', cls: 'wide2', body: `<div class="compare" style="grid-template-columns:repeat(${list.length},minmax(0,1fr))">${list.map((it) => `<div class="ccol m-${it.author}" data-item="${it.id}"><div class="ihead">${RT().avatar(it.author, 26)}<b>${esc(RT().displayName(it.author))}</b><span class="itime">${words(it.content)} 字</span></div><div class="ibody"><div class="md">${md.render(it.content)}</div></div><div class="iacts"><button class="act primary" data-pick-it="${it.id}" type="button">设为底稿</button></div></div>`).join('')}</div>` });
    d.foot.innerHTML = '<button class="btn" data-close type="button">关闭</button>';
    d.el.addEventListener('click', (e) => { const b = e.target.closest('[data-pick-it]'); if (b) { d.close(); applyItem(W.items.find((x) => x.id === +b.dataset.pickIt), 'replace'); } });
  }

  // ---------- selection popover on draft cards ----------
  let pop = null, popState = null;
  function closePop() { if (pop) { pop.remove(); pop = null; popState = null; } }
  function passageSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const host = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('.ibody');
    const card = host?.closest('[data-item]');
    if (!host || !card || !host.closest('#wPanel, .compare')) return null;
    const item = W.items.find((x) => x.id === +card.dataset.item);
    if (!item || !['draft', 'merge', 'edit'].includes(item.kind) || item.status !== 'complete') return null;
    const text = sel.toString().replace(/\u00a0/g, ' ').trim();
    if (text.length < 2) return null;
    const rects = range.getClientRects();
    return { item, text, rect: rects[rects.length - 1] || range.getBoundingClientRect(), host };
  }
  function showPop() {
    const info = passageSelection();
    if (!info) { if (!pop || !pop.matches(':hover, :focus-within')) closePop(); return; }
    if (pop && popState && popState.text === info.text && popState.item.id === info.item.id) return;
    closePop();
    let who = info.item.author;
    popState = { ...info, who };
    pop = document.createElement('div');
    pop.className = 'selpop';
    const draw = () => {
      pop.innerHTML = `<div class="sp-row"><button type="button" data-sp="add" class="primary">${insertLabel()}</button><button type="button" data-sp="redo">${icon('refresh')}重新出</button><button type="button" data-sp="custom">改…</button></div>
        <div class="sp-who"><span>由</span>${MEMBERS.map((m) => `<button type="button" data-who="${m}" class="${m === popState.who ? 'on' : ''} m-${m}" data-tip="${esc(RT().displayName(m))}">${RT().avatar(m, 20)}</button>`).join('')}<span>重写</span></div>
        <div class="sp-custom hidden"><input class="input" placeholder="想怎么改？回车执行" maxlength="200"></div>`;
    };
    draw();
    pop.addEventListener('mousedown', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
    pop.addEventListener('click', async (e) => {
      const who2 = e.target.closest('[data-who]');
      if (who2) { popState.who = who2.dataset.who; const keep = $('.sp-custom input', pop)?.value; const open = !$('.sp-custom', pop).classList.contains('hidden'); draw(); if (open) { $('.sp-custom', pop).classList.remove('hidden'); $('.sp-custom input', pop).value = keep || ''; $('.sp-custom input', pop).focus(); } return; }
      const b = e.target.closest('[data-sp]'); if (!b) return;
      const { item, text } = popState, member = popState.who;
      if (b.dataset.sp === 'add') { closePop(); window.getSelection().removeAllRanges(); await insertIntoBody(text, `已把 ${RT().displayName(item.author).split(' ')[0]} 的这一段加入底稿`); return; }
      if (b.dataset.sp === 'redo') { closePop(); window.getSelection().removeAllRanges(); closeCompare(); runAction('polish', { option: 'rewrite', prompt: '', members: [member], selection: { text }, source_item: item.id }); return; }
      if (b.dataset.sp === 'custom') { const box = $('.sp-custom', pop); box.classList.toggle('hidden'); if (!box.classList.contains('hidden')) $('input', box).focus(); }
    });
    pop.addEventListener('keydown', (e) => {
      if (e.target.matches('input') && e.key === 'Enter' && !e.isComposing && e.target.value.trim()) {
        const { item, text } = popState, member = popState.who, note = e.target.value.trim();
        closePop(); window.getSelection().removeAllRanges(); closeCompare();
        runAction('polish', { option: 'custom', prompt: note, members: [member], selection: { text }, source_item: item.id });
      }
      if (e.key === 'Escape') closePop();
    });
    document.body.append(pop);
    const panel = $('#wPanel')?.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    const modalOpen = !!document.querySelector('.compare');
    let left = (!modalOpen && panel ? panel.right + 10 : info.rect.right + 10), top = info.rect.top - 8;
    if (left + w > innerWidth - 8) left = Math.max(8, info.rect.left - w - 10);
    top = Math.max(8, Math.min(top, innerHeight - h - 8));
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  function closeCompare() { document.querySelector('.compare')?.closest('.scrim')?.remove(); }
  let selTimer = null;
  let caretFrame = 0;
  const caretMoved = () => { if (document.activeElement && document.activeElement.id === 'wBody') { clearTimeout(caretFrame); caretFrame = setTimeout(renderMarks, 0); } };
  document.addEventListener('selectionchange', caretMoved);
  document.addEventListener('focusin', (e) => { if (e.target.id === 'wBody') caretMoved(); });
  document.addEventListener('focusout', (e) => { if (e.target.id === 'wBody') setTimeout(renderMarks, 0); });
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(showPop, 160); });
  document.addEventListener('mousedown', (e) => { if (pop && !pop.contains(e.target)) closePop(); }, true);

  // ---------- events ----------
  let paint = false;
  function schedulePaint() {
    if (paint) return; paint = true;
    requestAnimationFrame(() => {
      paint = false;
      W.items.filter((i) => i.status === 'running').forEach((it) => {
        const body = $(`[data-item="${it.id}"] [data-ibody]`);
        if (body) body.innerHTML = it.content ? `<div class="md caret">${md.render(it.content)}</div>` : '<span class="typing"><i></i><i></i><i></i></span>';
      });
    });
  }
  function onEvent(ev) {
    if (!ev.type.startsWith('w_')) {
      if ((ev.type === 'run_start' || ev.type === 'run_end') && W.doc && ev.chat === -W.doc.id) {
        if (ev.usage) setUsage(ev.usage);
        if (ev.type === 'run_end') W.runInfo = null;
        setTimeout(renderPanel, 0);
      }
      if (ev.type === 'usage_changed' && W.doc && ev.chat === -W.doc.id && ev.usage) setUsage(ev.usage);
      return false;
    }
    if (!W.doc || ev.doc !== W.doc.id) return true;
    if (ev.type === 'w_item_start') {
      const known = W.items.findIndex((i) => i.id === ev.item.id);
      if (known < 0) W.items.push(ev.item); else W.items[known] = ev.item;
      W.follow = true; const want = ['edit', 'review'].includes(ev.item.kind) ? 'review' : 'draft'; if (W.tab !== want) setTab(want); else renderPanel();
    } else if (ev.type === 'w_delta') {
      const it = W.items.find((i) => i.id === ev.id); if (it) { it.content = (it.content || '') + ev.text; schedulePaint(); }
    } else if (ev.type === 'w_route') {
      const it = W.items.find((i) => i.id === ev.id); if (it) { it.content = ''; it.route = ev.provider; schedulePaint(); }
    } else if (ev.type === 'w_item_end') {
      const n = W.items.findIndex((i) => i.id === ev.item.id);
      if (n >= 0) W.items[n] = ev.item; else W.items.push(ev.item);
      renderPanel();
    }
    return true;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  }

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !W.doc || !$('#wBody') || $('#wmain').classList.contains('hidden')) return;
    const key = e.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    const active = document.activeElement;
    if (active && active !== $('#wBody') && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;     // leave other fields their own undo
    if (document.querySelector('.scrim')) return;
    e.preventDefault();
    undoEditor(key === 'y' || e.shiftKey);
  });

  window.Write = { enter, shell, onEvent, flush, refreshDocs, addRefFiles };
})();
