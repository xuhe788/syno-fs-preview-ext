// content.js 1.2.0（稳定版）
// 变更要点：Plyr/HLS/CSS 通过 manifest 的 content_scripts 预注入；这里不再在运行时动态注入。
// 仍保留 page-hook 注入用于捕获“在新标签中播放/打开”的直链。
// 你的旧版 content.js 正是因为运行时注入 Plyr/HLS 被 DSM CSP 卡住，导致始终回退原生。  (参见你上传的旧版代码) 

(() => {
  'use strict';

  /** ======================== 域名启用控制（storage.local） ======================== **/
  const KEY = 'sites';  // [{ host: 'example.com', port?: '5001', enabled: true }]
  const loadSites = () => new Promise(r => chrome.storage.local.get(KEY, o => r(Array.isArray(o?.[KEY]) ? o[KEY] : [])));
  function isEnabledForHere(sites) {
    const hereHost = location.hostname;
    const herePort = location.port || undefined;
    return !!sites.find(s => s.enabled && s.host === hereHost && (!s.port || s.port === herePort));
  }

  /** ======================== 小提示 ======================== **/
  const toast = (msg, ok = true, ms = 1000) => {
    const id = 'fs_toast_min'; document.getElementById(id)?.remove();
    const d = document.createElement('div'); d.id = id;
    Object.assign(d.style, {
      position: 'fixed', left: '50%', top: '12px', transform: 'translateX(-50%)',
      background: ok ? 'rgba(0,128,0,.85)' : 'rgba(160,0,0,.85)', color: '#fff',
      padding: '6px 12px', borderRadius: '6px', zIndex: 2147483647, fontSize: '12px'
    });
    d.textContent = msg; (document.body || document.documentElement).appendChild(d);
    setTimeout(() => d.remove(), ms);
  };
  const debugToast = (m) => { try {
    const d=document.createElement('div');
    Object.assign(d.style,{position:'fixed',left:'50%',top:'8px',transform:'translateX(-50%)',background:'rgba(0,0,0,.65)',color:'#fff',padding:'4px 8px',borderRadius:'6px',zIndex:2147483647,fontSize:'12px',pointerEvents:'none'});
    d.textContent=m; (document.body||document.documentElement).appendChild(d);
    setTimeout(()=>d.remove(),1200);
  } catch(_){} };

  /** ======================== File Station 选择器与扩展名 ======================== **/
  const NAME_CELL_SELECTOR = '.x-grid3-cell-inner.x-grid3-col-filename, .x-grid3-col-filename .webfm-file-type-icon';
  const ROW_SELECTOR = '.x-grid3-row';
  const ROW_SELECTED = 'x-grid3-row-selected';

  const EXT = {
    video: /\.(mp4|mkv|avi|mov|flv|wmv|ts|m4v|webm|mpg|mpeg|m3u8)$/i,
    audio: /\.(mp3|aac|m4a|oga|ogg|wav|flac)$/i,
    image: /\.(jpg|jpeg|png|gif|webp|bmp|svg|heic|heif)$/i,
  };
  const ANY_MEDIA = /\.(mp4|mkv|avi|mov|flv|wmv|ts|m4v|webm|mpg|mpeg|m3u8|mp3|aac|m4a|oga|ogg|wav|flac|jpg|jpeg|png|gif|webp|bmp|svg|heic|heif)$/i;
  const HEIC_EXT = /\.(heic|heif)(\?|$)/i;

  /** ======================== 全局状态 ======================== **/
  const S = {
    list: [],
    lastCell: null,
    maskEl: null, wrapEl: null,
    videoEl: null, imgEl: null,
    player: null, usingPlyr: false,
    audioLayoutEl: null, audioMetaEl: null,
    audioRecordEl: null, audioCoverImgEl: null,
    audioTitleEl: null, audioDetailEl: null,
    audioCoverUrl: null,
    imageObjectUrl: null,

    keyDownHandler: null, keyUpHandler: null, keyPressHandler: null,
    selKeyHandler: null,
    ptrDownHandler: null, ptrUpHandler: null,

    lastKeyTs: 0,

    captureResolver: null, captureTimer: null,
    selObserver: null, selTimer: null,
    overlayToken: 0,
    navLock: false,

    // 预加载缓存与进行中标记
    preloads: new Map(), // url -> { kind, img?, el?, ts }
    preloading: new Set(), // url currently loading
    lastCapturedUrl: null,
  };

  /** ======================== DOM 工具 ======================== **/
  function getNameFromCell(target) {
    const cell = (target && target.closest) ? target.closest(NAME_CELL_SELECTOR) : null;
    if (!cell) return null;
    const host = cell.closest('.x-grid3-cell-inner') || cell;
    const q = host.getAttribute('ext:qtip');
    if (q && ANY_MEDIA.test(q)) return q;
    const txt = (host.textContent || '').replace(/^\s*\u00a0+/, '').trim();
    const m = txt.match(/[^\/\\]+\.[A-Za-z0-9]{2,5}(?=\s|$)/);
    return m ? m[0] : null;
  }
  function canonicalNameCell(el) {
    if (!el) return null;
    const row = el.closest ? el.closest(ROW_SELECTOR) : null;
    if (!row) return null;
    const cell = row.querySelector('.x-grid3-cell-inner.x-grid3-col-filename') || row.querySelector(NAME_CELL_SELECTOR);
    return cell || null;
  }
  function refreshMediaList() {
    const rows = Array.from(document.querySelectorAll(ROW_SELECTOR));
    const cells = rows.map(r => r.querySelector('.x-grid3-cell-inner.x-grid3-col-filename') || r.querySelector(NAME_CELL_SELECTOR)).filter(Boolean);
    S.list = cells.filter(c => { const n = getNameFromCell(c); return n && ANY_MEDIA.test(n); });
  }
  function getSelectedCell() {
    const row = document.querySelector(`.${ROW_SELECTED}`); if (!row) return null;
    const cell = row.querySelector('.x-grid3-cell-inner.x-grid3-col-filename') || row.querySelector(NAME_CELL_SELECTOR); if (!cell) return null;
    const n = getNameFromCell(cell); return n && ANY_MEDIA.test(n) ? cell : null;
  }
  function highlightRow(cell) {
    const row = cell?.closest(ROW_SELECTOR); if (!row) return;
    document.querySelectorAll(`.${ROW_SELECTED}`).forEach(r => r.classList.remove(ROW_SELECTED));
    row.classList.add(ROW_SELECTED);
    row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** ======================== HEIC 支持 ======================== **/
  function isHeicResource(nameOrUrl) {
    if (!nameOrUrl) return false;
    const base = (typeof nameOrUrl === 'string') ? nameOrUrl : String(nameOrUrl);
    return HEIC_EXT.test(base.toLowerCase());
  }

  function normalizeHeicResult(result) {
    if (!result) return null;
    if (result instanceof Blob) return result;
    if (Array.isArray(result) && result.length) return result[0];
    return null;
  }

  async function loadImageSource(url) {
    if (!isHeicResource(url)) return { src: url, objectUrl: null };
    try {
      if (!window.heic2any) throw new Error('heic2any not available');
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('fetch failed');
      const blob = await res.blob();
      const converted = normalizeHeicResult(await window.heic2any({ blob, toType: 'image/jpeg', quality: 0.92 }));
      if (!(converted instanceof Blob)) throw new Error('convert failed');
      const objectUrl = URL.createObjectURL(converted);
      return { src: objectUrl, objectUrl };
    } catch (_) {
      return { src: url, objectUrl: null };
    }
  }

  function releaseImageObjectUrl(objUrl) {
    if (objUrl && typeof objUrl === 'string' && objUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(objUrl); } catch (_) {}
    }
  }

  const VIDEO_MIMES = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/mp4',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    webm: 'video/webm'
  };
  const AUDIO_MIMES = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    oga: 'audio/ogg',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    wav: 'audio/wav',
    flac: 'audio/flac'
  };
  const VIDEO_SUPPORT_CACHE = new Map();
  const AUDIO_SUPPORT_CACHE = new Map();
  const videoProbe = document.createElement('video');
  const audioProbe = document.createElement('audio');

  function getExtension(url) {
    try {
      const u = new URL(url, location.href);
      const name = (u.pathname.split('/').pop() || '').trim();
      const idx = name.lastIndexOf('.');
      return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
    } catch (_) {
      const path = (url || '').split('?')[0];
      const name = (path.split('/').pop() || '').trim();
      const idx = name.lastIndexOf('.');
      return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
    }
  }

  function isVideoPlayable(url) {
    const ext = getExtension(url);
    if (!ext) return true;
    if (ext === 'm3u8') return true;
    const mime = VIDEO_MIMES[ext];
    if (!mime) return false;
    const key = `${ext}|${mime}`;
    if (!VIDEO_SUPPORT_CACHE.has(key)) {
      const can = videoProbe.canPlayType(mime);
      VIDEO_SUPPORT_CACHE.set(key, !!can && can !== 'no');
    }
    return VIDEO_SUPPORT_CACHE.get(key);
  }

  function isAudioPlayable(url) {
    const ext = getExtension(url);
    if (!ext) return true;
    const mime = AUDIO_MIMES[ext];
    if (!mime) return false;
    const key = `${ext}|${mime}`;
    if (!AUDIO_SUPPORT_CACHE.has(key)) {
      const can = audioProbe.canPlayType(mime);
      AUDIO_SUPPORT_CACHE.set(key, !!can && can !== 'no');
    }
    return AUDIO_SUPPORT_CACHE.get(key);
  }

  /** ======================== 抓直链（注入 page-hook） ======================== **/
  let __fs_injected = false, __fs_attached = false;
  function injectPageHook() {
    try {
      const hookUrl = chrome.runtime.getURL('page-hook.js');
      const s = document.createElement('script'); s.src = hookUrl;
      (document.documentElement || document.head || document.body).appendChild(s);
      s.onload = () => { try { s.remove(); } catch (_) {} };
    } catch (err) {
      debugToast('扩展已重载，正在刷新…'); setTimeout(() => location.reload(), 200);
    }
  }
  function ensureInjected() { if (!__fs_injected) { injectPageHook(); __fs_injected = true; } }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'FS_CAPTURED' && typeof e.data.url === 'string') {
      if (S.captureResolver) {
        const res = S.captureResolver;
        S.captureResolver = null;
        clearTimeout(S.captureTimer); S.captureTimer = null;
        window.postMessage({ type: 'FS_CAPTURE_OFF' }, '*');
        res(e.data.url);
      }
    }
  });

  function captureFsNewTabUrl(cell, opts) {
    const selectFirst = !opts || opts.selectFirst !== false; // default true
    return new Promise((resolve) => {
      window.postMessage({ type: 'FS_CAPTURE_ON' }, '*');
      S.captureResolver = resolve;
      S.captureTimer = setTimeout(() => {
        if (S.captureResolver) {
          S.captureResolver = null;
          window.postMessage({ type: 'FS_CAPTURE_OFF' }, '*');
          resolve(null);
        }
      }, 2000);

      const rect = cell.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      // 先模拟一次左键点击确保选中该行（可选）
      if (selectFirst) {
        try {
          const selEl = cell.closest('.x-grid3-cell-inner') || cell;
          const pd = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, clientX: x, clientY: y });
          const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y });
          const mu = new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y });
          const ck = new MouseEvent('click',     { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y });
          try { selEl.dispatchEvent(pd); } catch (_) {}
          selEl.dispatchEvent(md); selEl.dispatchEvent(mu); selEl.dispatchEvent(ck);
        } catch (_) {}
      }
      // 稍作延迟后再触发右键菜单，避免与选择态切换竞争
      setTimeout(() => {
        try {
          const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2, clientX: x, clientY: y });
          const row = cell.closest(ROW_SELECTOR) || cell;
          row.dispatchEvent(ev);
        } catch (_) {}
      }, 120);

      const tryClickMenu = () => {
        const menus = Array.from(document.querySelectorAll('.x-menu, .menu, .x-menu-floating')); if (!menus.length) return false;
        const keywords = [
          '在新选项卡中播放', '在新选项卡中打开', '在新标签页中播放', '在新标签页中打开',
          'Open in new tab', 'Play in new tab', 'Open in New Tab', 'Play in New Tab'
        ];
        for (const m of menus) {
          const items = Array.from(m.querySelectorAll('.x-menu-item, .x-menu-list-item, li, a, span'));
          for (const it of items) {
            const t = (it.textContent || '').trim(); if (!t) continue;
            if (keywords.some(k => t.includes(k))) {
              (it.closest('a, .x-menu-item, .x-menu-list-item') || it)
                .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 }));
              return true;
            }
          }
        }
        return false;
      };

      let step = 0, clicked = false;
      const timer = setInterval(() => {
        step++; if (!clicked) clicked = tryClickMenu();
        if (step > 40) {
          clearInterval(timer);
          document.querySelectorAll('.x-menu, .menu, .x-menu-floating').forEach(n => n.style.display = 'none');
        }
      }, 50);
    });
  }

  // 静默捕获直链：临时隐藏菜单避免可见闪烁
  const CONTEXT_MENU_HIDE_CSS = `
.x-menu, .menu, .x-menu-floating,
.x-menu *, .menu *, .x-menu-floating * {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;
  function applyInlineMenuHide() {
    try {
      const nodes = document.querySelectorAll('.x-menu, .menu, .x-menu-floating');
      nodes.forEach((node) => {
        if (!node) return;
        node.dataset.fsMenuHidden = '1';
        node.style.opacity = '0';
        node.style.visibility = 'hidden';
        node.style.pointerEvents = 'none';
      });
    } catch (_) {}
  }
  function restoreInlineMenuHide() {
    try {
      const nodes = document.querySelectorAll('[data-fs-menu-hidden]');
      nodes.forEach((node) => {
        if (!node) return;
        delete node.dataset.fsMenuHidden;
        node.style.opacity = '';
        node.style.visibility = '';
        node.style.pointerEvents = '';
      });
    } catch (_) {}
  }

  function captureFsNewTabUrlSilent(cell, opts) {
    return new Promise(async (resolve) => {
      const sty = document.createElement('style');
      sty.textContent = CONTEXT_MENU_HIDE_CSS;
      try { (document.head || document.documentElement).appendChild(sty); } catch (_) {}
      applyInlineMenuHide();
      const interval = setInterval(applyInlineMenuHide, 25);
      try {
        const url = await captureFsNewTabUrl(cell, opts);
        resolve(url);
      } catch (_) { resolve(null); }
      finally {
        clearInterval(interval);
        setTimeout(() => {
          restoreInlineMenuHide();
          try { sty.remove(); } catch (_) {}
        }, 160);
      }
    });
  }

  /** ======================== 浮层（通用） ======================== **/
  function cleanupListeners() {
    if (S.keyDownHandler) { window.removeEventListener('keydown', S.keyDownHandler, true); S.keyDownHandler = null; }
    if (S.keyUpHandler) { window.removeEventListener('keyup', S.keyUpHandler, true); S.keyUpHandler = null; }
    if (S.keyPressHandler) { window.removeEventListener('keypress', S.keyPressHandler, true); S.keyPressHandler = null; }
    if (S.selKeyHandler) { window.removeEventListener('keyup', S.selKeyHandler, true); S.selKeyHandler = null; }
    if (S.ptrDownHandler) { window.removeEventListener('pointerdown', S.ptrDownHandler, true); S.ptrDownHandler = null; }
    if (S.ptrUpHandler) { window.removeEventListener('pointerup', S.ptrUpHandler, true); S.ptrUpHandler = null; }
    document.removeEventListener('visibilitychange', onVisChange, true);
    window.removeEventListener('pagehide', onPageHide, true);
    try { S.selObserver?.disconnect?.(); } catch (_) {}
    S.selObserver = null; if (S.selTimer) { clearTimeout(S.selTimer); S.selTimer = null; }
  }
  function hardRemoveAllMasks() {
    ['#fs_inline_media_mask', '#fs_inline_video_mask', '#fs_inline_video_mask_old']
      .forEach(sel => document.querySelectorAll(sel).forEach(n => { try { n.remove(); } catch (_) {} }));
  }
  function closeOverlay() {
    try { S.player?.destroy?.(); } catch (_) {}
    try { S.videoEl?.pause(); } catch (_) {}
    try { S.maskEl?.remove?.(); } catch (_) {}
    S.maskEl = S.wrapEl = S.videoEl = S.imgEl = null;
    if (S.audioCoverUrl) { try { URL.revokeObjectURL(S.audioCoverUrl); } catch (_) {} }
    if (S.imageObjectUrl) { try { URL.revokeObjectURL(S.imageObjectUrl); } catch (_) {} S.imageObjectUrl = null; }
    S.audioLayoutEl = S.audioMetaEl = S.audioRecordEl = S.audioCoverImgEl = null;
    S.audioTitleEl = S.audioDetailEl = null;
    S.audioCoverUrl = null;
    S.player = null; S.usingPlyr = false;
    S.navLock = false;
    cleanupListeners(); hardRemoveAllMasks();
  }
  function onVisChange() { if (document.hidden) closeOverlay(); }
  function onPageHide() { closeOverlay(); }

  function buildOverlaySkeleton(size = 'video') {
    const mask = document.createElement('div');
    mask.id = 'fs_inline_media_mask';
    mask.className = 'fs-inline-mask';
    mask.setAttribute('tabindex', '-1');

    const wrap = document.createElement('div');
    const wrapType = size === 'image' ? 'image' : (size === 'audio' ? 'audio' : 'video');
    wrap.className = `fs-inline-wrap fs-inline-wrap--${wrapType}`;

    const btn = document.createElement('button'); btn.textContent = '✕';
    btn.type = 'button';
    btn.className = 'fs-inline-close';
    btn.onclick = () => closeOverlay();
    mask.onclick = (e) => { if (e.target === mask) closeOverlay(); };

    mask.appendChild(wrap); mask.appendChild(btn);
    (document.body || document.documentElement).appendChild(mask);

    document.addEventListener('visibilitychange', onVisChange, true);
    window.addEventListener('pagehide', onPageHide, true);

    S.maskEl = mask; S.wrapEl = wrap;
    S.overlayToken = (S.overlayToken || 0) + 1;

    installSelectionWatcher();
  }

  function showOverlayLoading(message = '资源加载中…') {
    if (!S.wrapEl) return () => {};
    try { const old = S.wrapEl.querySelector('.fs-inline-loading'); if (old) old.remove(); } catch (_) {}
    const d = document.createElement('div');
    d.className = 'fs-inline-loading';
    Object.assign(d.style, {
      position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      color: '#fff', fontSize: '14px', background: 'rgba(0,0,0,0.2)',
      zIndex: 2147483649
    });
    const spinner = document.createElement('div'); spinner.className = 'fs-inline-spinner';
    const text = document.createElement('div'); text.className = 'fs-inline-loading-text'; text.textContent = message;
    d.appendChild(spinner); d.appendChild(text);
    try { S.wrapEl.appendChild(d); } catch (_) {}
    return () => { try { d.remove(); } catch (_) {} };
  }

  function showMessageOverlay(message) {
    if (!S.maskEl || !S.wrapEl) buildOverlaySkeleton('image');
    if (!S.maskEl || !S.wrapEl) return;
    try { S.wrapEl.innerHTML = ''; } catch (_) {}
    if (S.imageObjectUrl) { releaseImageObjectUrl(S.imageObjectUrl); S.imageObjectUrl = null; }
    S.lastCapturedUrl = null;
    const box = document.createElement('div');
    box.className = 'fs-inline-message';
    box.textContent = message;
    S.wrapEl.className = 'fs-inline-wrap fs-inline-wrap--message';
    S.wrapEl.appendChild(box);
    installGlobalKeyHandlers({ kind: 'image' });
  }

  function installSelectionWatcher() {
    try { S.selObserver?.disconnect?.(); } catch (_) {}
    S.selObserver = null; if (S.selTimer) { clearTimeout(S.selTimer); S.selTimer = null; }
    const target = document.body || document.documentElement;
    if (!target) return;
    const schedule = () => {
      if (S.navLock) return; // 导航处理中不响应，避免互相打断
      if (!S.maskEl) return;
      if (S.selTimer) clearTimeout(S.selTimer);
      S.selTimer = setTimeout(async () => {
        if (!S.maskEl) return;
        const cell = getSelectedCell();
        if (!cell) return;
        if (cell === S.lastCell) return;
        S.lastCell = cell;
        const rm = showOverlayLoading();
        const url = await captureFsNewTabUrlSilent(cell) || await captureFsNewTabUrl(cell);
        rm();
        if (!url) return;
        const kind = kindFromUrlOrName(url || getNameFromCell(cell) || '');
        await setOverlayContent(url, kind);
      }, 60);
    };
    try {
      const ob = new MutationObserver((mutations) => {
        for (const m of mutations) {
          const t = m.target;
          if (t && t.classList && (t.classList.contains('x-grid3-row') || t.classList.contains(ROW_SELECTED))) {
            schedule(); break;
          }
        }
      });
      ob.observe(target, { attributes: true, attributeFilter: ['class'], subtree: true });
      S.selObserver = ob;
    } catch(_) {}

    const onKeyUp = (e) => {
      const k = e.key || e.code;
      if (k === 'ArrowUp' || k === 'ArrowDown') schedule();
    };
    window.addEventListener('keyup', onKeyUp, true);
    S.selKeyHandler = onKeyUp;
  }

  function getCellIndex(targetCell) {
    if (!targetCell) return -1;
    const t = canonicalNameCell(targetCell) || targetCell;
    return S.list.findIndex(c => c === t);
  }

  function evictPreloadLRU(limit = 4) {
    try {
      while (S.preloads.size > limit) {
        const firstKey = S.preloads.keys().next().value;
        const item = S.preloads.get(firstKey);
        S.preloads.delete(firstKey);
        if (item) {
          if (item.kind === 'image') releaseImageObjectUrl(item.objectUrl || (item.img?.src && item.img.src.startsWith('blob:') ? item.img.src : null));
        }
      }
    } catch (_) {}
  }

  async function primeCacheFor(url, kind) {
    if (!url) return;
    if (S.preloads.has(url) || S.preloading.has(url)) return;
    if (kind === 'video' && !isVideoPlayable(url)) return;
    if (kind === 'audio' && !isAudioPlayable(url)) return;
    S.preloading.add(url);
    let pendingObjectUrl = null;
    let stored = false;
    try {
      if (kind === 'image') {
        const { src, objectUrl } = await loadImageSource(url);
        pendingObjectUrl = objectUrl;
        const img = new Image();
        img.decoding = 'async';
        img.src = src;
        await new Promise(r => { const done = () => { img.onload = img.onerror = null; r(); }; img.onload = done; img.onerror = done; setTimeout(done, 1200); });
        S.preloads.set(url, { kind, img, objectUrl, ts: Date.now() });
        stored = true;
      } else if (kind === 'audio' || kind === 'video') {
        if (/\.m3u8(\?|$)/i.test(url)) {
          try { await fetch(url, { credentials: 'include' }); } catch (_) {}
          S.preloads.set(url, { kind, ts: Date.now() });
          stored = true;
        } else {
          const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
          el.preload = 'metadata';
          el.src = url; try { el.load?.(); } catch (_) {}
          await new Promise(r => { const done = () => { el.removeEventListener('loadedmetadata', done); el.removeEventListener('error', done); r(); }; el.addEventListener('loadedmetadata', done); el.addEventListener('error', done); setTimeout(done, 1500); });
          S.preloads.set(url, { kind, el, ts: Date.now() });
          stored = true;
        }
      }
    } catch (_) {}
    finally {
      S.preloading.delete(url);
      if (!stored && pendingObjectUrl) releaseImageObjectUrl(pendingObjectUrl);
      evictPreloadLRU();
    }
  }

  async function preloadCell(cell) {
    const c = canonicalNameCell(cell) || cell;
    if (!c) return;
    const name = getNameFromCell(c);
    if (!name) return;
    let url = null;
    if (S.lastCapturedUrl) {
      url = buildSiblingUrl(S.lastCapturedUrl, name);
    }
    if (!url) return; // 为避免干扰选中，缺省不回退到右键捕获
    const kind = kindFromUrlOrName(name);
    primeCacheFor(url, kind);
  }

  function schedulePreloadNext() {
    try {
      refreshMediaList();
      const base = S.lastCell && document.contains(S.lastCell) ? S.lastCell : getSelectedCell();
      if (!base) return;
      const baseIdx = getCellIndex(base);
      if (baseIdx < 0) return;
      const next = S.list[baseIdx + 1];
      if (next) { preloadCell(next); }
    } catch (_) {}
  }

  function buildSiblingUrl(prevUrl, nextName) {
    try {
      const u = new URL(prevUrl, location.href);
      const parts = u.pathname.split('/');
      const enc = encodeURIComponent(nextName).replace(/%2F/gi, '/');
      parts[parts.length - 1] = enc;
      u.pathname = parts.join('/');
      return u.toString();
    } catch (_) {
      try {
        const qpos = prevUrl.indexOf('?');
        const left = qpos >= 0 ? prevUrl.slice(0, qpos) : prevUrl;
        const right = qpos >= 0 ? prevUrl.slice(qpos) : '';
        const slash = left.lastIndexOf('/');
        const prefix = slash >= 0 ? left.slice(0, slash + 1) : '';
        const enc = encodeURIComponent(nextName).replace(/%2F/gi, '/');
        return prefix + enc + right;
      } catch (__) { return null; }
    }
  }

  // 在已有浮层中，原位切换媒体内容，避免闪烁
  async function setOverlayContent(url, kind) {
    if (!S.maskEl || !S.wrapEl) return;
    S.lastCapturedUrl = url;
    if (kind !== 'image' && S.imageObjectUrl) { releaseImageObjectUrl(S.imageObjectUrl); S.imageObjectUrl = null; }
    try { S.player?.destroy?.(); } catch (_) {}
    try { S.videoEl?.pause?.(); } catch (_) {}
    S.player = null; S.usingPlyr = false;
    if (S.audioCoverUrl) { try { URL.revokeObjectURL(S.audioCoverUrl); } catch (_) {} }
    S.audioLayoutEl = S.audioMetaEl = S.audioRecordEl = S.audioCoverImgEl = null;
    S.audioTitleEl = S.audioDetailEl = null;
    S.audioCoverUrl = null;
    S.videoEl = null; S.imgEl = null;

    // 清空内容区域（保留遮罩和关闭按钮）
    try { S.wrapEl.innerHTML = ''; } catch (_) {}
    const removeLoading = showOverlayLoading('资源加载中…');
    try {
      if (kind === 'image') {
        if (S.imageObjectUrl) { releaseImageObjectUrl(S.imageObjectUrl); S.imageObjectUrl = null; }
        const preImg = S.preloads.get(url);
        let img;
        let objectUrl = null;
        if (preImg && preImg.kind === 'image' && preImg.img) {
          img = preImg.img;
          objectUrl = preImg.objectUrl || (img.src && img.src.startsWith('blob:') ? img.src : null);
          S.preloads.delete(url);
        } else {
          const { src, objectUrl: outUrl } = await loadImageSource(url);
          img = new Image();
          img.decoding = 'async';
          img.src = src;
          objectUrl = outUrl;
        }
        img.className = 'fs-inline-image';
        img.draggable = false;
        S.wrapEl.className = 'fs-inline-wrap fs-inline-wrap--image';
        S.wrapEl.appendChild(img); S.imgEl = img;
        S.imageObjectUrl = objectUrl;

        let scale = 1, posX = 0, posY = 0, dragging = false, startX = 0, startY = 0;
        const apply = () => { img.style.transform = `translate(${posX}px, ${posY}px) scale(${scale})`; };
        const clampScale = s => Math.min(8, Math.max(0.2, s));
        const onWheel = (e) => { e.preventDefault(); const delta = -(e.deltaY || 0); const factor = delta > 0 ? 1.1 : 0.9; scale = clampScale(scale * factor); apply(); };
        const onDown = (e) => { dragging = true; startX = e.clientX; startY = e.clientY; img.style.cursor = 'grabbing'; };
        const onMove = (e) => { if (!dragging) return; posX += (e.clientX - startX); posY += (e.clientY - startY); startX = e.clientX; startY = e.clientY; apply(); };
        const onUp = () => { dragging = false; img.style.cursor = 'grab'; };
        img.addEventListener('wheel', onWheel, { passive: false });
        img.addEventListener('pointerdown', onDown);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        img.onerror = () => { img.onerror = null; showMessageOverlay('暂不支持此格式预览'); };

        installGlobalKeyHandlers({ kind: 'image' });
        schedulePreloadNext();
        return;
      }

      const pre = S.preloads.get(url);
      if (kind === 'video' && !isVideoPlayable(url)) {
        if (pre) S.preloads.delete(url);
        showMessageOverlay('暂不支持此格式预览');
        return;
      }
      if (kind === 'audio' && !isAudioPlayable(url)) {
        if (pre) S.preloads.delete(url);
        showMessageOverlay('暂不支持此格式预览');
        return;
      }

      let el = (pre && pre.el && (pre.kind === kind)) ? pre.el : document.createElement(kind === 'audio' ? 'audio' : 'video');
      el.setAttribute('playsinline', ''); el.setAttribute('controls', '');
      el.className = kind === 'audio' ? 'fs-inline-audio-player' : 'fs-inline-video-player';
      S.wrapEl.className = `fs-inline-wrap fs-inline-wrap--${kind === 'audio' ? 'audio' : 'video'}`;

      if (kind === 'audio') {
        ensureAudioLayout(el, url);
      } else {
        const holder = document.createElement('div');
        holder.className = 'fs-inline-video-holder';
        holder.appendChild(el);
        S.wrapEl.appendChild(holder);
      }
      S.videoEl = el;

      const isHls = /\.m3u8(\?|$)/i.test(url);
      let hls = null;
      if (kind === 'video' && isHls && !el.canPlayType('application/vnd.apple.mpegurl')) {
        if (hlsReady()) { hls = new window.Hls(); hls.loadSource(url); hls.attachMedia(el); }
        else { window.open(url, '_blank'); return; }
      } else {
        if (!el.src) el.src = url;
      }

      if (!plyrReady()) {
        installGlobalKeyHandlers({ kind });
        try { await el.play(); } catch (_) {}
        return;
      }

      const player = new window.Plyr(el, {
        controls: kind === 'video'
          ? ['play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'pip', 'airplay', 'fullscreen']
          : ['play', 'progress', 'current-time', 'duration', 'mute', 'volume'],
        settings: kind === 'video' ? ['quality', 'speed'] : ['speed'],
        clickToPlay: true,
        keyboard: { focused: false, global: false },
        autoplay: true,
      });
      S.player = player; S.usingPlyr = true;
      if (kind === 'audio') bindAudioSpin(el);

      installGlobalKeyHandlers({ kind });
      try { await (S.player ? S.player.play() : S.videoEl.play()); } catch (_) {}
      S.preloads.delete(url);
      schedulePreloadNext();
    } finally {
      removeLoading();
    }
  }

  /** ======================== 图片预览（滚轮缩放 + 拖拽） ======================== **/
  async function showImage(url) {
    buildOverlaySkeleton('image');
    await setOverlayContent(url, 'image');
  }

  /** ======================== 音频元数据 & 布局 ======================== **/
  function deriveNameFromUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      const raw = u.pathname.split('/').pop() || '';
      return decodeURIComponent(raw) || raw || url;
    } catch (_) {
      const path = url.split('?')[0];
      const raw = path.split('/').pop() || url;
      try { return decodeURIComponent(raw); } catch (__) { return raw; }
    }
  }

  function ensureAudioLayout(el, url) {
    if (!S.wrapEl) return;

    const layout = document.createElement('div');
    layout.className = 'fs-audio-layout';

    const meta = document.createElement('div');
    meta.className = 'fs-audio-meta';

    const record = document.createElement('div');
    record.className = 'fs-audio-record is-paused';

    const coverImg = document.createElement('img');
    coverImg.alt = '专辑封面';
    record.appendChild(coverImg);

    const spindle = document.createElement('div');
    spindle.className = 'fs-audio-spindle';
    record.appendChild(spindle);

    const textBox = document.createElement('div');
    textBox.className = 'fs-audio-meta-text';

    const titleEl = document.createElement('div');
    titleEl.className = 'fs-audio-title';
    textBox.appendChild(titleEl);

    const subEl = document.createElement('div');
    subEl.className = 'fs-audio-sub';
    textBox.appendChild(subEl);

    meta.appendChild(record);
    meta.appendChild(textBox);

    const playerHolder = document.createElement('div');
    playerHolder.className = 'fs-audio-player-holder';
    playerHolder.appendChild(el);

    layout.appendChild(meta);
    layout.appendChild(playerHolder);
    S.wrapEl.appendChild(layout);

    S.audioLayoutEl = layout;
    S.audioMetaEl = meta;
    S.audioRecordEl = record;
    S.audioCoverImgEl = coverImg;
    S.audioTitleEl = titleEl;
    S.audioDetailEl = subEl;

    setAudioCover(null, S.overlayToken);
    setAudioMetaDisplay({ title: deriveNameFromUrl(url) });
    const token = S.overlayToken;
    hydrateAudioMetadata(url, token);
    updateAudioSpinState(false);
  }

  function setAudioMetaDisplay({ title, artist, album }) {
    if (!S.audioTitleEl || !S.audioDetailEl) return;
    S.audioTitleEl.textContent = title || '音频';
    const details = [artist, album].filter(Boolean);
    S.audioDetailEl.textContent = details.length ? details.join(' · ') : 'MP3 音频';
  }

  function setAudioCover(picture, token) {
    if (!S.audioCoverImgEl || token !== S.overlayToken) return;
    if (S.audioCoverUrl) { try { URL.revokeObjectURL(S.audioCoverUrl); } catch (_) {} S.audioCoverUrl = null; }
    if (!picture) {
      S.audioCoverImgEl.style.display = 'none';
      S.audioCoverImgEl.src = '';
      if (S.audioRecordEl) S.audioRecordEl.classList.remove('with-cover');
      return;
    }
    try {
      const source = picture.data instanceof Uint8Array ? picture.data : new Uint8Array(picture.data);
      const blob = new Blob([source], { type: picture.mime || 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      S.audioCoverUrl = url;
      S.audioCoverImgEl.src = url;
      S.audioCoverImgEl.style.display = 'block';
      if (S.audioRecordEl) S.audioRecordEl.classList.add('with-cover');
    } catch (_) {
      S.audioCoverImgEl.style.display = 'none';
      if (S.audioRecordEl) S.audioRecordEl.classList.remove('with-cover');
    }
  }

  function updateAudioSpinState(playing) {
    if (!S.audioRecordEl) return;
    if (playing) S.audioRecordEl.classList.remove('is-paused');
    else S.audioRecordEl.classList.add('is-paused');
  }

  function bindAudioSpin(el) {
    if (!el) return;
    const handlePlay = () => updateAudioSpinState(true);
    const handlePause = () => updateAudioSpinState(false);
    el.addEventListener('play', handlePlay);
    el.addEventListener('playing', handlePlay);
    el.addEventListener('pause', handlePause);
    el.addEventListener('ended', handlePause);
    el.addEventListener('waiting', handlePause);
    el.addEventListener('seeking', handlePause);
    handlePause();
  }

  async function hydrateAudioMetadata(url, token) {
    if (!url || !/\.mp3(\?|$)/i.test(url)) return;
    try {
      const meta = await fetchId3Metadata(url);
      if (!meta) return;
      if (!S.maskEl || token !== S.overlayToken) return;
      if (meta.title || meta.artist || meta.album) {
        setAudioMetaDisplay({
          title: meta.title || deriveNameFromUrl(url),
          artist: meta.artist,
          album: meta.album
        });
      }
      if (meta.picture) setAudioCover(meta.picture, token);
    } catch (_) {}
  }

  async function fetchId3Metadata(url) {
    try {
      const res = await fetch(url, {
        headers: { Range: 'bytes=0-131071' },
        credentials: 'include'
      });
      if (!res.ok) return null;
      let buffer;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        const limit = 131072;
        while (total < limit) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          const remaining = limit - total;
          const piece = value.length > remaining ? value.subarray(0, remaining) : value;
          chunks.push(piece);
          total += piece.length;
          if (value.length > remaining || total >= limit) break;
        }
        try { reader.cancel(); } catch (_) {}
        buffer = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      } else {
        const arr = new Uint8Array(await res.arrayBuffer());
        buffer = arr.length > 131072 ? arr.slice(0, 131072) : arr;
      }
      return parseId3(buffer);
    } catch (_) {
      return null;
    }
  }

  function parseId3(bytes) {
    if (!bytes || bytes.length < 10) return null;
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
    const version = bytes[3];
    const flags = bytes[5];
    const tagSize = synchsafeToInt(bytes[6], bytes[7], bytes[8], bytes[9]);
    let offset = 10;
    if (flags & 0x40) {
      if (bytes.length < offset + 4) return null;
      const extSize = (version === 4)
        ? synchsafeToInt(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
        : readUInt32(bytes, offset);
      offset += 4 + extSize;
    }
    const end = Math.min(bytes.length, offset + tagSize);
    const info = { title: '', artist: '', album: '', picture: null };
    while (offset + 10 <= end) {
      const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const frameSize = (version === 4)
        ? synchsafeToInt(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
        : readUInt32(bytes, offset + 4);
      if (frameSize <= 0) break;
      const frameEnd = offset + 10 + frameSize;
      if (frameEnd > bytes.length) break;
      const data = bytes.subarray(offset + 10, frameEnd);
      switch (id) {
        case 'TIT2':
          info.title = decodeId3Text(data) || info.title;
          break;
        case 'TPE1':
          info.artist = decodeId3Text(data) || info.artist;
          break;
        case 'TALB':
          info.album = decodeId3Text(data) || info.album;
          break;
        case 'APIC':
          if (!info.picture) {
            const pic = decodeId3Picture(data);
            if (pic) info.picture = pic;
          }
          break;
        default:
          break;
      }
      offset = frameEnd;
    }
    return info;
  }

  function synchsafeToInt(b1, b2, b3, b4) {
    return ((b1 & 0x7f) << 21) | ((b2 & 0x7f) << 14) | ((b3 & 0x7f) << 7) | (b4 & 0x7f);
  }

  function readUInt32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function decodeId3Text(bytes) {
    if (!bytes || !bytes.length) return '';
    const encoding = bytes[0];
    const body = bytes.subarray(1);
    const decoder = encoding === 1 ? new TextDecoder('utf-16')
      : encoding === 2 ? new TextDecoder('utf-16be')
      : encoding === 3 ? new TextDecoder('utf-8')
      : new TextDecoder('latin1');
    const text = decoder.decode(body).replace(/\u0000+/g, '').trim();
    return text;
  }

  function decodeId3Picture(bytes) {
    if (!bytes || !bytes.length) return null;
    let offset = 0;
    const encoding = bytes[offset]; offset += 1;
    const mimeEnd = bytes.indexOf(0, offset);
    const mime = mimeEnd > offset
      ? new TextDecoder('latin1').decode(bytes.subarray(offset, mimeEnd))
      : 'image/jpeg';
    offset = (mimeEnd === -1 ? bytes.length : mimeEnd + 1);
    if (offset >= bytes.length) return null;
    offset += 1; // skip picture type
    if (offset > bytes.length) return null;

    if (encoding === 1 || encoding === 2) {
      while (offset + 1 < bytes.length) {
        if (bytes[offset] === 0 && bytes[offset + 1] === 0) { offset += 2; break; }
        offset += 2;
      }
    } else {
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1;
      offset += 1;
    }
    if (offset >= bytes.length) return null;
    return { mime: mime || 'image/jpeg', data: bytes.subarray(offset) };
  }

  /** ======================== Plyr 播放（视频/音频） ======================== **/
  function plyrReady() { return (typeof window.Plyr === 'function'); }
  function hlsReady() { return !!window.Hls; }

  async function showPlyr(url, kind) {
    buildOverlaySkeleton(kind === 'audio' ? 'audio' : 'video');
    S.lastCapturedUrl = url;

    if (kind === 'video' && !isVideoPlayable(url)) {
      showMessageOverlay('暂不支持此格式预览');
      return;
    }
    if (kind === 'audio' && !isAudioPlayable(url)) {
      showMessageOverlay('暂不支持此格式预览');
      return;
    }

    if (!plyrReady()) {
      // 理论上不会发生（已在 manifest 预注入），仍兜底
      debugToast('Plyr 未加载，使用原生播放器', true);
      return showNativeMedia(url, kind);
    }

    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.setAttribute('playsinline', ''); el.setAttribute('controls', '');
    el.className = kind === 'audio' ? 'fs-inline-audio-player' : 'fs-inline-video-player';
    if (kind === 'audio') ensureAudioLayout(el, url);
    else {
      const holder = document.createElement('div');
      holder.className = 'fs-inline-video-holder';
      holder.appendChild(el);
      S.wrapEl.appendChild(holder);
    }
    S.videoEl = el;

    const isHls = /\.m3u8(\?|$)/i.test(url);
    let hls = null;
    if (kind === 'video' && isHls && !el.canPlayType('application/vnd.apple.mpegurl')) {
      if (hlsReady()) { hls = new window.Hls(); hls.loadSource(url); hls.attachMedia(el); }
      else { window.open(url, '_blank'); closeOverlay(); return; }
    } else {
      el.src = url;
    }

    const player = new window.Plyr(el, {
      controls: kind === 'video'
        ? ['play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'pip', 'airplay', 'fullscreen']
        : ['play', 'progress', 'current-time', 'duration', 'mute', 'volume'],
      settings: kind === 'video' ? ['quality', 'speed'] : ['speed'],
      clickToPlay: true,
      keyboard: { focused: false, global: false },
      autoplay: true,
    });
    S.player = player; S.usingPlyr = true;

    if (kind === 'audio') bindAudioSpin(el);

    // CSS 未生效仅提示，不回退
    try {
      const probe = document.createElement('div');
      probe.className = 'plyr plyr--audio';
      probe.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;';
      (document.body || document.documentElement).appendChild(probe);
      const comp = getComputedStyle(probe);
      const looksStyled = comp && (comp.getPropertyValue('--plyr-color-main') || comp.getPropertyValue('line-height'));
      probe.remove();
      // 如果 Plyr CSS 未生效，仅在控制台静默，不打日志
    } catch (_) {}

    installGlobalKeyHandlers({ kind });

    // 不再强制把焦点带回遮罩，避免影响 File Station 上下键

    try { await (S.player ? S.player.play() : S.videoEl.play()); } catch (_) {}
    schedulePreloadNext();
  }

  /** ======================== 原生兜底 ======================== **/
  function showNativeMedia(url, kind) {
    buildOverlaySkeleton(kind === 'audio' ? 'audio' : 'video');
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.className = kind === 'audio' ? 'fs-inline-audio-player' : 'fs-inline-video-player';
    el.controls = true; el.autoplay = true; el.src = url; el.playsInline = true;
    el.onerror = () => { try { el.pause(); } catch (_) {} closeOverlay(); window.open(url, '_blank'); };
    if (kind === 'audio') ensureAudioLayout(el, url);
    else {
      const holder = document.createElement('div');
      holder.className = 'fs-inline-video-holder';
      holder.appendChild(el);
      S.wrapEl.appendChild(holder);
    }
    S.videoEl = el;

    installGlobalKeyHandlers({ kind });

    if (kind === 'audio') bindAudioSpin(el);

    // 不强制回焦遮罩
  }

  /** ======================== 键盘（空格/ESC） ======================== **/
  function installGlobalKeyHandlers({ kind }) {
    cleanupListeners();

    const keydown = (e) => {
      if (!S.maskEl) return;
      if (e.repeat) return;
      const now = Date.now(); if (now - S.lastKeyTs < 120) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      S.lastKeyTs = now;
      const k = e.key || e.code;
      if (k === 'Escape' || k === 'Esc') { e.preventDefault(); e.stopImmediatePropagation(); closeOverlay(); return; }
      if (k === ' ' || k === 'Spacebar') {
        if (kind === 'video' || kind === 'audio') {
          e.preventDefault(); e.stopImmediatePropagation();
          if (S.player) S.player.togglePlay();
          else if (S.videoEl) { if (S.videoEl.paused) S.videoEl.play().catch(() => {}); else S.videoEl.pause(); }
        } else {
          e.preventDefault(); e.stopImmediatePropagation();
        }
        return;
      }
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        // 在浮层开启时由扩展处理上下键：
        // 1) 改变 File Station 选中（模拟点击下一/上一行）
        // 2) 捕获直链并在浮层内原位切换
        e.preventDefault(); e.stopImmediatePropagation();
        navigateMedia(k === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (kind === 'video' && (k === 'ArrowLeft' || k === 'ArrowRight')) {
        e.preventDefault(); e.stopImmediatePropagation();
        const delta = k === 'ArrowLeft' ? -10 : 10;
        const applyDelta = (seconds) => {
          if (S.player) {
            const duration = Number.isFinite(S.player.duration) ? S.player.duration : undefined;
            const current = Number.isFinite(S.player.currentTime) ? S.player.currentTime : 0;
            if (seconds < 0 && typeof S.player.rewind === 'function') {
              S.player.rewind(Math.abs(seconds));
            } else if (seconds > 0 && typeof S.player.forward === 'function') {
              S.player.forward(seconds);
            } else {
              const next = current + seconds;
              const clamped = duration ? Math.min(duration, Math.max(0, next)) : Math.max(0, next);
              S.player.currentTime = clamped;
            }
          } else if (S.videoEl && typeof S.videoEl.currentTime === 'number') {
            try {
              const media = S.videoEl;
              const duration = Number.isFinite(media.duration) ? media.duration : undefined;
              const next = media.currentTime + seconds;
              const clamped = duration ? Math.min(duration, Math.max(0, next)) : Math.max(0, next);
              media.currentTime = clamped;
            } catch (_) {}
          }
        };
        applyDelta(delta);
      }
    };
    const stopper = (e) => {
      if (!S.maskEl) return;
      const k = e.key || e.code;
      if (k === 'Escape' || k === 'Esc') { e.preventDefault(); e.stopImmediatePropagation(); closeOverlay(); return; }
      if (k === ' ' || k === 'Spacebar') { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (kind === 'video' && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', stopper, true);
    window.addEventListener('keypress', stopper, true);
    S.keyDownHandler = keydown; S.keyUpHandler = stopper; S.keyPressHandler = stopper;
  }

  /** ======================== 打开当前选择 ======================== **/
  function kindFromUrlOrName(s) {
    const x = (s || '').split('?')[0];
    if (EXT.video.test(x)) return 'video';
    if (EXT.audio.test(x)) return 'audio';
    if (EXT.image.test(x)) return 'image';
    return null;
  }
  async function openCurrentSelection(preferredCell) {
    refreshMediaList();
    let cell = null;
    if (preferredCell && document.contains(preferredCell)) cell = canonicalNameCell(preferredCell) || preferredCell;
    if (!cell) cell = getSelectedCell();
    if (!cell && S.lastCell && document.contains(S.lastCell)) cell = canonicalNameCell(S.lastCell) || S.lastCell;
    if (!cell && S.list.length) cell = S.list[0];
    if (!cell) { toast('未找到可预览的媒体文件', false); return; }

    cell = canonicalNameCell(cell) || cell;
    S.lastCell = cell; highlightRow(cell);
    const url = await captureFsNewTabUrlSilent(cell) || await captureFsNewTabUrl(cell);
    if (!url) { toast('未捕获直链：右键任意媒体点一次“在新标签中打开/播放”后再试', false, 1600); return; }

    const kind = kindFromUrlOrName(url || getNameFromCell(cell) || '');
    if (!kind) { showMessageOverlay('暂不支持此格式预览'); return; }
    if (kind === 'image') await showImage(url);
    else if (kind === 'audio') await showPlyr(url, 'audio');
    else await showPlyr(url, 'video');
  }


  /** ======================== 切换媒体（上下键） ======================== **/
  async function openRelativeSelection(delta) {
    refreshMediaList();
    if (!S.list.length) return 'boundary';

    let current = (S.lastCell && document.contains(S.lastCell)) ? (canonicalNameCell(S.lastCell) || S.lastCell) : null;
    if (!current) current = getSelectedCell();
    if (!current) {
      current = delta > 0 ? S.list[0] : S.list[S.list.length - 1];
    }
    current = canonicalNameCell(current) || current;

    let idx = S.list.findIndex((cell) => cell === current);
    if (idx === -1) {
      idx = 0;
      current = canonicalNameCell(S.list[0]) || S.list[0];
    }

    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= S.list.length) return 'boundary';

    const nextCell = canonicalNameCell(S.list[nextIdx]) || S.list[nextIdx];

    const hadMask = !!S.maskEl;
    const prevCell = current;

    if (hadMask) {
      // 保持浮层：捕获直链后原位切换
      const url = await captureFsNewTabUrlSilent(nextCell) || await captureFsNewTabUrl(nextCell);
      if (!url) return 'failed';
      const kind = kindFromUrlOrName(url || getNameFromCell(nextCell) || '');
      if (!kind) { showMessageOverlay('暂不支持此格式预览'); S.lastCell = nextCell; return 'success'; }
      await setOverlayContent(url, kind);
      S.lastCell = nextCell;
      return 'success';
    } else {
      await openCurrentSelection(nextCell);
      if (S.maskEl) { S.lastCell = nextCell; return 'success'; }
      return 'failed';
    }
  }

  async function navigateMedia(delta) {
    if (S.navLock) return;
    S.navLock = true;
    try {
      const result = await openRelativeSelection(delta);
      if (result === 'boundary') {
        toast(delta < 0 ? '已经是第一个媒体文件' : '已经是最后一个媒体文件', false, 1200);
      }
    } finally {
      S.navLock = false;
    }
  }

/** ======================== 未开浮层时：空格=打开预览 ======================== **/
  function isTypingContext(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return true;
    if (el.closest && el.closest('.x-form-field, .x-form-text')) return true;
    return false;
  }
  let openLock = false;
  async function onKeyDownOpen(e) {
    if (S.maskEl) return;
    if (isTypingContext(e.target)) return;
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (openLock) return;
      e.preventDefault(); e.stopImmediatePropagation();
      openLock = true; try { await openCurrentSelection(); } finally { openLock = false; }
    }
  }
  function attach() {
    if (document.__FS_PLYR_IMG_SPACEESC_EXT__) return;
    document.__FS_PLYR_IMG_SPACEESC_EXT__ = true;
    document.addEventListener('keydown', onKeyDownOpen, true);
    window.addEventListener('keydown', onKeyDownOpen, true);
    setTimeout(() => toast('空格预览 / ESC关闭（视频/音频/图片）已启用'), 300);
  }
  function detach() {
    document.removeEventListener('keydown', onKeyDownOpen, true);
    window.removeEventListener('keydown', onKeyDownOpen, true);
    closeOverlay();
    __fs_attached = false;
    document.__FS_PLYR_IMG_SPACEESC_EXT__ = false;
  }

  /** ======================== 启动 & 热切换 ======================== **/
  (async () => {
    const sites = await loadSites();
    const enabled = isEnabledForHere(sites);
    if (enabled) { debugToast('FS-Preview 已启用：' + location.host); ensureInjected(); attach(); __fs_attached = true; }
    else { debugToast('FS-Preview 未启用：' + location.host); }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const next = changes[KEY].newValue || [];
      const nowEnabled = isEnabledForHere(next);
      if (nowEnabled && !__fs_attached) { ensureInjected(); attach(); __fs_attached = true; debugToast('FS-Preview 已启用：' + location.host); }
      else if (!nowEnabled && __fs_attached) { detach(); debugToast('FS-Preview 已停用：' + location.host); }
    });
  })();

})();
