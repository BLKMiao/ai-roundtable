/* Shared UI helpers: icons, API client, toasts, menus, modals, tooltips, preferences. */
(function () {
  const esc = md.esc;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const PATHS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none"/>',
    clip: '<path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="9" r="1.7"/><path d="m21 15-4.5-4.5L6 21"/>',
    sparkles: '<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M19 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    sliders: '<path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1"/><circle cx="16" cy="6" r="2.2"/><circle cx="10" cy="12" r="2.2"/><circle cx="18" cy="18" r="2.2"/>',
    mute: '<path d="M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6"/>',
    grip: '<circle cx="9" cy="6" r="1.4" fill="currentColor"/><circle cx="15" cy="6" r="1.4" fill="currentColor"/><circle cx="9" cy="12" r="1.4" fill="currentColor"/><circle cx="15" cy="12" r="1.4" fill="currentColor"/><circle cx="9" cy="18" r="1.4" fill="currentColor"/><circle cx="15" cy="18" r="1.4" fill="currentColor"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
    chart: '<path d="M4 20V11M10 20V4M16 20v-6M22 20H2"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.6v.01"/>',
    arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.3 4-6 8-6s7 1.7 8 6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.7-3.6 3.2-5.5 6.5-5.5s5.8 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .6 3.3 2.3 3.7 5.2"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-1.5-1.4-1.6-1.4-3 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.01"/>',
  };
  const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;

  // ---- API ----
  async function api(path, body) {
    const init = {};
    if (body !== undefined) {
      init.method = 'POST';
      if (body instanceof Blob || body instanceof ArrayBuffer) init.body = body;
      else { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
    }
    let response;
    try { response = await fetch(path, init); }
    catch (e) { throw new Error('与本机程序的连接中断了。如果窗口刚被关闭，请重新打开 AI 圆桌。'); }
    let data = {};
    try { data = await response.json(); } catch (e) { /* empty body */ }
    if (!response.ok) { const err = new Error(data.error || '请求失败（' + response.status + '）'); err.code = data.code; throw err; }
    return data;
  }

  // ---- prefs (never required; storage may be blocked) ----
  const prefs = {
    get(key, fallback) { try { const v = localStorage.getItem('rt.' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem('rt.' + key, JSON.stringify(value)); } catch (e) { /* ignore */ } },
  };
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const pref = prefs.get('theme', 'auto');
    const theme = pref === 'auto' ? (media.matches ? 'dark' : 'light') : pref;
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');   // tints the app window's title bar
    if (meta) meta.content = theme === 'dark' ? '#0c0e14' : '#eceef3';
  }
  media.addEventListener('change', applyTheme);
  applyTheme();

  // ---- toasts ----
  function toast(text, kind = '', action) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = (kind === 'ok' ? icon('check') : kind === 'err' ? icon('alert') : '') + `<span>${esc(text)}</span>` + (action ? `<button type="button">${esc(action.label)}</button>` : '');
    if (action) el.querySelector('button').onclick = () => { action.run(); el.remove(); };
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 6500 : 3200);
  }

  // ---- menus ----
  let closeMenu = null;
  function menu(anchor, items, opts = {}) {
    if (closeMenu) closeMenu();
    const el = document.createElement('div');
    el.className = 'menu';
    el.innerHTML = items.map((it, n) => it === '-' ? '<hr>' : it.label && !it.run ? `<div class="sub">${esc(it.label)}</div>` :
      `<button type="button" data-n="${n}" class="${it.danger ? 'danger' : ''} ${it.current ? 'cur' : ''}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>${it.current ? icon('check', 'check') : ''}</button>`).join('');
    document.body.append(el);
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = opts.align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    let top = opts.up ? r.top - h - 6 : r.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
    el.style.left = left + 'px'; el.style.top = top + 'px';
    const off = (e) => { if (!el.contains(e.target)) close(); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    function close() { el.remove(); document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', key, true); closeMenu = null; }
    setTimeout(() => { document.addEventListener('mousedown', off, true); document.addEventListener('keydown', key, true); });
    el.addEventListener('click', (e) => { const b = e.target.closest('button[data-n]'); if (b) { close(); items[+b.dataset.n].run(); } });
    closeMenu = close;
    return close;
  }

  // ---- modals ----
  function modal({ title, body, foot, cls = '', onClose, closable = true }) {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${title ? `<div class="modal-head"><h3>${esc(title)}</h3>${closable ? `<button class="icon-btn" type="button" data-close aria-label="关闭">${icon('x')}</button>` : ''}</div>` : ''}<div class="modal-body"></div>${foot === false ? '' : '<div class="modal-foot"></div>'}</div>`;
    const box = scrim.firstElementChild;
    const bodyEl = $('.modal-body', box);
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
    const footEl = $('.modal-foot', box);
    const api = {
      el: box, body: bodyEl, foot: footEl,
      close() { document.removeEventListener('keydown', key, true); scrim.remove(); if (onClose) onClose(); },
    };
    function key(e) { if (e.key === 'Escape' && closable && !document.querySelector('.menu') && scrim === [...document.querySelectorAll('.scrim')].pop()) { e.stopPropagation(); api.close(); } }
    document.addEventListener('keydown', key, true);
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim && closable && !window.getSelection().toString()) api.close(); });
    scrim.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) api.close(); });
    document.body.append(scrim);
    return api;
  }
  function confirmBox({ title, text, ok = '确定', danger = false }) {
    return new Promise((resolve) => {
      const m = modal({ title, body: `<p class="hint" style="font-size:14px;margin:4px 0 8px">${esc(text)}</p>`, onClose: () => resolve(false) });
      m.foot.innerHTML = `<button class="btn" type="button" data-close>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-ok>${esc(ok)}</button>`;
      $('[data-ok]', m.foot).onclick = () => { resolve(true); m.close(); };
      $('[data-ok]', m.foot).focus();
    });
  }

  // ---- tooltips (data-tip) ----
  const tip = document.createElement('div');
  tip.className = 'tip';
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.classList.remove('show'); return; }
    if (!tip.isConnected) document.body.append(tip);
    tip.textContent = t.dataset.tip;
    const r = t.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    let left = t.dataset.tipSide === 'right' ? r.right + 8 : r.left + r.width / 2 - w / 2;
    let top = t.dataset.tipSide === 'right' ? r.top + r.height / 2 - h / 2 : r.bottom + 8;
    if (top + h > innerHeight - 6) top = r.top - h - 8;            // no room below (buttons at the bottom): show it above
    tip.style.left = Math.max(6, Math.min(left, innerWidth - w - 6)) + 'px';
    tip.style.top = Math.max(6, top) + 'px';
    tip.classList.add('show');
  });
  document.addEventListener('mousedown', () => tip.classList.remove('show'));

  // ---- time ----
  const pad = (n) => String(n).padStart(2, '0');
  function clock(ts) { const d = new Date(ts * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function short(ts) {
    const d = new Date(ts * 1000), now = new Date(), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 864e5);
    return diff <= 0 ? clock(ts) : diff === 1 ? '昨天' : diff < 7 ? '周' + '日一二三四五六'[d.getDay()] : (d.getMonth() + 1) + '/' + d.getDate();
  }
  function bucket(ts) {
    const d = new Date(ts * 1000), now = new Date(), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 864e5);
    return diff <= 0 ? '今天' : diff === 1 ? '昨天' : diff < 7 ? '最近 7 天' : diff < 30 ? '最近 30 天' : '更早';
  }

  window.ui = { $, $$, esc, icon, api, prefs, applyTheme, toast, menu, modal, confirmBox, clock, short, bucket };
})();
