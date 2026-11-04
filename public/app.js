'use strict';
/* WebGate – client: nhận JPEG qua WebSocket, vẽ lên canvas, gửi chuột/phím về server. */
(() => {
  const $ = (s) => document.querySelector(s);

  const loginEl = $('#login');
  const appEl = $('#app');
  const form = $('#loginForm');
  const passEl = $('#pass');
  const errEl = $('#loginErr');
  const cv = $('#screen');
  const ctx = cv.getContext('2d', { alpha: false, desynchronized: true });
  const statEl = $('#stat');
  const ripple = $('#ripple');

  let ws = null;
  let opened = false;
  let retry = 0;
  let retryTimer = null;

  let RW = 0, RH = 0;               // kích thước ảnh nhận được
  let zoom = 1, panX = 0, panY = 0; // zoom/pan cục bộ (không gửi lên server)
  let rotateUI = false;             // đang xoay canvas 90° (chế độ ngang)
  let wantLandscape = false;
  let fsMode = false;
  let view = { dx: 0, dy: 0, dw: 1, dh: 1, dpr: 1 };
  let lastSrc = null;               // ảnh cuối để vẽ lại khi resize/zoom

  let pendingFrame = null;
  let busy = false;
  let frames = 0;
  let fpsShown = 0;
  let bytesWindow = 0;
  let statAt = performance.now();
  let rtt = null;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clamp01 = (v) => clamp(v, 0, 1);

  // ─────────────────────────────────────────── khởi động / đăng nhập
  async function boot() {
    try {
      const r = await fetch('/api/info', { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        enterApp(await r.json());
        return;
      }
    } catch { /* offline */ }
    loginEl.hidden = false;
    appEl.hidden = true;
    setTimeout(() => passEl.focus(), 200);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const btn = $('#loginBtn');
    btn.disabled = true;
    btn.textContent = 'Đang kiểm tra…';
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pass: passEl.value }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        passEl.value = '';
        const info = await fetch('/api/info', { credentials: 'same-origin' }).then((x) => x.json());
        enterApp(info);
      } else {
        errEl.textContent = d.error || 'Không đăng nhập được';
        passEl.select();
      }
    } catch {
      errEl.textContent = 'Lỗi mạng';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Kết nối';
    }
  });

  function enterApp(info) {
    loginEl.hidden = true;
    appEl.hidden = false;
    resizeCanvas();
    if (info && info.capture) applyCapture(info.capture);
    connect();
    requestAnimationFrame(loop);
    setInterval(stats, 1000);
  }

  // ─────────────────────────────────────────── websocket
  function connect() {
    clearTimeout(retryTimer);
    if (ws) {
      try { ws.onclose = null; ws.close(); } catch { /* ignore */ }
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      opened = true;
      retry = 0;
      setStat('đã kết nối');
      startPing();
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        onCtrl(JSON.parse(e.data));
      } else {
        bytesWindow += e.data.byteLength;
        if (!pendingFrame) pendingFrame = e.data; // luôn dùng khung mới nhất
      }
    };

    ws.onclose = (e) => {
      opened = false;
      setStat(e.code === 1008 || e.code === 4401 ? 'hết phiên' : 'mất kết nối…');
      if (e.code === 1008 || e.code === 4401) {
        boot();
        return;
      }
      retry = Math.min(retry + 1, 6);
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** (retry - 1), 5000));
    };

    ws.onerror = () => {};
  }

  let pingTimer = null;
  function startPing() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ t: 'ping', ts: Date.now() }), 4000);
  }

  function onCtrl(msg) {
    if (!msg) return;
    if (msg.t === 'info' && msg.capture) applyCapture(msg.capture);
    if (msg.t === 'pong' && msg.ts) rtt = Date.now() - msg.ts;
    if (msg.t === 'error') setStat('lỗi: ' + msg.message, true);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ─────────────────────────────────────────── vẽ
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr) || 1;
    const h = Math.round(cv.clientHeight * dpr) || 1;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
      view.dpr = dpr;
      redrawLast();
      send({ t: 'refresh' }); // xin lại khung hình nếu màn hình đang tĩnh
    }
    view.dpr = dpr;
  }

  window.addEventListener('resize', () => { syncOrientation(); holdUi(); });
  window.addEventListener('orientationchange', () => setTimeout(() => { syncOrientation(); holdUi(); }, 250));

  /**
   * Chế độ "ngang": nếu máy đang cầm dọc thì xoay canvas 90° cho ảnh nằm ngang
   * và phủ kín màn hình. Nếu máy đã nằm ngang (hoặc OS đã lock landscape) thì thôi.
   */
  function syncOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    rotateUI = wantLandscape && portrait;
    if (rotateUI) {
      cv.style.width = window.innerHeight + 'px';
      cv.style.height = window.innerWidth + 'px';
      cv.classList.add('rot90');
    } else {
      cv.style.width = '';
      cv.style.height = '';
      cv.classList.remove('rot90');
    }
    resizeCanvas();
  }

  let toolsTimer = null;
  function holdUi() {
    appEl.classList.remove('tools-hidden');
    clearTimeout(toolsTimer);
    if (fsMode) {
      toolsTimer = setTimeout(() => appEl.classList.add('tools-hidden'), 2600);
    }
  }

  function layout(w, h) {
    const dpr = view.dpr;
    const cw = cv.width, ch = cv.height;
    const fit = Math.min(cw / w, ch / h);
    const s = fit * zoom;
    const dw = w * s, dh = h * s;
    const dx = (cw - dw) / 2 + panX * dpr;
    const dy = (ch - dh) / 2 + panY * dpr;
    view = { dx, dy, dw, dh, dpr };
    return { dx, dy, dw, dh };
  }

  function draw(src) {
    const w = src.width, h = src.height;
    if (!w || !h) return;
    if (w !== RW || h !== RH) {
      RW = w; RH = h;
      if (zoom === 1) { panX = 0; panY = 0; }
    }
    const { dx, dy, dw, dh } = layout(RW, RH);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(src, dx, dy, dw, dh);
  }

  function redrawLast() {
    if (lastSrc) draw(lastSrc);
    else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
  }

  function loop() {
    requestAnimationFrame(loop);
    if (!pendingFrame || busy) return;
    const buf = pendingFrame;
    pendingFrame = null;
    busy = true;

    if (window.createImageBitmap) {
      createImageBitmap(new Blob([buf], { type: 'image/jpeg' }))
        .then((bmp) => {
          const old = lastSrc;
          lastSrc = bmp;
          draw(bmp);
          frames++;
          if (old && old.close) old.close();
        })
        .catch(() => {})
        .finally(() => { busy = false; });
    } else {
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      const img = new Image();
      img.onload = () => {
        lastSrc = img;
        draw(img);
        frames++;
        URL.revokeObjectURL(url);
        busy = false;
      };
      img.onerror = () => { URL.revokeObjectURL(url); busy = false; };
      img.src = url;
    }
  }

  function stats() {
    const now = performance.now();
    const dt = (now - statAt) / 1000;
    fpsShown = Math.round(frames / dt);
    const mbps = (bytesWindow / dt / 1024 / 1024).toFixed(1);
    frames = 0;
    bytesWindow = 0;
    statAt = now;
    if (!opened) return;
    const parts = [`${fpsShown} fps`, `${mbps} MB/s`];
    if (rtt != null) parts.push(`${rtt} ms`);
    setStat(parts.join(' · '));
  }

  function setStat(text, bad = false) {
    statEl.textContent = text;
    statEl.classList.toggle('bad', !!bad);
  }

  // ─────────────────────────────────────────── toạ độ
  function toNorm(clientX, clientY) {
    if (rotateUI) {
      // canvas đang bị xoay 90° -> đổi toạ độ chạm về hệ toạ độ gốc của ảnh
      const r = cv.getBoundingClientRect();
      const px = clientX - (r.left + r.width / 2);
      const py = clientY - (r.top + r.height / 2);
      const lw = cv.clientWidth || 1;
      const lh = cv.clientHeight || 1;
      const lx = lw / 2 + py;
      const ly = lh / 2 - px;
      return { x: clamp01(lx / lw), y: clamp01(ly / lh), inside: lx >= 0 && lx <= lw && ly >= 0 && ly <= lh };
    }
    const r = cv.getBoundingClientRect();
    const px = (clientX - r.left) * view.dpr;
    const py = (clientY - r.top) * view.dpr;
    const x = (px - view.dx) / (view.dw || 1);
    const y = (py - view.dy) / (view.dh || 1);
    return { x: clamp01(x), y: clamp01(y), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
  }

  function rippleAt(x, y) {
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    ripple.classList.remove('show');
    void ripple.offsetWidth;
    ripple.classList.add('show');
  }

  // ─────────────────────────────────────────── cử chỉ cảm ứng
  const pointers = new Map();
  let g = null;
  let lpTimer = null;
  let rightMode = false;
  let moveAt = 0;
  let wheelAcc = 0;
  let wheelTimer = null;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function moveTo(p) {
    const now = performance.now();
    if (now - moveAt < 16) return;
    moveAt = now;
    send({ t: 'm', x: p.x, y: p.y });
  }

  function flushWheel() {
    if (wheelTimer) return;
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      const d = Math.round(wheelAcc / 30);
      wheelAcc = 0;
      if (d) send({ t: 'w', d });
    }, 45);
  }

  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    holdUi();
    cv.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    rippleAt(e.clientX, e.clientY);

    // chuột phải thật (dùng trên PC)
    if (e.pointerType === 'mouse' && e.button === 2) {
      const p = toNorm(e.clientX, e.clientY);
      send({ t: 'c', x: p.x, y: p.y, b: 2 });
      return;
    }

    if (pointers.size === 1) {
      g = { mode: 'pending', sx: e.clientX, sy: e.clientY, t0: Date.now(), down: false };
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        if (g && g.mode === 'pending' && pointers.size === 1) {
          g.mode = 'lp';
          const p = toNorm(g.sx, g.sy);
          send({ t: 'c', x: p.x, y: p.y, b: 2 }); // giữ lâu = chuột phải
          buzz(12);
        }
      }, 520);
    } else if (pointers.size === 2) {
      clearTimeout(lpTimer);
      if (g && g.down) { send({ t: 'u', b: 1 }); g.down = false; }
      const [a, b] = [...pointers.values()];
      g = {
        mode: 'two',
        d0: Math.max(dist(a, b), 1),
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
        z0: zoom,
        px0: panX,
        py0: panY,
        mx0: (a.x + b.x) / 2,
        my0: (a.y + b.y) / 2,
      };
    }
  });

  cv.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !g) return;
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1 && (g.mode === 'pending' || g.mode === 'drag')) {
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      if (g.mode === 'pending' && Math.hypot(dx, dy) > 9) {
        clearTimeout(lpTimer);
        g.mode = 'drag';
        const p = toNorm(g.sx, g.sy);
        send({ t: 'd', x: p.x, y: p.y, b: 1 });
        g.down = true;
      }
      if (g.mode === 'drag') moveTo(toNorm(e.clientX, e.clientY));
      return;
    }

    if (pointers.size === 2 && g.mode === 'two') {
      const [a, b] = [...pointers.values()];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const d = dist(a, b);

      if (Math.abs(d - g.d0) > 16) {
        // pinch -> zoom cục bộ
        zoom = clamp((g.z0 * d) / g.d0, 1, 6);
        if (zoom === 1) { panX = 0; panY = 0; }
        else {
          panX = g.px0 + (mx - g.mx0);
          panY = g.py0 + (my - g.my0);
        }
        redrawLast();
      } else if (zoom > 1) {
        // đang zoom -> 2 ngón để di chuyển khung nhìn
        panX = g.px0 + (mx - g.mx0);
        panY = g.py0 + (my - g.my0);
        redrawLast();
      } else {
        // 2 ngón kéo -> cuộn
        wheelAcc += my - g.my;
        g.my = my;
        flushWheel();
      }
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    clearTimeout(lpTimer);

    if (!g) return;

    if (pointers.size === 0) {
      const quick = Date.now() - (g.t0 || 0) < 700;
      if (g.mode === 'pending' && quick) {
        const p = toNorm(e.clientX, e.clientY);
        send({ t: 'c', x: p.x, y: p.y, b: rightMode ? 2 : 1 });
        if (rightMode) { rightMode = false; $('#btnRight').classList.remove('active'); }
        buzz(8);
      }
      if (g.down) send({ t: 'u', b: 1 });
      g = null;
    } else if (pointers.size === 1) {
      // còn 1 ngón sau khi vừa dùng 2 ngón -> không click, chờ nhấc hết
      g = { mode: 'idle' };
    }
  }

  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);

  cv.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      wheelAcc += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      flushWheel();
    },
    { passive: false }
  );

  function buzz(ms) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch { /* ignore */ }
  }

  // ─────────────────────────────────────────── toolbar
  const kbPanel = $('#kbPanel');
  const cfgPanel = $('#cfgPanel');

  function togglePanel(el) {
    const open = el.hidden;
    kbPanel.hidden = true;
    cfgPanel.hidden = true;
    el.hidden = !open;
    if (!el.hidden) el.scrollTop = 0;
  }

  $('#btnKb').addEventListener('click', () => { holdUi(); togglePanel(kbPanel); });
  $('#btnCfg').addEventListener('click', () => { holdUi(); togglePanel(cfgPanel); });
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => { $('#' + b.dataset.close).hidden = true; })
  );

  $('#btnRight').addEventListener('click', (e) => {
    rightMode = !rightMode;
    e.currentTarget.classList.toggle('active', rightMode);
    buzz(10);
  });

  $('#btnFit').addEventListener('click', () => {
    zoom = 1; panX = 0; panY = 0;
    redrawLast();
  });

  $('#btnFull').addEventListener('click', () => {
    const btn = $('#btnFull');
    fsMode = !fsMode;
    wantLandscape = fsMode;

    // đổi giao diện NGAY, không await gì cả (một số máy/fullscreen API treo vô hạn)
    btn.classList.toggle('active', fsMode);
    syncOrientation();
    holdUi();

    try {
      if (fsMode) {
        const p = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
        const lock = () => {
          try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch { /* iOS */ }
        };
        if (p && typeof p.then === 'function') p.then(lock, lock);
        else lock();
      } else {
        try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
        const p = document.fullscreenElement ? document.exitFullscreen?.() : null;
        if (p && p.catch) p.catch(() => {});
      }
    } catch { /* trình duyệt không cho fullscreen */ }

    setTimeout(() => { syncOrientation(); holdUi(); }, 400);
  });

  document.addEventListener('fullscreenchange', () => {
    if (fsMode && !document.fullscreenElement) {
      // người dùng thoát fullscreen bằng nút back / ESC
      fsMode = false;
      wantLandscape = false;
      $('#btnFull').classList.remove('active');
      try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
      syncOrientation();
      appEl.classList.remove('tools-hidden');
    }
  });

  // ─────────────────────────────────────────── bàn phím
  const mods = new Set();
  document.querySelectorAll('[data-mod]').forEach((b) => {
    b.addEventListener('click', () => {
      const m = b.dataset.mod;
      if (mods.has(m)) mods.delete(m);
      else mods.add(m);
      b.classList.toggle('on', mods.has(m));
    });
  });

  function sendCombo(key) {
    const keys = [...mods, key].slice(0, 6);
    send({ t: 'k', keys });
    clearMods();
  }

  function clearMods() {
    mods.clear();
    document.querySelectorAll('[data-mod]').forEach((b) => b.classList.remove('on'));
  }

  document.querySelectorAll('[data-key]').forEach((b) => {
    b.addEventListener('click', () => sendCombo(b.dataset.key));
  });

  const txt = $('#txt');
  $('#sendTxt').addEventListener('click', () => {
    const s = txt.value;
    if (!s) return;
    send({ t: 'txt', s });
    txt.value = '';
    txt.blur();
  });

  const oneKey = $('#oneKey');
  $('#sendKey').addEventListener('click', () => {
    const v = oneKey.value.trim();
    if (v) sendCombo(v);
    oneKey.value = '';
  });

  // ─────────────────────────────────────────── cài đặt
  const selFps = $('#cfgFps');
  const selW = $('#cfgWidth');
  const selQ = $('#cfgQ');

  function applyCapture(c) {
    if (!c) return;
    selFps.value = String(c.fps);
    selW.value = String(c.width);
    selQ.value = String(c.quality);
  }

  function pushCfg() {
    send({
      t: 'cfg',
      fps: Number(selFps.value),
      width: Number(selW.value),
      quality: Number(selQ.value),
    });
  }
  [selFps, selW, selQ].forEach((s) => s.addEventListener('change', pushCfg));

  $('#btnReconnect').addEventListener('click', () => connect());
  $('#btnLogout').addEventListener('click', async () => {
    await fetch('/api/logout');
    location.reload();
  });

  // ─────────────────────────────────────────── go
  boot();
})();
