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

  let uiReady = false;
  function enterApp(info) {
    loginEl.hidden = true;
    appEl.hidden = false;
    resizeCanvas();
    if (info && info.capture) applyCapture(info.capture);
    connect();
    requestAnimationFrame(loop);
    setInterval(stats, 1000);
    if (!uiReady) {
      uiReady = true;
      restoreDock();
      initPhysKb();
    }
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
      releaseKeys(); // tránh kẹt phím trên máy đích khi mất kết nối
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
    // Chỉ tự ẩn khi ĐANG thật sự fullscreen. Nếu requestFullscreen bị từ chối
    // hoặc máy không hỗ trợ (iPhone), thanh công cụ phải ở lại — nếu không
    // người dùng phải chạm vào màn hình (và chạm đó lại click sang máy đích).
    if (fsMode && document.fullscreenElement) {
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
  const dock = $('#dock');
  const ball = $('#ball');
  const edgeTab = $('#edgeTab');

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

  // ─────────────────────────────── thanh công cụ: kéo thả · thu nhỏ · ẩn
  const DOCK_KEY = 'webgate.dock.v1';
  let uiMode = 'bar';   // 'bar' (đủ nút) | 'ball' (1 icon tròn) | 'hidden'
  let dockPos = null;   // { x, y } px, góc trên-trái

  function readDock() {
    try { return JSON.parse(localStorage.getItem(DOCK_KEY)) || {}; } catch { return {}; }
  }
  function writeDock() {
    try { localStorage.setItem(DOCK_KEY, JSON.stringify({ mode: uiMode, pos: dockPos })); }
    catch { /* chế độ riêng tư thì thôi */ }
  }

  function placeDock(x, y) {
    const r = dock.getBoundingClientRect();
    const w = r.width || 60;
    const h = r.height || 60;
    dockPos = {
      x: clamp(x, 4, Math.max(4, window.innerWidth - w - 4)),
      y: clamp(y, 4, Math.max(4, window.innerHeight - h - 4)),
    };
    dock.classList.add('placed');
    dock.style.left = dockPos.x + 'px';
    dock.style.top = dockPos.y + 'px';
    dock.style.bottom = 'auto';
  }

  function positionEdgeTab() {
    const p = dockPos || { x: window.innerWidth / 2, y: window.innerHeight - 70 };
    const leftSide = p.x + 25 < window.innerWidth / 2;
    edgeTab.style.left = leftSide ? '0px' : 'auto';
    edgeTab.style.right = leftSide ? 'auto' : '0px';
    edgeTab.style.top = clamp(p.y, 6, window.innerHeight - 62) + 'px';
  }

  function setMode(mode) {
    // nhớ vị trí đang đứng trước khi đổi kích thước (bar <-> ball)
    if (uiMode !== 'hidden' && !dock.hidden) {
      const r = dock.getBoundingClientRect();
      if (r.width) dockPos = { x: r.left, y: r.top };
    }
    uiMode = mode;
    dock.classList.toggle('mode-ball', mode === 'ball');
    dock.hidden = mode === 'hidden';
    edgeTab.hidden = mode !== 'hidden';
    if (mode === 'hidden') positionEdgeTab();
    else if (dockPos) placeDock(dockPos.x, dockPos.y);
    writeDock();
  }

  /**
   * Kéo thả cho 1 phần tử, đồng thời phân biệt chạm / kéo / nhấn giữ.
   * Chạm mà không di chuyển -> onTap. Giữ lâu -> onHold.
   */
  function draggable(el, { onTap, onHold, holdMs = 600 } = {}) {
    let id = null, sx = 0, sy = 0, ox = 0, oy = 0;
    let moved = false, held = false, holdTimer = null;
    let dragEndedAt = 0;
    const stopHold = () => { clearTimeout(holdTimer); holdTimer = null; };

    // Chặn cú click sinh ra ngay sau khi kéo (tránh bấm nhầm nút), nhưng chỉ
    // trong 350ms — nếu dùng listener một-lần thì nó sẽ nuốt cú chạm sau đó.
    el.addEventListener('click', (ev) => {
      if (performance.now() - dragEndedAt < 350) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    }, true);

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      id = e.pointerId;
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY;
      ox = r.left; oy = r.top;
      moved = false; held = false;
      // KHÔNG capture ở đây: capture ngay lập tức sẽ khiến pointerup nhắm vào
      // #dock chứ không phải nút, và trình duyệt bắn "click" cho #dock ->
      // mọi nút trên thanh công cụ mất tác dụng. Chỉ capture khi đã kéo thật.
      if (onHold) holdTimer = setTimeout(() => { held = true; onHold(); }, holdMs);
    });

    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      if (!moved) {
        moved = true;
        stopHold();
        el.classList.add('dragging');
        try { el.setPointerCapture?.(id); } catch { /* pointer tổng hợp không có thật */ }
      }
      placeDock(ox + dx, oy + dy);
      e.preventDefault();
    });

    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      stopHold();
      el.classList.remove('dragging');
      if (moved) {
        dragEndedAt = performance.now();
        writeDock();
      } else if (!held && onTap) {
        onTap();
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // nếu người dùng kéo nhanh ra khỏi phần tử trước khi vượt ngưỡng capture
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  draggable(dock);
  draggable(ball, {
    onTap: () => { setMode('bar'); holdUi(); buzz(6); },
    onHold: () => { setMode('hidden'); buzz(24); },
  });

  $('#btnFold').addEventListener('click', () => { holdUi(); setMode('ball'); buzz(6); });
  $('#btnClose').addEventListener('click', () => { setMode('hidden'); buzz(10); });
  edgeTab.addEventListener('click', () => { setMode('ball'); holdUi(); });

  function restoreDock() {
    const s = readDock();
    if (s.pos && Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y)) {
      placeDock(s.pos.x, s.pos.y);
    } else {
      const r = dock.getBoundingClientRect();
      dockPos = { x: r.left, y: r.top };
    }
    setMode(s.mode === 'ball' || s.mode === 'hidden' ? s.mode : 'bar');
  }

  window.addEventListener('resize', () => {
    if (uiMode === 'hidden') positionEdgeTab();
    else if (dockPos) placeDock(dockPos.x, dockPos.y);
  });

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
        const after = () => {
          try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch { /* iOS */ }
          lockKeys(); // xin khoá phím ngay khi đã fullscreen
        };
        // bị từ chối (iframe, quyền, máy không hỗ trợ) -> trả giao diện về như cũ
        const fail = () => {
          if (document.fullscreenElement) return;
          fsMode = false;
          wantLandscape = false;
          btn.classList.remove('active');
          syncOrientation();
          holdUi();
        };
        if (p && typeof p.then === 'function') p.then(after, fail);
        else after();
      } else {
        try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
        unlockKeys();
        const p = document.fullscreenElement ? document.exitFullscreen?.() : null;
        if (p && p.catch) p.catch(() => {});
      }
    } catch { /* trình duyệt không cho fullscreen */ }

    setTimeout(() => { syncOrientation(); holdUi(); }, 400);
  });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      unlockKeys(); // ra khỏi fullscreen thì trả phím lại cho trình duyệt
    }
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

  // ─────────────────────────────────── bàn phím thật của máy đang xem
  // Ý tưởng: chuyển thẳng KeyboardEvent -> virtual-key của Windows, gửi từng
  // phím nhấn/nhả riêng (không phải tổ hợp đóng gói sẵn) nên Ctrl/Shift/Alt,
  // giữ phím, F1–F12, mũi tên… đều hoạt động như bàn phím cắm trực tiếp.
  const VK_CODE = {
    Backspace: 8, Tab: 9, Enter: 13, ShiftLeft: 16, ShiftRight: 16,
    ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18,
    Pause: 19, CapsLock: 20, Escape: 27, Space: 32,
    PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    PrintScreen: 44, Insert: 45, Delete: 46,
    MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
    NumLock: 144, ScrollLock: 145,
    Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190,
    Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220,
    BracketRight: 221, Quote: 222, IntlBackslash: 226,
    NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109,
    NumpadDecimal: 110, NumpadDivide: 111, NumpadEnter: 13,
  };
  for (let i = 0; i < 26; i++) VK_CODE['Key' + String.fromCharCode(65 + i)] = 65 + i;
  for (let i = 0; i <= 9; i++) {
    VK_CODE['Digit' + i] = 48 + i;
    VK_CODE['Numpad' + i] = 96 + i;
  }
  for (let i = 1; i <= 24; i++) VK_CODE['F' + i] = 111 + i;

  // phím cần cờ "extended" (nếu thiếu sẽ bị hiểu thành phím numpad)
  const VK_EXT = new Set([45, 46, 35, 36, 33, 34, 37, 38, 39, 40, 44, 93, 144, 111]);

  const PHYS_KEY = 'webgate.physkbd';
  const heldVk = new Map(); // vk -> ext, để nhả hết khi mất focus
  let physOn = false;
  let kbLocked = false;     // đã khoá phím ở tầng trình duyệt (Keyboard Lock API)

  function isTyping(el) {
    if (!el) return false;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
  }

  // phím trình duyệt/HĐH giữ riêng, không chặn được -> trả lại cho nó
  function browserOwned(e) {
    // Đã khoá phím (Keyboard Lock) -> trình duyệt nhả hết cho trang
    if (kbLocked) return false;
    if (e.code === 'F5' || e.code === 'F11' || e.code === 'F12') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.code === 'KeyW' || e.code === 'KeyT' || e.code === 'KeyN')) return true;
    if (mod && e.shiftKey && (e.code === 'KeyI' || e.code === 'KeyJ' || e.code === 'KeyC')) return true;
    if (mod && e.code === 'Tab') return true;
    return false;
  }

  function vkFor(e) {
    const vk = VK_CODE[e.code];
    if (!vk) return null;
    return { vk, ext: VK_EXT.has(vk) || e.code === 'NumpadEnter' };
  }

  function releaseKeys() {
    for (const [vk, ext] of heldVk) send({ t: 'ku', vk, ext });
    heldVk.clear();
  }

  function onKeyDown(e) {
    if (!physOn || appEl.hidden || !opened) return;
    if (isTyping(e.target)) return;
    if (browserOwned(e)) return;
    const k = vkFor(e);
    if (!k) return;
    e.preventDefault();
    heldVk.set(k.vk, k.ext);
    // gửi cả khi e.repeat -> Windows tự hiểu là giữ phím (auto-repeat)
    send({ t: 'kd', vk: k.vk, ext: k.ext });
  }

  function onKeyUp(e) {
    if (!physOn || appEl.hidden || !opened) return;
    if (isTyping(e.target)) return;
    const k = vkFor(e);
    if (!k) return;
    e.preventDefault();
    if (!heldVk.delete(k.vk)) return;
    send({ t: 'ku', vk: k.vk, ext: k.ext });
  }

  const physBox = $('#cfgPhys');
  const kbOn = $('#kbOn');

  function updateKbBadge() {
    if (!kbOn) return;
    kbOn.hidden = !physOn;
    kbOn.textContent = kbLocked ? '⌨ phím thật · đã khoá phím' : '⌨ phím thật';
  }

  /**
   * Khoá bàn phím ở tầng trình duyệt (Keyboard Lock API).
   * Điều kiện: HTTPS hoặc localhost + đang fullscreen + Chrome/Edge (Chromium).
   * Đổi lại: Ctrl+W, Ctrl+T, Ctrl+Tab, Esc… được gửi sang máy đích thay vì
   * bị trình duyệt/HĐH nuốt mất.
   */
  async function lockKeys() {
    if (!physOn || !document.fullscreenElement || !navigator.keyboard?.lock) return false;
    try {
      await navigator.keyboard.lock();
      kbLocked = true;
    } catch {
      kbLocked = false; // bị từ chối quyền / trình duyệt không hỗ trợ
    }
    updateKbBadge();
    return kbLocked;
  }

  function unlockKeys() {
    if (!kbLocked) return;
    try { navigator.keyboard?.unlock?.(); } catch { /* ignore */ }
    kbLocked = false;
    updateKbBadge();
  }

  function setPhysKb(on, persist = true) {
    if (!on) releaseKeys();
    physOn = !!on;
    physBox.checked = physOn;
    if (!physOn) unlockKeys();
    else lockKeys(); // đang fullscreen sẵn thì khoá luôn, khỏi phải vào lại
    updateKbBadge();
    if (persist) {
      try { localStorage.setItem(PHYS_KEY, physOn ? '1' : '0'); } catch { /* ignore */ }
    }
  }

  physBox.addEventListener('change', () => setPhysKb(physBox.checked));

  function initPhysKb() {
    let saved = null;
    try { saved = localStorage.getItem(PHYS_KEY); } catch { /* ignore */ }
    // máy có chuột thật + bàn phím (laptop/PC) -> mặc định bật
    const fine = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
    setPhysKb(saved === null ? !!fine : saved === '1', false);
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', releaseKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseKeys(); });

  // ─────────────────────────────────────────── cài đặt
  const selFps = $('#cfgFps');
  const selW = $('#cfgWidth');
  const selQ = $('#cfgQ');
  const selPreset = $('#cfgPreset');

  /** Chọn lại preset khớp với cặp (độ rộng, chất lượng) hiện tại, không khớp thì "Tuỳ chỉnh". */
  function syncPreset() {
    const want = `${selW.value},${selQ.value}`;
    const has = Array.from(selPreset.options).some((o) => o.value === want);
    selPreset.value = has ? want : 'custom';
  }

  function applyCapture(c) {
    if (!c) return;
    selFps.value = String(c.fps);
    selW.value = String(c.width);
    selQ.value = String(c.quality);
    syncPreset();
  }

  function pushCfg() {
    send({
      t: 'cfg',
      fps: Number(selFps.value),
      width: Number(selW.value),
      quality: Number(selQ.value),
    });
  }

  [selFps, selW, selQ].forEach((s) =>
    s.addEventListener('change', () => {
      syncPreset();
      pushCfg();
    }),
  );

  // preset chỉ là lối tắt: ghi giá trị vào 2 select rồi gửi đi như bình thường
  selPreset.addEventListener('change', () => {
    if (selPreset.value === 'custom') return;
    const [w, q] = selPreset.value.split(',');
    selW.value = w;
    selQ.value = q;
    pushCfg();
  });

  $('#btnReconnect').addEventListener('click', () => connect());
  $('#btnLogout').addEventListener('click', async () => {
    await fetch('/api/logout');
    location.reload();
  });

  // ─────────────────────────────────────────── go
  boot();
})();
