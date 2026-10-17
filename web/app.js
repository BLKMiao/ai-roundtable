/* AI 圆桌 — front end. Talks to the local engine through /api/* and /events (see server.py). */
(() => {
  const { $, $$, esc, icon, api, prefs, toast, menu, modal, confirmBox, clock, short, bucket } = ui;
  const MEMBERS = ['Claude', 'GPT', 'Gemini'];
  const S = {
    mode: 'chat', stick: true, boot: null, chats: [], chatId: null, chat: null, pending: [], uploading: 0, target: 'all', rounds: 1, query: '',
    running: false, runChat: null, progress: {}, live: null, loadToken: 0,
  };
  const memberOf = (name) => S.boot.members.find((m) => m.name === name);
  const displayName = (name) => name === '你' ? S.boot.profile.nickname : memberOf(name)?.display || name;
  const isDirect = () => !!(S.chat && S.chat.target);
  const isMuted = (name) => !!S.chat?.muted?.includes(name);
  const orderedMembers = () => (S.chat.order || MEMBERS).map(memberOf);
  let suppressClick = false;
  const lineName = (id) => S.boot.lines.find((l) => l.id === id)?.name || id;
  const isBackup = (id) => !!id && !!S.boot.primary && id !== S.boot.primary;
  const lastOf = (arr) => arr[arr.length - 1];

  // ---------- small pieces ----------
  // Group chats get their own little badge so a long list is easy to tell apart: 25 pictures x 12 colours, handed out in
  // an order where neighbours always differ, and a combination only repeats after 300 chats.
  const BADGE_ART = [
    '<path d="M5 6h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/>',
    '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    '<path d="M12 3c3.5 2 5 5.5 5 9l-2 4H9l-2-4c0-3.5 1.5-7 5-9zM9 16l-2 4 3-1M15 16l2 4-3-1"/><circle cx="12" cy="10" r="1.6"/>',
    '<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14M5 19c3-4 6-6 9-8"/>',
    '<path d="M5 9h11v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5zM16 10h2a2.5 2.5 0 0 1 0 5h-2M8 3v2M12 3v2"/>',
    '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="16" r="2.2"/>',
    '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10"/>',
    '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
    '<path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 10a4 4 0 0 1-.5 8z"/>',
    '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
    '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/>',
    '<path d="M7 4h10l4 5-9 11L3 9z"/><path d="M3 9h18M9 4l3 5 3-5M12 20l-3-11M12 20l3-11"/>',
    '<path d="M6 21V4M6 5h11l-2 4 2 4H6"/>',
    '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    '<path d="M3 19 9 8l4 7 3-4 5 8z"/><circle cx="17" cy="6" r="1.6"/>',
    '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.500 5.500 0 0 0 16.500 3c-1.800 0-3 .5-4.500 2C10.500 3.500 9.300 3 7.500 3A5.500 5.500 0 0 0 2 8.500c0 2.300 1.500 4 3 5.500l7 7z"/>',
    '<circle cx="12" cy="12" r="9"/><path d="m15.500 8.500-2 5-5 2 2-5z"/>',
    '<circle cx="12" cy="5" r="2"/><path d="M12 7v14M7 11h10M5 15c0 3 3 6 7 6s7-3 7-6"/>',
    '<path d="M3 18 5 7l4.500 4L12 5l2.500 6L19 7l2 11zM4 21h16"/>',
    '<rect x="4" y="9" width="16" height="11" rx="1.500"/><path d="M3 9h18v3H3zM12 9v11M12 9c-3-1-4-4-2-5s4 2 2 5zM12 9c3-1 4-4 2-5s-4 2-2 5z"/>',
    '<path d="M12 21c-5-3-8-6-8-10a4.500 4.500 0 0 1 8-2.700A4.500 4.500 0 0 1 20 11c0 4-3 7-8 10z"/><path d="M9 11h6"/>',
  ];
  const BADGE_HUE = [212, 338, 152, 28, 268, 186, 4, 96, 312, 48, 238, 126];
  // icon = "picture:colour" chosen by the user, or empty for the automatic one (from the chat's number)
  function chatBadge(id, size = 40, icon = '') {
    if (/^img:badge-[0-9a-f]{32}\.png$/.test(icon || '')) return `<span class="av badge photo" style="width:${size}px;height:${size}px"><img src="/files/profile/${icon.slice(4)}" alt=""></span>`;
    const n = Math.max(0, parseInt(id, 10) || 0), pick = /^(\d+):(\d+)$/.exec(icon || '');
    const art = BADGE_ART[(pick ? +pick[1] : n) % BADGE_ART.length], h = BADGE_HUE[(pick ? +pick[2] : n) % BADGE_HUE.length];
    const box = `width:${size}px;height:${size}px`;
    return `<span class="av badge" style="${box};background:linear-gradient(145deg,hsl(${h} 78% 64%),hsl(${(h + 24) % 360} 72% 46%))"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${art}</svg></span>`;
  }
  const chatAvatar = (c, size = 40) => (c.target ? avatar(c.target, size) : chatBadge(c.id, size, c.icon));
  // Let the user choose a picture and a colour for a chat or a manuscript. start = current "a:h" (or the automatic pair).
  function pickBadge({ title = '更换图标', start, auto = false, onSave, onReset }) {
    const m = /^(\d+):(\d+)$/.exec(start || '') || [0, 0, 0];
    let art = +m[1] % BADGE_ART.length, hue = +m[2] % BADGE_HUE.length;
    const body = `<div class="badge-pick"><div class="bp-prev" id="bpPrev"></div>
      <div class="bp-grid" id="bpArt">${BADGE_ART.map((_, i) => `<button type="button" class="bp-art" data-art="${i}" aria-label="图案 ${i + 1}">${chatBadge(i, 34, i + ':' + hue)}</button>`).join('')}</div>
      <button class="btn" type="button" id="bpPhoto" style="justify-self:stretch">${icon('image')}上传自己的照片作为图标</button>
      <div class="bp-hues" id="bpHue">${BADGE_HUE.map((h, i) => `<button type="button" class="bp-hue" data-hue="${i}" style="background:linear-gradient(145deg,hsl(${h} 78% 64%),hsl(${(h + 24) % 360} 72% 46%))" aria-label="颜色 ${i + 1}"></button>`).join('')}</div></div>`;
    const d = modal({ title, cls: 'mid', body });
    d.foot.innerHTML = `${onReset ? '<button class="btn" type="button" id="bpReset" style="margin-right:auto">恢复自动图标</button>' : ''}<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" id="bpOk">保存</button>`;
    const paint = () => {
      $('#bpPrev', d.el).innerHTML = chatBadge(0, 64, art + ':' + hue);
      $$('[data-art]', d.el).forEach((b) => { b.innerHTML = chatBadge(+b.dataset.art, 34, b.dataset.art + ':' + hue); b.classList.toggle('on', +b.dataset.art === art); });
      $$('[data-hue]', d.el).forEach((b) => b.classList.toggle('on', +b.dataset.hue === hue));
    };
    d.el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-art]'), h = e.target.closest('[data-hue]');
      if (a) art = +a.dataset.art; if (h) hue = +h.dataset.hue;
      if (a || h) paint();
    });
    paint();
    $('#bpOk', d.el).onclick = async () => { await onSave(art + ':' + hue); d.close(); };
    $('#bpPhoto', d.el).onclick = () => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
      input.onchange = async () => {
        const file = input.files[0]; if (!file) return;
        try { const r = await api('/api/icon/upload', file); await onSave(r.icon); d.close(); } catch (e) { toast(e.message, 'err'); }
      };
      input.click();
    };
    const reset = $('#bpReset', d.el); if (reset) reset.onclick = async () => { await onReset(); d.close(); };
  }

  function avatar(name, size = 36, extra = '') {
    const box = `width:${size}px;height:${size}px;font-size:${Math.round(size * .42)}px`;
    if (MEMBERS.includes(name)) return `<span class="av m-${name} ${extra}" style="${box}"><img src="/assets/${name}.png" alt="${name}"></span>`;
    if (name === '圆桌') return `<span class="av table" style="${box}"><img src="/assets/roundtable.png?v=6" alt=""></span>`;
    if (name === '图片生成') return `<span class="av m-图片生成" style="${box}">${icon('sparkles')}</span>`;
    if (name === '你') {
      const p = S.boot.profile;
      return p.avatar ? `<span class="av cover m-你" style="${box}"><img src="${esc(p.avatar)}" alt=""></span>`
        : `<span class="av m-你" style="${box}">${esc([...p.nickname][0] || '我')}</span>`;
    }
    return `<span class="av" style="${box}">${icon('info')}</span>`;
  }

  // ---------- shell ----------
  function renderShell() {
    $('#app').innerHTML = `
      <aside class="rail" id="rail"></aside>
      <section class="list" id="clist">
        <div class="list-head"><h1>消息</h1><button class="icon-btn solid" id="newChat" data-tip="新建讨论">${icon('plus')}</button></div>
        <label class="search">${icon('search')}<input id="search" placeholder="搜索讨论" autocomplete="off"></label>
        <div class="quick"><span>直接找 TA 聊聊</span>${MEMBERS.map((n) => `<button type="button" data-direct="${n}" data-tip="与 ${esc(memberOf(n).display)} 单聊">${avatar(n, 30)}</button>`).join('')}</div>
        <div class="chats" id="chats"></div>
      </section>
      <section class="list hidden" id="wlist"></section>
      <main class="main" id="main">
        <div class="head" id="head"></div>
        <div class="people" id="people"></div>
        <div class="scroller" id="scroller"><div class="thread" id="thread"></div></div>
        <div class="dock"><div class="dock-inner">
          <button class="to-bottom hidden" id="toBottom" type="button">${icon('arrowDown')}回到最新</button>
          <div class="suggest" id="suggest"></div>
          <div class="composer" id="composer">
            <div class="mention hidden" id="mention"></div>
            <div class="thumbs hidden" id="thumbs"></div>
            <textarea id="input" rows="1" placeholder="说说你的想法，或输入 @ 点名一位 AI…" spellcheck="false"></textarea>
            <div class="tools">
              <button class="tool" id="attachBtn" type="button" data-tip="添加图片或短视频，也可以直接粘贴、拖入">${icon('clip')}附件</button>
              <input type="file" id="file" multiple hidden accept="image/*,video/mp4,video/quicktime,video/webm,.mov">
              <button class="tool" id="imageBtn" type="button" data-tip="用 GPT Image 2 生成图片">${icon('sparkles')}生成图片</button>
              <span class="sep"></span>
              <button class="tool sel" id="targetBtn" type="button"></button>
              <button class="tool sel" id="roundsBtn" type="button"></button>
              <span class="grow"></span>
              <span class="hintkeys" id="keys"></span>
              <button class="send" id="sendBtn" type="button" aria-label="发送"></button>
            </div>
          </div>
        </div></div>
      </main>
      <main class="main hidden" id="wmain"></main>`;
    bindShell();
  }

  function renderRail() {
    $('#rail').innerHTML = `
      <div class="brand"><img src="/logo.png?v=6" alt="AI 圆桌"></div>
      <button class="rail-btn ${S.mode === 'chat' ? 'on' : ''}" type="button" id="railChat" data-tip="聊聊：讨论、分析问题" data-tip-side="right">${icon('chat')}</button>
      <button class="rail-btn ${S.mode === 'write' ? 'on' : ''}" type="button" id="railWrite" data-tip="写作：三位 AI 帮你写、改、优化" data-tip-side="right">${icon('pencil')}</button>
      <button class="rail-btn" type="button" id="railImage" data-tip="图片创作" data-tip-side="right">${icon('sparkles')}</button>
      <button class="rail-btn" type="button" id="railUsage" data-tip="用量明细" data-tip-side="right">${icon('chart')}</button>
      <span class="grow"></span>
      <button class="rail-btn" type="button" id="railTheme" data-tip="切换明暗" data-tip-side="right">${icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')}</button>
      <button class="rail-btn" type="button" id="railSettings" data-tip="设置 (Ctrl+,)" data-tip-side="right">${icon('sliders')}</button>
      <button class="me" type="button" id="railMe" data-tip="${esc(S.boot.profile.nickname)} · 我的资料" data-tip-side="right">${avatar('你', 36)}</button>`;
    $('#railChat').onclick = () => setMode('chat');
    $('#railWrite').onclick = () => setMode('write');
    $('#railImage').onclick = () => { setMode('chat'); openImage(); };
    $('#railUsage').onclick = () => openSettings('usage');
    $('#railSettings').onclick = () => openSettings('connect');
    $('#railMe').onclick = () => openSettings('profile');
    $('#railTheme').onclick = () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      prefs.set('theme', dark ? 'light' : 'dark'); ui.applyTheme(); renderRail();
    };
  }

  // ---------- chat / write mode ----------
  async function setMode(mode) {
    if (mode === S.mode && $('#wlist') && ($('#clist').classList.contains('hidden') === (mode === 'write'))) return;
    if (S.mode === 'write' && window.Write) await Write.flush();
    S.mode = mode; prefs.set('mode', mode);
    const write = mode === 'write';
    ['#clist', '#main'].forEach((s) => $(s).classList.toggle('hidden', write));
    ['#wlist', '#wmain'].forEach((s) => $(s).classList.toggle('hidden', !write));
    renderRail();
    document.body.classList.remove('nav-open');
    if (write) { try { await Write.enter(); } catch (e) { toast(e.message, 'err'); } } else { refreshChats(); }
  }

  // ---------- chat list ----------
  async function refreshChats() {
    S.chats = await api('/api/chats');
    renderList();
  }
  function renderList() {
    const box = $('#chats');
    if (!box) return;
    const q = S.query.trim().toLowerCase();
    const items = S.chats.filter((c) => !q || c.title.toLowerCase().includes(q) || c.last_text.toLowerCase().includes(q));
    if (!items.length) { box.innerHTML = `<div class="empty-list">${q ? '没有找到相关讨论' : '还没有讨论，点右上角 + 开始'}</div>`; return; }
    let html = '', current = '';
    for (const c of items) {
      const group = bucket(c.last_time);
      if (group !== current) { current = group; html += `<div class="group-label">${group}</div>`; }
      const who = c.last_speaker ? (c.last_speaker === '你' ? '你' : displayName(c.last_speaker).split(' ')[0]) + '：' : '';
      html += `<div class="chat-item ${c.id === S.chatId ? 'on' : ''}" data-id="${c.id}">
        ${chatAvatar(c, 40)}
        <div class="body"><div class="row"><span class="title">${esc(c.title)}</span>${c.running ? '<span class="pulse-dot"></span>' : `<span class="time">${c.count ? short(c.last_time) : ''}</span>`}</div>
        <div class="preview">${c.count ? esc(who + c.last_text.replace(/\s+/g, ' ')) : (c.target ? '单聊' : '还没有消息')}</div></div>
        <button class="more" type="button" data-more="${c.id}" aria-label="更多">${icon('more')}</button></div>`;
    }
    box.innerHTML = html;
  }
  function chatMenu(anchor, id, opts) {
    const c = S.chats.find((x) => x.id === id);
    menu(anchor, [
      { label: '重命名', icon: 'pencil', run: () => { if (id !== S.chatId) selectChat(id).then(startRename); else startRename(); } },
      ...(c && !c.target ? [{ label: '更换图标', icon: 'sparkles', run: () => changeChatIcon(id) }] : []),
      { label: '导出为 Markdown', icon: 'download', run: () => exportChat(id) },
      '-',
      { label: '删除讨论', icon: 'trash', danger: true, run: () => deleteChat(id, c?.title) },
    ], opts);
  }
  function changeChatIcon(id) {
    const c = S.chats.find((x) => x.id === id) || (S.chat && S.chat.id === id ? S.chat : null); if (!c) return;
    const save = async (icon) => {
      try { await api(`/api/chat/${id}/icon`, { icon }); c.icon = icon; if (S.chat && S.chat.id === id) S.chat.icon = icon; await refreshChats(); if (S.chat && S.chat.id === id) renderHead(); } catch (e) { toast(e.message, 'err'); }
    };
    pickBadge({ start: c.icon || (id % BADGE_ART.length) + ':' + (id % BADGE_HUE.length), onSave: save, onReset: () => save('') });
  }
  async function selectChat(id) {
    if (id === S.chatId && S.chat) return;
    S.target = 'all';
    await loadChat(id);
    document.body.classList.remove('nav-open');
  }
  async function newChat() {
    try {
      const { id } = await api('/api/chat/new', {});
      await refreshChats(); await selectChat(id); $('#input').focus();
    } catch (e) { toast(e.message, 'err'); }
  }
  async function directChat(name) {
    try { const { id } = await api('/api/chat/direct', { name }); await refreshChats(); await selectChat(id); $('#input').focus(); }
    catch (e) { toast(e.message, 'err'); }
  }
  async function deleteChat(id, title) {
    if (!await confirmBox({ title: '删除这个讨论？', text: `「${title || '未命名'}」的全部消息和附件会从本机删除，无法恢复。`, ok: '删除', danger: true })) return;
    try {
      await api(`/api/chat/${id}/delete`, {});
      await refreshChats();
      if (id === S.chatId) {
        S.chatId = null; S.chat = null;
        if (S.chats.length) await selectChat(S.chats[0].id); else { const r = await api('/api/chat/new', {}); await refreshChats(); await selectChat(r.id); }
      }
      toast('已删除', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function exportChat(id) {
    try {
      const { title, text } = await api(`/api/chat/${id}/export`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      a.download = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) + '.md';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('已导出为 Markdown，在「下载」文件夹里', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- header / participants ----------
  function setUsage(u) {
    if (S.chat && u) S.chat.usage = u;
    const pill = $('#usagePill');
    if (pill && S.chat) pill.innerHTML = `本轮 <b>${esc(S.chat.usage.round)}</b> · 本聊 <b>${esc(S.chat.usage.chat)}</b> 积分`;
  }
  function renderHead() {
    if (!S.chat) return;
    const b = S.boot, c = S.chat;
    const ready = b.lines.filter((l) => l.configured);
    const link = !ready.length ? `<span class="dot warn"></span>尚未配置密钥`
      : `<span class="dot ok"></span>${esc(lineName(b.primary))} 主线路${ready.length > 1 ? ' · 备用已就绪' : ' · 备用未配置'}`;
    $('#head').innerHTML = `
      <button class="icon-btn only-narrow" type="button" id="navToggle" aria-label="菜单">${icon('menu')}</button>
      <button type="button" class="head-ic" id="headIcon" ${c.target ? 'disabled' : 'data-tip="点击更换图标"'}>${chatAvatar(c, 40)}</button>
      <div class="titles"><h2 id="title" title="双击重命名">${esc(c.title === '新讨论' ? 'AI 圆桌讨论' : c.title)}</h2>
        <div class="sub">${c.target ? '与 ' + esc(displayName(c.target)) + ' 单聊' : '圆桌群聊'} <span style="color:var(--line-strong)">|</span> ${link}</div></div>
      <button class="pill" type="button" id="usagePill" data-tip="点击查看用量明细"></button>
      <button class="icon-btn" type="button" id="exportBtn" data-tip="导出为 Markdown">${icon('download')}</button>
      <button class="icon-btn" type="button" id="moreBtn" aria-label="更多">${icon('more')}</button>`;
    setUsage(c.usage);
    document.title = (c.title === '新讨论' ? 'AI 圆桌' : c.title + ' · AI 圆桌');
    $('#usagePill').onclick = () => openSettings('usage');
    $('#exportBtn').onclick = () => exportChat(c.id);
    $('#moreBtn').onclick = (e) => chatMenu(e.currentTarget, c.id, { align: 'right' });
    $('#title').ondblclick = startRename;
    $('#headIcon').onclick = () => { if (!c.target) changeChatIcon(c.id); };
    $('#navToggle').onclick = () => document.body.classList.toggle('nav-open');
  }
  function startRename() {
    const h = $('#title');
    if (!h || !S.chat) return;
    const input = document.createElement('input');
    input.value = S.chat.title === '新讨论' ? '' : S.chat.title;
    input.maxLength = 60; input.placeholder = '给这个讨论起个名字';
    h.replaceChildren(input); input.focus(); input.select();
    let done = false;
    const commit = async (save) => {
      if (done) return; done = true;
      const title = input.value.trim();
      if (save && title && title !== S.chat.title) {
        try { await api(`/api/chat/${S.chat.id}/rename`, { title }); S.chat.title = title; refreshChats(); } catch (e) { toast(e.message, 'err'); }
      }
      renderHead();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) commit(true); if (e.key === 'Escape') commit(false); };
    input.onblur = () => commit(true);
  }
  function renderPeople() {
    const box = $('#people');
    if (!box || !S.chat) return;
    const running = S.running && S.runChat === S.chatId;
    const chip = (m, toggle) => {
      const state = running ? S.progress[m.name] || '' : '';
      const muted = toggle && isMuted(m.name), on = !muted;
      return `<span class="chip m-${m.name} ${muted ? 'off muted' : 'on'} ${state}" data-chip="${m.name}" ${toggle ? `role="button" tabindex="0" data-tip="${muted ? '已禁言：本讨论不会问 TA（@TA 仍可点名）。点击解除' : '点击禁言：本讨论不再问 TA'}"` : ''}>
        <span data-card="${m.name}" data-tip="查看 ${esc(m.display)} 的名片">${avatar(m.name, 26)}</span><span>${esc(m.display)}</span>${muted ? `<span class="mutetag">${icon('mute')}已禁言</span>` : ''}
        <span class="state">${state === 'active' ? '<i class="spinner"></i>' : state === 'done' ? icon('check') : state === 'fail' ? icon('alert') : ''}</span></span>`;
    };
    if (S.chat.target) {
      const m = memberOf(S.chat.target);
      box.innerHTML = `<span class="lab">单聊对象</span>${chip(m, false)}<span class="hint" style="margin-left:6px">只有 ${esc(m.display)} 会回复${'；发送视频时会请 Gemini 先看'}</span>`;
    } else {
      box.innerHTML = `<span class="lab">参与讨论</span>${orderedMembers().map((m) => chip(m, true)).join('')}
        <span class="hint" style="margin-left:6px">${S.boot.members.filter((m) => !isMuted(m.name)).length} 位发言 · 点名字禁言 · 拖动名字调顺序</span>`;
    }
  }

  // ---------- thread ----------
  function attachmentsHTML(list) {
    if (!list?.length) return '';
    return `<div class="attach-grid">${list.map((a) => a.kind === 'image'
      ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" data-zoom loading="lazy">`
      : `<span class="file-pill">${icon('play')}视频 · ${esc(a.name)}</span>`).join('')}</div>`;
  }
  function msgHTML(m) {
    if (m.speaker === '系统') {
      return `<div class="msg" data-mid="${m.id}"><div class="col" style="margin:0 auto;max-width:640px"><div class="notice">${icon('alert')}<span>${esc(m.content)}</span></div></div></div>`;
    }
    const me = m.speaker === '你', image = m.speaker === '图片生成';
    const failed = m.status === 'error', stopped = m.status === 'cancelled';
    const tags = (me ? '' : `<span class="tag">${image ? '绘图' : 'AI'}</span>`)
      + (isBackup(m.route) && !failed ? '<span class="tag route">备用线路</span>' : '')
      + (stopped ? '<span class="tag stopped">已停止 · 部分回复</span>' : '') + (failed ? '<span class="tag failed">未完成</span>' : '');
    const text = image ? m.content.replace(/^按以下描述生成图片：\n/, '') : m.content;
    const body = (text || m.attachments.length) ? `${attachmentsHTML(m.attachments)}${text ? `<div class="bubble md">${md.render(image ? '**生成图片：**' + text : text)}</div>` : ''}` : '';
    const note = m.note && m.status !== 'complete' ? `<div class="notice ${stopped ? 'soft' : ''}">${icon(stopped ? 'info' : 'alert')}<span>${esc(m.note)}</span>${!me ? `<button type="button" data-retry="${m.id}">重试</button>` : ''}</div>` : '';
    const retry = !me && m.status !== 'complete' && !m.note ? `<button class="act" type="button" data-retry="${m.id}">${icon('refresh')}重试</button>` : '';
    return `<div class="msg ${me ? 'me' : 'ai'} m-${m.speaker}" data-mid="${m.id}" data-speaker="${esc(m.speaker)}">
      ${avatar(m.speaker, 38)}
      <div class="col"><div class="meta"><span class="name">${esc(displayName(m.speaker))}</span>${tags}<span>${clock(m.created)}</span></div>
      ${body}${note}
      <div class="actions ${failed || stopped ? 'show' : ''}">${text ? `<button class="act" type="button" data-copy>${icon('copy')}复制</button>` : ''}${me ? '' : text ? `<button class="act" type="button" data-quote>${icon('reply')}引用追问</button>` : ''}${retry}</div></div></div>`;
  }
  function welcomeHTML() {
    const b = S.boot, c = S.chat;
    if (c.target) {
      const m = memberOf(c.target);
      return `<div class="welcome"><div class="hero">${avatar(c.target, 60)}<h3>${esc(m.display)}</h3></div><p>${esc(m.bio)}<br>这里是你们两个人的单独对话，其他成员不会参与。</p>
        <div class="ideas">${[['帮我把这个想法想清楚，先问我最关键的问题。', '先澄清再回答'], ['请直接指出这个方案最大的漏洞。', '挑毛病'], ['用最简单的话解释一下，再给我一个可以马上做的下一步。', '讲明白 + 下一步']]
          .map((x, n) => `<button class="idea" type="button" data-idea="${esc(x[0])}"><span class="n">${n + 1}</span><span><b>${esc(x[0])}</b><span>${x[1]}</span></span></button>`).join('')}</div></div>`;
    }
    const ideas = [['帮我把这个想法想清楚，先问我最关键的问题。', '大家先澄清目标，再各自回应'], ['请从不同角度分析，不要为了同意我而同意。', '让三位 AI 保持各自判断'], ['一个提思路，一个找问题，一个整理下一步。', '分工接力，最后收束成行动']];
    return `<div class="welcome"><div class="hero"><img src="/logo.png?v=6" alt=""><h3>欢迎来到 AI 圆桌</h3></div>
      <p>说出一个想法，让 Claude、GPT、Gemini 围坐在一起，从不同角度和你一起聊清楚。<br>也可以拖入图片，或请 Gemini 先看一段视频。</p>
      <div class="ideas">${ideas.map((x, n) => `<button class="idea" type="button" data-idea="${esc(x[0])}"><span class="n">${n + 1}</span><span><b>${esc(x[0])}</b><span>${x[1]}</span></span></button>`).join('')}</div>
      ${b.connected ? '' : `<div class="setup-card">${icon('lock', '')}<span>还没有配置密钥。在设置里填入你的平台密钥（内置 CherryIn、AIHUBMIX，或自定义任意 OpenAI 兼容接口）即可开始。</span><button type="button" data-open-settings>去填写</button></div>`}</div>`;
  }
  function renderThread() {
    const thread = $('#thread');
    const c = S.chat;
    if (!c.messages.length && !c.live) thread.innerHTML = welcomeHTML();
    else thread.innerHTML = c.messages.map(msgHTML).join('');
    S.live = null;
    if (c.live) startLive(c.live.speaker, c.live.text, c.live.route, true);
    scrollBottom(true);
  }
  function scroller() { return $('#scroller'); }
  function nearBottom() { const s = scroller(); return s.scrollHeight - s.scrollTop - s.clientHeight < 160; }
  function scrollBottom(force) {
    const s = scroller();
    if (force || S.stick) { s.scrollTop = s.scrollHeight; $('#toBottom').classList.add('hidden'); }
    else $('#toBottom').classList.remove('hidden');
  }
  function appendHTML(html, force) {
    S.stick = force || nearBottom();
    const thread = $('#thread');
    if (thread.querySelector('.welcome')) thread.innerHTML = '';
    thread.insertAdjacentHTML('beforeend', html);
    thread.lastElementChild?.classList.add('fresh');
    scrollBottom(force);
  }

  // live (streaming) message
  function startLive(speaker, text = '', route = '', silent = false) {
    if (!silent) S.stick = nearBottom();
    $('#live')?.remove();
    const thread = $('#thread');
    if (thread.querySelector('.welcome')) thread.innerHTML = '';
    S.live = { speaker, text, route };
    const image = speaker === '图片生成';
    thread.insertAdjacentHTML('beforeend', `<div class="msg ai fresh m-${speaker}" id="live">${avatar(speaker, 38)}<div class="col">
      <div class="meta"><span class="name">${esc(displayName(speaker))}</span><span class="tag">${image ? '绘图' : 'AI'}</span><span class="tag route hidden" id="liveRoute">备用线路</span><span id="liveState">${image ? '正在生成，可能需要几分钟…' : '正在回复…'}</span></div>
      <div class="bubble md" id="liveBubble"></div></div></div>`);
    paintLive();
    scrollBottom(false);
  }
  let paintQueued = false;
  function schedulePaint() { if (!paintQueued) { paintQueued = true; requestAnimationFrame(() => { paintQueued = false; paintLive(); }); } }
  function paintLive() {
    const L = S.live, bubble = $('#liveBubble');
    if (!L || !bubble) return;
    $('#liveRoute').classList.toggle('hidden', !isBackup(L.route));
    if (!L.text) { bubble.className = 'bubble'; bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'; }
    else { bubble.className = 'bubble md caret'; bubble.innerHTML = md.render(L.text); }
    const stick = S.stick !== false; if (stick) scrollBottom(false);
  }
  function finishLive(message) {
    const el = $('#live');
    S.live = null;
    if (el) { S.stick = nearBottom(); el.outerHTML = msgHTML(message); scrollBottom(false); }
    else appendHTML(msgHTML(message));
  }

  // ---------- composer ----------
  const input = () => $('#input');
  function autosize() { const t = input(); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 220) + 'px'; }
  function sendKeyMode() { return prefs.get('sendKey', 'enter'); }
  function syncComposer() {
    if (!S.chat) return;
    const busy = S.running, other = busy && S.runChat !== S.chatId, direct = isDirect();
    const enabled = S.boot.members.filter((m) => !isMuted(m.name)).length;
    const t = $('#targetBtn'), r = $('#roundsBtn');
    t.innerHTML = direct ? `${avatar(S.chat.target, 18)}仅 ${esc(displayName(S.chat.target).split(' ')[0])} 回复`
      : S.target === 'all' ? `${icon('users')}发给：大家${icon('down')}` : `${avatar(S.target, 18)}只问 ${esc(S.target)}${icon('down')}`;
    t.disabled = direct || busy; t.classList.toggle('sel', !direct);
    r.classList.toggle('hidden', direct || S.target !== 'all' || enabled < 2);
    r.innerHTML = `讨论 ${S.rounds} 轮${icon('down')}`; r.disabled = busy;
    $('#attachBtn').disabled = busy; $('#imageBtn').disabled = busy;
    $('#keys').textContent = sendKeyMode() === 'enter' ? 'Enter 发送 · Shift+Enter 换行' : 'Ctrl+Enter 发送 · Enter 换行';
    const send = $('#sendBtn');
    const empty = !input().value.trim() && !S.pending.length;
    send.className = 'send' + (busy ? ' stop' : '');
    send.innerHTML = icon(busy ? 'stop' : 'send');
    send.disabled = busy ? other : empty || S.uploading > 0;
    send.setAttribute('aria-label', busy ? '停止' : '发送');
    send.dataset.tip = busy ? (other ? '另一个讨论正在回复' : '停止本轮') : '发送';
    input().placeholder = busy ? '正在回复中，可以先写下一条…' : direct ? `和 ${displayName(S.chat.target)} 说点什么…` : '说说你的想法，或输入 @ 点名一位 AI…';
    // quick "keep talking" chip
    const last = lastOf(S.chat.messages);
    const showContinue = !busy && last && last.speaker !== '你' && last.status === 'complete' && empty;
    $('#suggest').innerHTML = !showContinue ? '' : direct ? `<button type="button" id="contBtn">${icon('refresh')}请 TA 继续说</button>`
      : nextSteps().map((k) => `<button type="button" data-next="${k}" data-tip="${esc(k === 'pick' ? '在输入框里写上你选的方案，让大家点评它' : S.boot.presets[k].text)}">${icon(NEXT_ICON[k] || 'refresh')}${esc(k === 'pick' ? '我选一个方案…' : S.boot.presets[k].label)}</button>`).join('');
    $('#contBtn')?.addEventListener('click', () => sendMessage(true));
    $$('[data-next]', $('#suggest')).forEach((b) => b.addEventListener('click', () => (b.dataset.next === 'pick' ? pickPlan() : sendMessage(false, b.dataset.next))));
  }

  function mentionState() {
    const t = input(), before = t.value.slice(0, t.selectionStart), m = /(^|\s)@([A-Za-z]*)$/.exec(before);
    return m && !isDirect() ? { start: before.length - m[2].length - 1, query: m[2].toLowerCase() } : null;
  }
  let mentionIndex = 0;
  function renderMention() {
    const box = $('#mention'), st = mentionState();
    const list = st ? S.boot.members.filter((m) => m.name.toLowerCase().startsWith(st.query)) : [];
    if (!list.length) { box.classList.add('hidden'); return; }
    mentionIndex = Math.min(mentionIndex, list.length - 1);
    box.classList.remove('hidden');
    box.innerHTML = list.map((m, n) => `<button type="button" class="${n === mentionIndex ? 'cur' : ''}" data-mention="${m.name}">${avatar(m.name, 28)}<span>@${m.name}<small>${esc(m.display)}</small></span></button>`).join('');
  }
  function pickMention(name) {
    const t = input(), st = mentionState();
    if (!st) return;
    t.value = t.value.slice(0, st.start) + '@' + name + ' ' + t.value.slice(t.selectionStart);
    const pos = st.start + name.length + 2;
    t.setSelectionRange(pos, pos); t.focus(); renderMention(); autosize(); syncComposer();
  }

  // What to offer after a round depends on what that round was: after fresh proposals -> more / review / refine / pick one;
  // after a review or discussion -> keep discussing / sum up / fresh proposals / pick one.
  const NEXT_ICON = { more: 'sparkles', review: 'chat', refine: 'pencil', talk: 'refresh', sum: 'check', pick: 'star' };
  function nextSteps() {
    const asked = [...S.chat.messages].reverse().find((m) => m.speaker === '你');
    const kind = asked && Object.keys(S.boot.presets || {}).find((k) => S.boot.presets[k].text === asked.content);
    const discussed = (kind && S.boot.presets[kind].mode === 'discuss') || !!(asked && asked.content.startsWith('我比较认可「'));
    return discussed ? ['talk', 'sum', 'more', 'pick'] : ['more', 'review', 'refine', 'pick'];
  }
  function sumTarget() {
    const order = (S.chat.order || MEMBERS).filter((n) => !isMuted(n) && memberOf(n)?.enabled !== false);
    return order.includes('GPT') ? 'GPT' : order[0] || 'GPT';
  }
  function pickPlan() {
    const t = input(), head = '我比较认可「', tail = '」这个方案，请大家简短点评它的优缺点，并给出具体的改进建议。';
    t.value = head + tail; autosize(); t.focus(); t.setSelectionRange(head.length, head.length); syncComposer();
  }
  async function sendMessage(cont = false, preset = '') {
    if (S.running) { toast('正在回复中，请稍等，或先点击停止。'); return; }
    if (S.uploading) { toast('附件还在上传，请稍等一下。'); return; }
    if (preset) cont = true;
    const t = input(), text = cont ? '' : t.value.trim();
    if (!cont && !text && !S.pending.length) return;
    const chatId = S.chatId, pending = S.pending.slice();
    // show the message right away so replies can never appear above it
    const optimistic = { id: 'tmp', speaker: '你', content: preset ? S.boot.presets[preset].text : text || (pending.length ? '' : '（继续讨论）'), status: 'complete', created: Date.now() / 1000, attachments: pending, route: '', note: '' };
    try {
      if (!S.boot.connected) { const e = new Error('请先在「设置 → 连接」里填写至少一条线路的密钥。'); e.code = 'config'; throw e; }
      if (cont || text || pending.length) appendHTML(msgHTML(optimistic), true);
      const target = preset ? (S.boot.presets[preset].single ? sumTarget() : 'all') : S.target;
      const res = await api('/api/send', { chat: chatId, text, uploads: pending.map((p) => p.id), target, rounds: preset ? 1 : S.rounds, preset });
      S.chat.messages.push(res.message);
      $$('#thread [data-mid="tmp"]').forEach((el) => { el.outerHTML = msgHTML(res.message); });
      if (!cont) { t.value = ''; autosize(); S.pending = []; renderThumbs(); }
      for (const n of res.names) if (!S.progress[n]) S.progress[n] = 'wait';
      S.running = true; S.runChat = chatId;
      renderPeople(); syncComposer(); refreshChats();
    } catch (e) {
      $$('#thread [data-mid="tmp"]').forEach((el) => el.remove());
      if (!S.chat.messages.length) { renderThread(); }
      if (e.code === 'config') { toast(e.message, 'err'); openSettings('connect'); } else toast(e.message, 'err');
    }
  }
  async function stopRun() { try { await api('/api/stop', {}); } catch (e) { toast(e.message, 'err'); } }

  // attachments
  function renderThumbs() {
    const box = $('#thumbs');
    box.classList.toggle('hidden', !S.pending.length && !S.uploading);
    box.innerHTML = S.pending.map((p, n) => `<div class="thumb ${p.kind === 'video' ? 'video' : ''}" title="${esc(p.name)}">
      ${p.kind === 'image' ? `<img src="${esc(p.url)}" alt="">` : `${icon('play')}<span>视频</span>`}
      <button class="rm" type="button" data-rm="${n}" aria-label="移除">${icon('x')}</button></div>`).join('')
      + (S.uploading ? `<div class="thumb"><i class="spinner" style="width:18px;height:18px;border:2px solid var(--line-strong);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite"></i></div>` : '');
    syncComposer();
  }
  async function addFiles(files) {
    const limit = S.boot.limits.attachments;
    for (const file of files) {
      if (!/^(image|video)\//.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|mp4|mov|webm)$/i.test(file.name)) { toast(`「${file.name}」不是图片或视频，已跳过。`); continue; }
      if (S.pending.length + S.uploading >= limit) { toast(`每条消息最多 ${limit} 个附件。`); break; }
      if (file.size > 40 * 1024 * 1024) { toast(`「${file.name}」太大了。视频请先截取 12 MB 以内的片段。`, 'err'); continue; }
      S.uploading++; renderThumbs();
      try {
        const name = file.name && file.name !== 'image.png' ? file.name : '截图-' + new Date().toTimeString().slice(0, 8).replace(/:/g, '') + '.png';
        const item = await api('/api/upload?name=' + encodeURIComponent(name), file);
        S.pending.push(item);
      } catch (e) { toast(e.message, 'err'); }
      S.uploading--; renderThumbs();
    }
  }

  // ---------- events from the engine ----------
  function onEvent(ev) {
    if (window.Write && Write.onEvent(ev)) return;
    const here = ev.chat === S.chatId;
    switch (ev.type) {
      case 'run_start': S.running = true; S.runChat = ev.chat; S.progress = {}; renderPeople(); syncComposer(); break;
      case 'turn_start': S.progress[ev.speaker] = 'active'; if (here) startLive(ev.speaker); renderPeople(); break;
      case 'route': if (here && S.live?.speaker === ev.speaker) { S.live.text = ''; S.live.route = ev.provider; paintLive(); } break;
      case 'delta': if (here && S.live?.speaker === ev.speaker) { S.live.text += ev.text; schedulePaint(); } break;
      case 'turn_end':
        S.progress[ev.speaker] = ev.message.status === 'complete' ? 'done' : 'fail';
        if (here && !S.chat.messages.some((m) => m.id === ev.message.id)) { finishLive(ev.message); S.chat.messages.push(ev.message); }
        else if (here) { $('#live')?.remove(); S.live = null; }
        renderPeople(); syncComposer(); break;
      case 'turn_drop': if (here) { $('#live')?.remove(); S.live = null; } break;
      case 'usage_changed': if (here && ev.usage) setUsage(ev.usage); break;
      case 'run_end': {
        S.running = false; S.runChat = null;
        if (here && ev.usage) setUsage(ev.usage);
        if (ev.status === 'error' || ev.status === 'partial') toast(ev.text, ev.status === 'error' ? 'err' : '');
        else if (ev.status === 'cancelled') toast(ev.text);
        renderPeople(); syncComposer(); refreshChats();
        setTimeout(() => { if (!S.running) { S.progress = {}; renderPeople(); } }, 2500);
        if (!here && ev.chat > 0 && ev.status === 'complete') toast('另一个讨论有新回复', '', { label: '去看看', run: () => selectChat(ev.chat) });
        break;
      }
      case 'chats_changed': clearTimeout(S.chatsTimer); S.chatsTimer = setTimeout(refreshChats, 200); break;
      case 'settings_changed': reloadBoot(); break;
    }
  }
  function connectEvents() {
    const es = new EventSource('/events');
    let lost = false;
    es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    es.onopen = () => { if (lost) { lost = false; toast('已重新连接', 'ok'); loadChat(S.chatId); refreshChats(); } };
    es.onerror = () => { if (!lost) { lost = true; setTimeout(() => { if (lost) toast('与本机程序的连接断开了，正在重连…', 'err'); }, 2500); } };
  }

  async function reloadBoot() {
    S.boot = await api('/api/bootstrap');
    renderRail(); renderHead(); renderPeople(); syncComposer();
    if (S.chat && !S.chat.messages.length && !S.running) renderThread();
    renderList();
  }

  // ---------- loading a chat ----------
  async function loadChat(id) {
    const token = ++S.loadToken;
    const chat = await api('/api/chat/' + id);
    if (token !== S.loadToken) return;
    S.chatId = id; S.chat = chat; prefs.set('chat', id);
    if (chat.live) { S.progress[chat.live.speaker] = 'active'; }
    renderHead(); renderPeople(); renderThread(); renderList(); syncComposer();
  }

  // ---------- dialogs ----------
  function openMember(name) {
    const m = memberOf(name);
    const route = m.route ? lineName(m.route) + (isBackup(m.route) ? '（备用线路）' : '（主线路）') : '尚未配置';
    const d = modal({ title: '', foot: false, body: `<button class="icon-btn" data-close type="button" aria-label="关闭" style="position:absolute;right:12px;top:12px">${icon('x')}</button><div class="member-card">${avatar(name, 72)}<h3>${esc(m.display)}</h3><div class="hint">AI 成员</div>
      <div class="bio">${esc(m.bio)}</div>
      <div class="box"><small>讨论分工</small>${esc(m.role)}</div>
      <div class="box"><small>当前线路</small>${esc(route)}<div class="hint" style="margin-top:2px">每次新请求优先走主线路，出现故障时自动换到下一条线路的同一个模型。</div></div>
      <div style="display:flex;gap:10px;margin-top:16px"><button class="btn primary" style="flex:1" data-direct>${icon('chat')}单独聊天</button><button class="btn" style="flex:1" data-mention>@ 它加入群聊</button></div></div>` });
    $('[data-direct]', d.el).onclick = () => { d.close(); directChat(name); };
    $('[data-mention]', d.el).onclick = async () => {
      d.close();
      if (isDirect()) { const g = S.chats.find((c) => !c.target); await (g ? selectChat(g.id) : newChat()); }
      const t = input(); t.value = (t.value + (t.value && !t.value.endsWith(' ') ? ' ' : '') + '@' + name + ' '); t.focus(); autosize(); syncComposer();
    };
  }

  function openImage() {
    if (S.running) { toast('正在回复中，请稍等或先停止。'); return; }
    if (!S.boot.connected) { toast('请先在设置里填写密钥。', 'err'); openSettings('connect'); return; }
    let size = S.boot.image_sizes[0];
    const shapes = { '1024x1024': ['方形', 22, 22], '1536x1024': ['横版', 28, 19], '1024x1536': ['竖版', 19, 28] };
    const d = modal({ title: '生成图片', body: `<label class="field"><span>描述你想要的画面</span><textarea class="textarea" id="imgPrompt" rows="4" placeholder="例如：清晨的老城区，一张木质圆桌，三把不同颜色的椅子，柔和的光线，插画风格"></textarea></label>
      <div class="field" style="margin-bottom:6px"><span>画幅</span><div class="sizes">${S.boot.image_sizes.map((s) => `<button type="button" class="size-opt ${s === size ? 'on' : ''}" data-size="${s}"><i style="width:${shapes[s][1]}px;height:${shapes[s][2]}px"></i>${shapes[s][0]}</button>`).join('')}</div></div>
      <p class="hint">按连接设置里的线路生成（内置线路自动使用 GPT Image 2，自定义线路需填写生图模型 ID）。结果保存在当前讨论里，之后可以请大家一起点评。生成可能需要几分钟；超时后不会自动重复提交，以免重复扣费。</p>` });
    d.foot.innerHTML = `<button class="btn" data-close type="button">取消</button><button class="btn primary" id="imgGo" type="button">${icon('sparkles')}开始生成</button>`;
    d.body.addEventListener('click', (e) => { const b = e.target.closest('[data-size]'); if (b) { size = b.dataset.size; $$('.size-opt', d.body).forEach((x) => x.classList.toggle('on', x === b)); } });
    const go = async () => {
      const prompt = $('#imgPrompt').value.trim();
      if (!prompt) { $('#imgPrompt').focus(); return; }
      try { await api('/api/image', { chat: S.chatId, prompt, size }); d.close(); S.running = true; S.runChat = S.chatId; syncComposer(); }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#imgGo').onclick = go;
    $('#imgPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) go(); });
    $('#imgPrompt').focus();
  }

  // ---- settings ----
  function openSettings(tab = 'connect') {
    const b = S.boot;
    const D = { limits: { chat: b.limits_tokens.chat ?? '', write: b.limits_tokens.write ?? '' }, keys: {}, lines: JSON.parse(JSON.stringify(b.lines)), nickname: b.profile.nickname, bio: b.profile.bio, share: b.profile.share_bio, roles: {} };
    for (const m of b.members) D.roles[m.name] = m.role;
    for (const l of b.lines) D.keys[l.id] = null;
    const hasKey = (l) => (D.keys[l.id] === null ? l.configured : !!D.keys[l.id].trim());
    const tabs = [['connect', '连接', 'lock'], ['profile', '我的资料', 'user'], ['members', 'AI 成员', 'users'], ['general', '外观与偏好', 'palette'], ['usage', '用量明细', 'chart']];
    const d = modal({ foot: false, cls: 'wide', closable: true, body: '' });
    d.el.querySelector('.modal-body').remove();
    d.el.innerHTML = `<div class="settings"><nav><h3>设置</h3>${tabs.map(([k, l, i]) => `<button type="button" data-tab="${k}">${icon(i)}${l}</button>`).join('')}</nav>
      <div class="pane"><button class="icon-btn" data-close type="button" aria-label="关闭" style="position:absolute;right:14px;top:14px;z-index:2">${icon('x')}</button><div class="pane-body" id="paneBody"></div><div class="modal-foot" id="paneFoot"></div></div></div>`;
    const body = $('#paneBody', d.el), foot = $('#paneFoot', d.el);
    let current = tab;

    const panes = {
      connect() {
        const ready = D.lines.filter(hasKey);
        const roleOf = (l) => (!hasKey(l) ? '' : ready[0] === l ? '主线路' : '备用线路');
        const field = (label, attrs, value, ph) => `<label class="field" style="margin-bottom:10px"><span>${label}</span><input class="input" ${attrs} value="${esc(value || '')}" placeholder="${esc(ph || '')}" autocomplete="off" spellcheck="false"></label>`;
        const card = (l, n) => {
          const role = roleOf(l);
          const head = `<div class="top"><span class="grip" data-grip="${l.id}" data-tip="按住拖动调整优先级">${icon('grip')}</span><b>${esc(l.custom ? l.name || '自定义线路' : l.name)}</b>${role ? `<span class="badge">${role}</span>` : ''}<span class="badge ${hasKey(l) ? 'ok' : 'no'}" id="st-${l.id}">${hasKey(l) ? '已配置' : '未配置'}</span>
            <span style="margin-left:auto;display:flex;gap:2px"><button class="icon-btn" type="button" data-up="${l.id}" ${n === 0 ? 'disabled style="opacity:.3"' : ''} data-tip="提高优先级">${icon('down', 'flip')}</button><button class="icon-btn" type="button" data-down="${l.id}" ${n === D.lines.length - 1 ? 'disabled style="opacity:.3"' : ''} data-tip="降低优先级">${icon('down')}</button></span></div>`;
          const keyBox = `<div class="input-wrap"><input class="input" type="password" data-key="${l.id}" autocomplete="off" spellcheck="false" placeholder="${l.configured ? '已保存 ' + esc(l.mask) + '，粘贴新密钥可替换' : '粘贴 API 密钥'}"><button class="icon-btn" type="button" data-eye="${l.id}" aria-label="显示或隐藏">${icon('eye')}</button></div>`;
          const warn = l.key_error ? `<div class="notice" style="margin-top:10px">${icon('alert')}<span>原来保存的密钥无法解密（可能换了 Windows 账户），请重新填写。</span></div>` : '';
          const clear = l.configured ? `<div style="margin-top:8px"><button class="btn small" type="button" data-clear="${l.id}">清除已保存的密钥</button></div>` : '';
          if (!l.custom) return `<div class="card" data-card-line="${l.id}">${head}${keyBox}${warn}${clear}</div>`;
          const used = l.configured || l.base_url || Object.values(l.models).some(Boolean) || l.image_model;
          return `<div class="card" data-card-line="${l.id}">${head}
            ${used ? '' : `<button class="btn small" type="button" data-expand="${l.id}">＋ 添加这条自定义线路</button>`}
            <div class="${used ? '' : 'hidden'}" data-body="${l.id}">
              ${field('显示名称', `data-f="name" data-line="${l.id}" maxlength="20"`, l.name, '例如：公司网关')}
              ${field('接口地址（OpenAI 兼容）', `data-f="base_url" data-line="${l.id}"`, l.base_url, 'https://api.example.com/v1')}
              <div class="field" style="margin-bottom:10px"><span>API 密钥</span>${keyBox}</div>${warn}
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
                ${core3(l)}
              </div>
              ${field('生图模型 ID（可选）', `data-f="image_model" data-line="${l.id}"`, l.image_model, '例如：gpt-image-1')}
              <p class="hint">在这条线路上，哪位成员填了模型 ID，才会走这条线路；留空则跳过。按 OpenAI 兼容接口（/chat/completions）发送，图片可用，视频只有内置线路的 Gemini 能直接看。没有公开价格，费用会显示为「待核对」。</p>
              ${clear}
            </div></div>`;
        };
        const core3 = (l) => ['Claude', 'GPT', 'Gemini'].map((m) => `<label class="field" style="margin:0"><span>${m} 模型 ID</span><input class="input" data-f="model" data-member="${m}" data-line="${l.id}" value="${esc(l.models[m] || '')}" placeholder="${{ Claude: 'claude-…', GPT: 'gpt-…', Gemini: 'gemini-…' }[m]}" autocomplete="off" spellcheck="false"></label>`).join('');
        body.innerHTML = `<h4>连接</h4><p class="desc">三位成员共用这些线路：从上到下依次尝试，排在最上面、已配置的那条就是主线路。超时、限流、额度不足或模型不可用时，自动换到下一条线路的同一个成员，成员身份和上下文不变。至少配置一条即可使用。按住卡片左上角的 ⋮⋮ 上下拖动，或点右侧箭头，即可调整优先级。</p>
          ${D.lines.map(card).join('')}
          <div style="display:flex;align-items:center;gap:12px;margin:4px 0 6px"><button class="btn" type="button" id="checkBtn">检查已填写的线路</button><span class="hint">只读取模型目录，不发送聊天，不产生费用。</span></div>
          <div class="check-rows" id="checkRows"></div>
          <div class="card" style="margin-top:18px"><div class="top"><b>回复长度上限</b></div>
            <p class="hint" style="margin:0 0 12px">每位 AI 一次最多能写多少，单位是 token（1 个汉字大约 1 到 1.5 个 token）。写长篇时调大一点；留空就用默认值。
              数字太大、超过所用模型的能力时，平台会报错，调小一点即可。</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <label class="field" style="margin:0"><span>写作时的上限（默认 ${b.limits_tokens.write_default}）</span><input class="input" id="limWrite" inputmode="numeric" placeholder="${b.limits_tokens.write_default}" value="${esc(String(D.limits.write))}"></label>
              <label class="field" style="margin:0"><span>聊天时的上限（默认 ${b.limits_tokens.chat_default}）</span><input class="input" id="limChat" inputmode="numeric" placeholder="${b.limits_tokens.chat_default}" value="${esc(String(D.limits.chat))}"></label></div>
            <p class="hint" style="margin-top:10px">说明：Claude 必须有一个明确的上限，所以默认是上面的数字；GPT 和 Gemini 不填时用平台自己的上限。你填了数字，三家都会按它限制。</p></div>
          <div class="card" style="margin-top:18px"><div class="top"><b>自动安排</b></div><div class="hint" style="font-size:13.5px;line-height:1.9">
            看图：参与讨论的成员直接查看<br>看视频：Gemini 先分析，再由其他成员接着讨论（需要内置线路）<br>生图：内置线路使用 GPT Image 2，自定义线路用你填的生图模型<br>密钥只保存在本机，并用当前 Windows 用户加密；聊天记录本身不加密。</div></div>`;
        $('#limWrite', body).oninput = (e) => { D.limits.write = e.target.value.trim(); };
        $('#limChat', body).oninput = (e) => { D.limits.chat = e.target.value.trim(); };
        $$('[data-key]', body).forEach((el) => { el.value = D.keys[el.dataset.key] ?? ''; el.oninput = () => { D.keys[el.dataset.key] = el.value; const l = D.lines.find((x) => x.id === el.dataset.key); const st = $(`#st-${l.id}`, body); st.textContent = hasKey(l) ? '已配置' : '未配置'; st.className = 'badge ' + (hasKey(l) ? 'ok' : 'no'); }; });
        $$('[data-f]', body).forEach((el) => el.oninput = () => {
          const l = D.lines.find((x) => x.id === el.dataset.line);
          if (el.dataset.f === 'model') l.models[el.dataset.member] = el.value; else l[el.dataset.f] = el.value;
        });
        $$('[data-eye]', body).forEach((el) => el.onclick = () => { const i = $(`[data-key="${el.dataset.eye}"]`, body); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; el.innerHTML = icon(show ? 'eyeOff' : 'eye'); });
        $$('[data-expand]', body).forEach((el) => el.onclick = () => { el.classList.add('hidden'); $(`[data-body="${el.dataset.expand}"]`, body).classList.remove('hidden'); });
        // drag a card by its grip: whichever line ends up on top becomes the primary line
        $$('[data-grip]', body).forEach((grip) => grip.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const id = grip.dataset.grip, source = grip.closest('.card');
          let moved = false, spot = null;
          const clear = () => $$('[data-card-line]', body).forEach((c) => c.classList.remove('drop-before', 'drop-after', 'dragging'));
          const move = (ev) => {
            if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
            if (!moved) { moved = true; source.classList.add('dragging'); document.body.style.cursor = 'grabbing'; }
            const box = body.getBoundingClientRect();
            if (ev.clientY < box.top + 40) body.scrollTop -= 14; else if (ev.clientY > box.bottom - 40) body.scrollTop += 14;
            const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-card-line]');
            $$('[data-card-line]', body).forEach((c) => c.classList.remove('drop-before', 'drop-after'));
            spot = null;
            if (over && over !== source) {
              const r = over.getBoundingClientRect(), after = ev.clientY > r.top + r.height / 2;
              over.classList.add(after ? 'drop-after' : 'drop-before'); spot = { id: over.dataset.cardLine, after };
            }
          };
          const up = () => {
            window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
            document.body.style.cursor = ''; clear();
            if (!moved || !spot) return;
            const line = D.lines.find((x) => x.id === id), rest = D.lines.filter((x) => x.id !== id);
            rest.splice(rest.findIndex((x) => x.id === spot.id) + (spot.after ? 1 : 0), 0, line);
            D.lines = rest; panes.connect();
          };
          window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
        }));
        $$('[data-up],[data-down]', body).forEach((el) => el.onclick = () => {
          const id = el.dataset.up || el.dataset.down, n = D.lines.findIndex((x) => x.id === id), m = n + (el.dataset.up ? -1 : 1);
          if (m < 0 || m >= D.lines.length) return;
          [D.lines[n], D.lines[m]] = [D.lines[m], D.lines[n]]; panes.connect();
        });
        $$('[data-clear]', body).forEach((el) => el.onclick = async () => {
          const l = D.lines.find((x) => x.id === el.dataset.clear);
          if (await confirmBox({ title: '清除 ' + l.name + ' 的密钥？', text: '清除后这条线路将不可用，点击「保存」后生效。', ok: '清除', danger: true })) { D.keys[l.id] = ''; panes.connect(); }
        });
        $('#checkBtn', body).onclick = async (e) => {
          const btn = e.currentTarget; btn.disabled = true; btn.textContent = '正在检查…';
          const custom = {};
          for (const l of D.lines.filter((x) => x.custom)) custom[l.id] = { base_url: l.base_url, models: l.models, image_model: l.image_model };
          try {
            const res = await api('/api/check', { keys: D.keys, custom });
            $('#checkRows', body).innerHTML = res.map((r) => `<div class="check-row ${r.ok === null ? 'skip' : r.ok ? 'ok' : 'bad'}">${icon(r.ok === null ? 'info' : r.ok ? 'check' : 'alert')}<span>${r.provider ? `<b>${esc(r.provider)}</b>　` : ''}${esc(r.message)}</span></div>`).join('');
          } catch (err) { toast(err.message, 'err'); }
          btn.disabled = false; btn.textContent = '检查已填写的线路';
        };
      },
      profile() {
        body.innerHTML = `<h4>我的资料</h4><p class="desc">头像和昵称显示在你发出的消息上。是否把简介告诉 AI，由你决定。</p>
          <div class="profile-row"><span id="avHold">${avatar('你', 72)}</span><div style="display:flex;gap:8px"><button class="btn" type="button" id="avPick">更换头像</button>${b.profile.avatar ? '<button class="btn" type="button" id="avClear">移除</button>' : ''}<input type="file" id="avFile" accept="image/*" hidden></div></div>
          <label class="field"><span>昵称</span><input class="input" id="nick" maxlength="30" value="${esc(D.nickname)}"></label>
          <label class="field"><span>个人简介</span><textarea class="textarea" id="bio" rows="5" placeholder="例如：独立开发者，正在做一个桌面小应用；偏好直接、具体的建议。">${esc(D.bio)}</textarea></label>
          <label class="switch" style="margin:4px 0 10px"><input type="checkbox" id="share" ${D.share ? 'checked' : ''}><span class="track"></span><span>把我的简介提供给 AI，作为讨论背景</span></label>
          <p class="hint">默认不提供。头像只用于本机界面，不会发送给任何平台。</p>`;
        $('#nick', body).oninput = (e) => { D.nickname = e.target.value; };
        $('#bio', body).oninput = (e) => { D.bio = e.target.value; };
        $('#share', body).onchange = (e) => { D.share = e.target.checked; };
        $('#avPick', body).onclick = () => $('#avFile', body).click();
        $('#avFile', body).onchange = async (e) => {
          const f = e.target.files[0]; if (!f) return;
          try { await api('/api/avatar', f); await reloadBoot(); toast('头像已更新', 'ok'); panes.profile(); }
          catch (err) { toast('头像读取失败：' + err.message, 'err'); }
        };
        $('#avClear', body)?.addEventListener('click', async () => { await api('/api/avatar/clear', {}); await reloadBoot(); panes.profile(); });
      },
      members() {
        body.innerHTML = `<h4>AI 成员</h4><p class="desc">模型身份固定，不会因为分工或线路变化而改变。你可以调整每位成员在讨论里的分工。</p>
          ${b.members.map((m) => `<div class="card"><div class="top">${avatar(m.name, 40)}<div><b>${esc(m.display)}</b><div class="hint">${esc(m.bio)}</div></div></div>
            <label class="field" style="margin:0"><span>讨论分工</span><textarea class="textarea" data-role="${m.name}" rows="3">${esc(D.roles[m.name])}</textarea></label>
            <div style="margin-top:8px"><button class="btn small" type="button" data-reset="${m.name}">恢复默认分工</button></div></div>`).join('')}`;
        $$('[data-role]', body).forEach((el) => el.oninput = () => { D.roles[el.dataset.role] = el.value; });
        $$('[data-reset]', body).forEach((el) => el.onclick = () => { const n = el.dataset.reset; D.roles[n] = memberOf(n).default_role; $(`[data-role="${n}"]`, body).value = D.roles[n]; });
      },
      general() {
        const theme = prefs.get('theme', 'auto'), key = sendKeyMode();
        body.innerHTML = `<h4>外观与偏好</h4><p class="desc">这些选项只保存在本机，立即生效。</p>
          <div class="field"><span>主题</span><div class="seg" data-seg="theme">${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, l]) => `<button type="button" data-v="${v}" class="${theme === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          <div class="field"><span>发送方式</span><div class="seg" data-seg="sendKey">${[['enter', 'Enter 发送'], ['ctrl', 'Ctrl + Enter 发送']].map(([v, l]) => `<button type="button" data-v="${v}" class="${key === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          <div class="card" style="margin-top:22px"><div class="top"><b>关于 AI 圆桌 ${esc(b.version)}</b></div><div class="hint" style="font-size:13.5px;line-height:1.9">聊天记录、附件、用量和加密后的密钥都保存在程序文件夹的 data 目录。<br>备份或迁移时，复制整个 data 文件夹即可（密钥只能在同一个 Windows 账户下解密）。<br>品牌图标来自 LobeHub Icons（MIT）。</div></div>`;
        $$('[data-seg]', body).forEach((seg) => seg.onclick = (e) => {
          const btn = e.target.closest('button'); if (!btn) return;
          $$('button', seg).forEach((x) => x.classList.toggle('on', x === btn));
          prefs.set(seg.dataset.seg, btn.dataset.v);
          if (seg.dataset.seg === 'theme') { ui.applyTheme(); renderRail(); } else syncComposer();
        });
      },
      async usage() {
        body.innerHTML = '<h4>用量明细</h4><p class="desc">10 美元 = 1000 积分。只统计本软件发起的调用；主线路和备用线路的每次尝试分别记录。</p><div class="hint">正在读取…</div>';
        let u;
        try { u = await api('/api/usage'); } catch (e) { body.innerHTML += esc(e.message); return; }
        if (current !== 'usage') return;
        body.innerHTML = `<h4>用量明细</h4><p class="desc">10 美元 = 1000 积分。只统计本软件发起的调用；主线路和备用线路的每次尝试分别记录。<b>≈</b> 表示按平台公开价的估算（默认分组），<b>*</b> 表示还有待核对的调用；实际扣费以平台账单为准。</p>
          <div class="stat-row">${[['今日', u.today], ['累计', u.total]].map(([l, t]) => `<div class="stat"><small>${l}</small><b>${t.credits === null ? (t.pending ? '待核对' : '0.00') : (t.estimated ? '≈ ' : '') + t.credits.toFixed(2)}<small>${t.credits === null && t.pending ? '' : '积分'}</small></b>${t.pending && t.credits !== null ? `<small>另有 ${t.pending} 笔待核对</small>` : t.pending ? `<small>${t.pending} 笔暂无法计费</small>` : ''}</div>`).join('')}<div class="stat"><small>调用次数</small><b>${u.count}</b></div></div>
          ${u.items.length ? `<div class="rows">${u.items.map((r) => `<div class="urow" data-rec="${r.id}"><span class="l1">${esc(r.member)} · ${esc(r.kind)}</span>
            <span class="cost">${r.credits === null ? '<span style="color:var(--warn)">待核对</span>' : r.credits.toFixed(3) + ' 积分'}<small>${r.credits === null ? esc(r.status) : esc(r.basis)}</small></span>
            <span class="l2">${new Date(r.created * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${esc(r.provider)} · ${esc(r.status)} · ${esc(r.chat_title)}</span></div>`).join('')}</div>` : '<div class="empty-list">还没有调用记录</div>'}
          ${u.count > u.items.length ? `<p class="hint" style="margin-top:10px">显示最近 ${u.items.length} 笔；累计包含全部记录。</p>` : ''}`;
        $$('[data-rec]', body).forEach((el) => el.onclick = () => recordDetail(u.items.find((x) => x.id === el.dataset.rec), () => panes.usage()));
      },
    };
    function show(key) {
      current = key;
      $$('nav [data-tab]', d.el).forEach((x) => x.classList.toggle('on', x.dataset.tab === key));
      const editable = ['connect', 'profile', 'members'].includes(key);
      foot.innerHTML = editable ? `<span class="left">${icon('lock')}密钥仅在本机加密保存</span><button class="btn" data-close type="button">取消</button><button class="btn primary" id="saveBtn" type="button">保存</button>` : `<button class="btn" data-close type="button">关闭</button>`;
      $('#saveBtn', foot)?.addEventListener('click', save);
      body.scrollTop = 0; panes[key]();
    }
    async function save() {
      const payload = { limits: D.limits, platforms: {}, custom: {}, line_order: D.lines.map((l) => l.id), profile: { nickname: D.nickname, bio: D.bio, share_bio: D.share }, members: {} };
      for (const l of D.lines) {
        if (l.custom) payload.custom[l.id] = { name: l.name, base_url: l.base_url, models: l.models, image_model: l.image_model, key: D.keys[l.id] };
        else if (D.keys[l.id] !== null) payload.platforms[l.id] = { key: D.keys[l.id] };
      }
      for (const n of Object.keys(D.roles)) payload.members[n] = { role: D.roles[n] };
      try {
        S.boot = await api('/api/settings', payload);
        d.close(); renderRail(); renderHead(); renderPeople(); syncComposer(); refreshChats();
        if (S.chat && !S.chat.messages.length) renderThread();
        toast('设置已保存', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }
    d.el.addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) show(t.dataset.tab); });
    show(tab);
  }

  function recordDetail(r, done) {
    const d = modal({ title: '调用记录', body: `<dl class="kv"><dt>成员 / 类型</dt><dd>${esc(r.member)} · ${esc(r.kind)}</dd><dt>线路 / 模型</dt><dd>${esc(r.provider)} / ${esc(r.model)}</dd><dt>状态</dt><dd>${esc(r.status)}</dd>
      <dt>计费</dt><dd>${r.credits === null ? '待核对' : r.credits.toFixed(4) + ' 积分 · ' + esc(r.basis)}</dd><dt>备注</dt><dd>${esc(r.note || '—')}</dd><dt>所属讨论</dt><dd>${esc(r.chat_title)}</dd></dl>
      <pre class="json">${esc(JSON.stringify(r.usage, null, 2))}</pre>
      <label class="field"><span>按平台账单核对：填写这一次请求的实际扣费（美元），不要填账户余额变化</span><input class="input" id="usd" inputmode="decimal" placeholder="例如 0.0123"></label>` });
    d.foot.innerHTML = '<button class="btn" data-close type="button">关闭</button><button class="btn primary" id="recGo" type="button">保存核对结果</button>';
    $('#recGo', d.foot).onclick = async () => {
      const usd = parseFloat($('#usd', d.body).value);
      if (!(usd >= 0)) { toast('请填写有效的美元金额。', 'err'); return; }
      try { await api('/api/usage/reconcile', { id: r.id, usd }); d.close(); toast('已按账单核对', 'ok'); done(); if (S.chat) { const u = await api('/api/chat/' + S.chatId); setUsage(u.usage); } }
      catch (e) { toast(e.message, 'err'); }
    };
  }

  // ---------- wiring ----------
  function bindShell() {
    $('#newChat').onclick = newChat;
    $('#search').oninput = (e) => { S.query = e.target.value; renderList(); };
    $('#chats').addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]');
      if (more) { e.stopPropagation(); chatMenu(more, +more.dataset.more, { align: 'right' }); return; }
      const item = e.target.closest('.chat-item'); if (item) selectChat(+item.dataset.id);
    });
    $('#chats').addEventListener('contextmenu', (e) => { const item = e.target.closest('.chat-item'); if (item) { e.preventDefault(); chatMenu({ x: e.clientX, y: e.clientY }, +item.dataset.id); } });
    document.querySelector('.quick').addEventListener('click', (e) => { const b = e.target.closest('[data-direct]'); if (b) directChat(b.dataset.direct); });

    $('#people').addEventListener('click', async (e) => {
      if (suppressClick) return;
      const card = e.target.closest('[data-card]');
      if (card) { openMember(card.dataset.card); return; }
      const chip = e.target.closest('[data-chip]');
      if (chip && !isDirect() && !S.running) {
        const name = chip.dataset.chip, was = isMuted(name);
        if (!was && S.boot.members.filter((x) => !isMuted(x.name)).length === 1) { toast('至少让一位 AI 发言。'); return; }
        S.chat.muted = was ? S.chat.muted.filter((n) => n !== name) : [...S.chat.muted, name];
        renderPeople(); syncComposer();
        try { await api(`/api/chat/${S.chatId}/mute`, { name, muted: !was }); }
        catch (err) { S.chat.muted = was ? [...S.chat.muted, name] : S.chat.muted.filter((n) => n !== name); renderPeople(); syncComposer(); toast(err.message, 'err'); }
      }
    });
    // Reorder by dragging a name (pointer events: reliable in any window, unlike native drag-and-drop).
    const people = $('#people');
    let press = null;
    const clearMarks = () => $$('.chip', people).forEach((c) => c.classList.remove('dragging', 'drop-before', 'drop-after'));
    const dropSpot = (e) => {
      const c = document.elementFromPoint(e.clientX, e.clientY)?.closest('#people [data-chip]');
      if (!c || c.dataset.chip === press.name) return null;
      const r = c.getBoundingClientRect();
      return { name: c.dataset.chip, after: e.clientX > r.left + r.width / 2, el: c };
    };
    people.addEventListener('pointerdown', (e) => {
      const c = e.target.closest('[data-chip]');
      if (e.button !== 0 || !c || isDirect() || S.running) return;
      press = { name: c.dataset.chip, x: e.clientX, y: e.clientY, active: false, el: c };
    });
    window.addEventListener('pointermove', (e) => {
      if (!press) return;
      if (!press.active) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
        press.active = true; press.el.classList.add('dragging'); document.body.style.cursor = 'grabbing';
      }
      const spot = dropSpot(e);
      $$('.chip', people).forEach((c) => c.classList.remove('drop-before', 'drop-after'));
      if (spot) spot.el.classList.add(spot.after ? 'drop-after' : 'drop-before');
    });
    window.addEventListener('pointerup', async (e) => {
      if (!press) return;
      const { name, active } = press, spot = active ? dropSpot(e) : null;
      press = null; document.body.style.cursor = '';
      if (!active) return;
      clearMarks();
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
      if (!spot) return;
      const before = S.chat.order.slice(), next = before.filter((n) => n !== name);
      next.splice(next.indexOf(spot.name) + (spot.after ? 1 : 0), 0, name);
      if (next.join() === before.join()) return;
      S.chat.order = next; renderPeople();
      try { await api(`/api/chat/${S.chatId}/order`, { order: next }); }
      catch (err) { S.chat.order = before; renderPeople(); toast(err.message, 'err'); }
    });
    $('#people').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-chip]')) { e.preventDefault(); e.target.click(); } });

    const thread = $('#thread');
    thread.addEventListener('click', async (e) => {
      const z = e.target.closest('[data-zoom]');
      if (z) { const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${esc(z.src)}" alt="">`; lb.onclick = () => lb.remove(); document.body.append(lb); return; }
      const idea = e.target.closest('[data-idea]'); if (idea) { input().value = idea.dataset.idea; input().focus(); autosize(); syncComposer(); return; }
      if (e.target.closest('[data-open-settings]')) { openSettings('connect'); return; }
      const cc = e.target.closest('[data-copy-code]');
      if (cc) { copyText(cc.closest('.code').querySelector('code').textContent, cc); return; }
      const msg = e.target.closest('.msg');
      const retry = e.target.closest('[data-retry]');
      if (retry) {
        try { await api('/api/retry', { chat: S.chatId, message: +retry.dataset.retry }); S.chat.messages = S.chat.messages.filter((m) => m.id !== +retry.dataset.retry); msg?.remove(); S.running = true; S.runChat = S.chatId; syncComposer(); }
        catch (err) { toast(err.message, 'err'); }
        return;
      }
      if (!msg) return;
      const bubble = msg.querySelector('.bubble');
      if (e.target.closest('[data-copy]') && bubble) copyText(bubble.innerText, e.target.closest('[data-copy]'));
      if (e.target.closest('[data-quote]') && bubble) {
        const who = displayName(msg.dataset.speaker), t = input();
        t.value = (t.value ? t.value + '\n' : '') + '> ' + who + '：' + bubble.innerText.trim().slice(0, 1500).replace(/\n/g, '\n> ') + '\n\n';
        t.focus(); t.setSelectionRange(t.value.length, t.value.length); autosize(); syncComposer();
      }
    });
    scroller().addEventListener('scroll', () => { if (nearBottom()) $('#toBottom').classList.add('hidden'); S.stick = nearBottom(); });
    $('#toBottom').onclick = () => { S.stick = true; scrollBottom(true); };

    const t = input();
    t.addEventListener('input', () => { autosize(); syncComposer(); mentionIndex = 0; renderMention(); });
    t.addEventListener('click', renderMention);
    t.addEventListener('keydown', (e) => {
      const box = $('#mention');
      if (!box.classList.contains('hidden')) {
        const items = $$('button', box);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; renderMention(); return; }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) { e.preventDefault(); pickMention(items[mentionIndex].dataset.mention); return; }
        if (e.key === 'Escape') { e.preventDefault(); box.classList.add('hidden'); return; }
      }
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      const wantsSend = sendKeyMode() === 'enter' ? !e.shiftKey && !e.ctrlKey && !e.altKey : (e.ctrlKey || e.metaKey);
      if (wantsSend) { e.preventDefault(); sendMessage(); }
    });
    t.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => /^(image|video)\//.test(f.type));
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    $('#mention').addEventListener('mousedown', (e) => { const b = e.target.closest('[data-mention]'); if (b) { e.preventDefault(); pickMention(b.dataset.mention); } });
    $('#sendBtn').onclick = () => (S.running ? stopRun() : sendMessage());
    $('#attachBtn').onclick = () => $('#file').click();
    $('#file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
    $('#imageBtn').onclick = openImage;
    $('#thumbs').addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-rm]'); if (!rm) return;
      const [item] = S.pending.splice(+rm.dataset.rm, 1); renderThumbs();
      try { await api('/api/upload/discard', { id: item.id }); } catch (err) { /* file is cleaned up at next start anyway */ }
    });
    $('#targetBtn').onclick = (e) => menu(e.currentTarget, [
      { label: '这条消息发给', icon: null },
      { label: '大家（按顺序发言）', icon: 'users', current: S.target === 'all', run: () => { S.target = 'all'; syncComposer(); } },
      ...MEMBERS.map((n) => ({ label: '只问 ' + memberOf(n).display, current: S.target === n, run: () => { S.target = n; syncComposer(); } })),
    ], { up: true });
    $('#roundsBtn').onclick = (e) => menu(e.currentTarget, [{ label: '每位成员发言几轮', icon: null }, ...[1, 2, 3].map((n) => ({ label: n + ' 轮' + (n === 1 ? '（默认）：各自独立说自己的想法' : '：先各自说想法，之后互相回应'), current: S.rounds === n, run: () => { S.rounds = n; syncComposer(); } }))], { up: true });

    // drag & drop
    const main = $('#main');
    let depth = 0;
    const overlay = () => main.querySelector('.drop-overlay');
    window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; if (!overlay()) main.insertAdjacentHTML('beforeend', '<div class="drop-overlay">松开即可添加' + (S.mode === 'write' ? '参考资料（文档、图片）' : '图片或视频') + '</div>'); } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay()?.remove(); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; overlay()?.remove(); if (e.dataTransfer?.files?.length) { if (S.mode === 'write' && window.Write) Write.addRefFiles([...e.dataTransfer.files]); else addFiles([...e.dataTransfer.files]); } });
  }

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    if (btn) { const old = btn.innerHTML; btn.textContent = '已复制'; setTimeout(() => { btn.innerHTML = old; }, 1200); }
  }

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === 'n') { e.preventDefault(); newChat(); }
    else if (e.key === 'k') { e.preventDefault(); $('#search').focus(); }
    else if (e.key === ',') { e.preventDefault(); openSettings('connect'); }
  });
  document.addEventListener('click', (e) => { const a = e.target.closest('.md a'); if (a && !/^https?:|^mailto:/.test(a.getAttribute('href') || '')) e.preventDefault(); });

  window.RT = { S, chatBadge, pickBadge, BADGE_N: [BADGE_ART.length, BADGE_HUE.length], avatar, displayName, isBackup, memberOf, openSettings: (tab) => openSettings(tab) };

  // ---------- start ----------
  async function start() {
    try {
      S.boot = await api('/api/bootstrap');
      history.replaceState(null, '', '/');
      renderShell(); renderRail();
      S.chats = await api('/api/chats');
      const saved = prefs.get('chat', null);
      let id = S.chats.find((c) => c.id === saved)?.id ?? S.chats[0]?.id;
      if (id === undefined) { id = (await api('/api/chat/new', {})).id; S.chats = await api('/api/chats'); }
      S.running = S.boot.busy; S.runChat = S.boot.run_chat;
      await loadChat(id);
      connectEvents();
      if (prefs.get('mode', 'chat') === 'write') setMode('write');
      if (!S.boot.connected && !S.chat.messages.length) setTimeout(() => toast('欢迎！先到「设置 → 连接」填入你的 API 密钥。'), 600);
    } catch (e) {
      $('#app').innerHTML = `<div style="grid-column:1/-1;display:grid;place-items:center;text-align:center;padding:40px"><div><img src="/logo.png?v=6" width="64" style="border-radius:18px"><h3>无法连接到本机程序</h3><p class="hint">${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">重试</button></div></div>`;
    }
  }
  start();
})();
