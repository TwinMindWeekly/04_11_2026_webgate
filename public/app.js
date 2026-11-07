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
  let needRedraw = false;           // con trỏ / khung nhìn đổi -> vẽ lại ở khung hình kế
  let busy = false;
  let frames = 0;
  let fpsShown = 0;
  let bytesWindow = 0;
  let statAt = performance.now();
  let rtt = null;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const clamp01 = (v) => clamp(v, 0, 1);

  // ─────────────────────────────────────────── khởi động / đăng nhập
  /**
   * Chạy sau Cloudflare Access: khi phiên Access hết hạn, mọi request bị
   * chuyển hướng sang trang đăng nhập email của Cloudflare. fetch() không theo
   * được (khác domain) -> nhận ra bằng redirect:'manual' rồi tải lại cả trang
   * để Cloudflare hiện màn hình xác thực.
   */
  async function accessExpired() {
    try {
      const r = await fetch('/api/info', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
      return r.type === 'opaqueredirect';
    } catch {
      return false;
    }
  }

  async function boot() {
    try {
      const r = await fetch('/api/info', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
      if (r.type === 'opaqueredirect') {
        location.reload();
        return;
      }
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
    if (!uiReady) {
      uiReady = true;
      requestAnimationFrame(loop);
      setInterval(stats, 1000);
      restoreDock();
      initPhysKb();
      initCtrlMode();
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
      releaseGestures();
      setStat(e.code === 1008 || e.code === 4401 ? 'hết phiên' : 'mất kết nối…');
      if (e.code === 1008 || e.code === 4401) {
        boot();
        return;
      }
      retry = Math.min(retry + 1, 6);
      if (retry === 3) accessExpired().then((x) => { if (x) location.reload(); });
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
    if (msg.t === 'info' && typeof msg.touch === 'boolean' && msg.touch !== touchAvail) {
      touchAvail = msg.touch;
      setCtrlMode(mode, { persist: false, announce: false });
    }
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
    // không cho kéo ảnh ra khỏi khung (tránh lộ nền đen khi đang phóng to)
    const maxX = Math.max(0, (dw - cw) / 2) / dpr;
    const maxY = Math.max(0, (dh - ch) / 2) / dpr;
    panX = clamp(panX, -maxX, maxX);
    panY = clamp(panY, -maxY, maxY);
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
    drawCursor();
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
    if (needRedraw && !pendingFrame) {
      needRedraw = false;
      redrawLast();
    }
    if (!pendingFrame || busy) return;
    needRedraw = false;
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

  // ─────────────────────────────────────────── chế độ điều khiển
  // 'touch' : CHẠM TRỰC TIẾP — như Windows tablet. Ngón tay được bơm vào Windows
  //           dưới dạng cảm ứng thật, Windows tự hiểu chạm/giữ/cuộn/chụm/vuốt.
  // 'pad'   : TOUCHPAD — như chế độ chuột của Microsoft Remote Desktop. Có con
  //           trỏ, kéo 1 ngón để di chuột, chạm để click. Chính xác trên màn nhỏ.
  const MODE_KEY = 'webgate.mode.v1';
  const SPEED_KEY = 'webgate.padspeed.v1';
  let mode = 'pad';
  let touchAvail = true;     // server dùng được InjectTouchInput
  let viewMode = false;      // 🔍 đang chỉnh khung nhìn (không gửi gì sang máy)
  let padSpeed = 1;
  const cur = { x: 0.5, y: 0.5 }; // con trỏ của chế độ touchpad (0..1)

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const centroid = (list) => {
    let x = 0, y = 0;
    for (const p of list) { x += p.x; y += p.y; }
    return { x: x / list.length, y: y / list.length };
  };

  /** Điện thoại -> touchpad (màn nhỏ, chạm trực tiếp khó trúng); tablet -> chạm trực tiếp. */
  function defaultMode() {
    const small = Math.min(window.screen.width, window.screen.height) < 600;
    return small ? 'pad' : 'touch';
  }

  function effMode() {
    return mode === 'touch' && touchAvail ? 'touch' : 'pad';
  }

  // ─────────────────────────────── gửi di chuyển (throttle + luôn gửi điểm cuối)
  let moveAt = 0;
  let moveTimer = null;
  let moveLast = null;
  function sendMove(p) {
    moveLast = p;
    const now = performance.now();
    const wait = 16 - (now - moveAt);
    if (wait <= 0) {
      moveAt = now;
      send({ t: 'm', x: p.x, y: p.y });
      return;
    }
    if (!moveTimer) {
      moveTimer = setTimeout(() => {
        moveTimer = null;
        moveAt = performance.now();
        send({ t: 'm', x: moveLast.x, y: moveLast.y });
      }, wait);
    }
  }

  let wheelAcc = 0;
  let wheelTimer = null;
  function flushWheel() {
    if (wheelTimer) return;
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      const d = Math.round(wheelAcc / 30);
      wheelAcc -= d * 30;
      if (d) send({ t: 'w', d });
    }, 45);
  }

  function buzz(ms) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch { /* ignore */ }
  }

  // ─────────────────────────────── bộ định tuyến pointer
  // Mỗi ngón được gán cho một bộ xử lý lúc chạm xuống, đổi chế độ giữa chừng
  // không làm gãy cử chỉ đang dở.
  const owner = new Map(); // pointerId -> 'mouse' | 'view' | 'touch' | 'pad'

  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    holdUi();
    try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    let who;
    if (e.pointerType === 'mouse') who = 'mouse';
    else if (viewMode) who = 'view';
    else who = effMode();
    owner.set(e.pointerId, who);
    if (who !== 'mouse') rippleAt(e.clientX, e.clientY);
    H[who].down(e);
  });

  cv.addEventListener('pointermove', (e) => {
    const who = owner.get(e.pointerId);
    if (!who) {
      // chuột thật lướt qua (không bấm) -> di con trỏ trên máy đích
      if (e.pointerType === 'mouse' && !viewMode) {
        const p = toNorm(e.clientX, e.clientY);
        if (p.inside) sendMove(p);
      }
      return;
    }
    e.preventDefault();
    H[who].move(e);
  });

  function endPointer(e, cancel) {
    const who = owner.get(e.pointerId);
    if (!who) return;
    owner.delete(e.pointerId);
    H[who].up(e, cancel);
  }
  cv.addEventListener('pointerup', (e) => endPointer(e, false));
  cv.addEventListener('pointercancel', (e) => endPointer(e, true));

  cv.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      wheelAcc -= e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      flushWheel();
    },
    { passive: false }
  );

  // ─────────────────────────────── chuột thật (mở WebGate trên PC/laptop)
  const MOUSE_BTN = { 0: 1, 1: 3, 2: 2 };
  let mouseBtn = 1;
  const mouseH = {
    down(e) {
      const p = toNorm(e.clientX, e.clientY);
      mouseBtn = MOUSE_BTN[e.button] || 1;
      send({ t: 'd', x: p.x, y: p.y, b: mouseBtn });
    },
    move(e) {
      sendMove(toNorm(e.clientX, e.clientY));
    },
    up(e) {
      const p = toNorm(e.clientX, e.clientY);
      sendMove(p);
      send({ t: 'u', b: mouseBtn });
    },
  };

  // ─────────────────────────────── CHẠM TRỰC TIẾP (cảm ứng thật kiểu Windows tablet)
  const slots = new Map();   // pointerId -> slot 0..9
  const tq = new Map();      // slot -> { id, x, y, ph } chờ gửi
  let tRaf = 0;
  let tAlive = null;

  // Ngón giữ yên không sinh pointermove -> server tưởng mất mạng và huỷ ngón
  // sau 1.5s (giữ để chuột phải / giữ rồi kéo sẽ hỏng). Gửi khung rỗng định kỳ
  // để báo "vẫn đang chạm"; server tự nhắc lại vị trí cho Windows.
  function tKeepalive() {
    if (slots.size && !tAlive) {
      tAlive = setInterval(() => { if (slots.size) send({ t: 'tch', pts: [] }); }, 400);
    } else if (!slots.size && tAlive) {
      clearInterval(tAlive);
      tAlive = null;
    }
  }

  function freeSlot() {
    const used = new Set(slots.values());
    for (let i = 0; i < 10; i++) if (!used.has(i)) return i;
    return -1;
  }

  function tFlush() {
    cancelAnimationFrame(tRaf);
    tRaf = 0;
    if (!tq.size) return;
    send({ t: 'tch', pts: [...tq.values()] });
    tq.clear();
  }

  const tPos = new Map();    // pointerId -> { x, y } px CSS (để chuyển sang zoom)

  /**
   * Ngón thứ 2 chạm xuống: chuyển cả cử chỉ sang PHÓNG TO KHUNG NHÌN tại điện thoại
   * (chụm = zoom, 2 ngón kéo = di khung). Ngón đầu bị huỷ (UP|CANCELED) nên
   * Windows không sinh click. Nhấc hết ngón thì quay lại chạm trực tiếp.
   */
  function touchToView(e) {
    const prev = [...slots.keys()].map((id) => [id, tPos.get(id)]);
    touchReset(); // xoá cả tPos -> đã chụp lại vị trí ở trên
    for (const [id, p] of prev) {
      if (!p) continue;
      owner.set(id, 'view');
      vp.set(id, p);
    }
    owner.set(e.pointerId, 'view');
    viewH.down(e);
  }

  const touchH = {
    down(e) {
      if (slots.size) { touchToView(e); return; }
      tPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const s = freeSlot();
      if (s < 0) return;
      slots.set(e.pointerId, s);
      const p = toNorm(e.clientX, e.clientY);
      tq.set(s, { id: s, x: p.x, y: p.y, ph: 'd' });
      tFlush(); // chạm xuống gửi ngay, không chờ khung hình
      tKeepalive();
    },
    move(e) {
      const s = slots.get(e.pointerId);
      if (s == null) return;
      tPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = toNorm(e.clientX, e.clientY);
      const q = tq.get(s);
      if (q) { q.x = p.x; q.y = p.y; } // giữ nguyên pha 'd' nếu chưa kịp gửi
      else tq.set(s, { id: s, x: p.x, y: p.y, ph: 'm' });
      if (!tRaf) tRaf = requestAnimationFrame(tFlush); // gộp di chuyển theo khung hình
    },
    up(e, cancel) {
      const s = slots.get(e.pointerId);
      tPos.delete(e.pointerId);
      if (s == null) return;
      slots.delete(e.pointerId);
      const p = toNorm(e.clientX, e.clientY);
      const q = tq.get(s);
      if (q && q.ph === 'd') tFlush(); // DOWN chưa đi thì cho nó đi trước
      tq.set(s, { id: s, x: p.x, y: p.y, ph: cancel ? 'c' : 'u' });
      tFlush();
      tKeepalive();
    },
  };

  /** Nhấc mọi ngón đang chạm (đổi chế độ, mất focus, ẩn tab…) mà không sinh click. */
  function touchReset() {
    if (!slots.size) return;
    for (const id of slots.keys()) owner.delete(id);
    slots.clear();
    tq.clear();
    tPos.clear();
    tKeepalive();
    send({ t: 'tcx' });
  }

  // ─────────────────────────────── TOUCHPAD (con trỏ + cử chỉ kiểu touchpad Windows)
  const pp = new Map();   // pointerId -> { x, y } (px CSS)
  let pg = null;          // cử chỉ đang diễn ra
  let lpTimer = null;
  let tapTimer = null;    // click đơn đang chờ (để phân biệt chạm 2 lần / chạm-rồi-kéo)
  let lastTapAt = 0;
  const TAP_MS = 260;
  const DBL_MS = 280;

  /** delta px trên màn điện thoại -> delta theo hướng của ảnh (xử lý khi xoay 90°) */
  function imgDelta(dx, dy) {
    return rotateUI ? { dx: dy, dy: -dx } : { dx, dy };
  }

  function moveCursor(dx, dy, dt) {
    const d = imgDelta(dx, dy);
    const v = Math.hypot(d.dx, d.dy) / Math.max(dt, 1);  // px/ms
    const gain = clamp(0.6 + v * 1.2, 0.6, 3) * padSpeed; // gia tốc như chuột Windows
    const wCss = (view.dw || 1) / view.dpr;
    const hCss = (view.dh || 1) / view.dpr;
    cur.x = clamp01(cur.x + (d.dx * gain) / wCss);
    cur.y = clamp01(cur.y + (d.dy * gain) / hCss);
    followCursor();
    needRedraw = true;
    sendMove(cur);
  }

  /** Khi đang phóng to: kéo khung nhìn theo con trỏ để con trỏ không chạy ra ngoài. */
  function followCursor() {
    if (zoom <= 1) return;
    const dpr = view.dpr;
    const cw = cv.width / dpr, ch = cv.height / dpr;
    const x = (view.dx + cur.x * view.dw) / dpr;
    const y = (view.dy + cur.y * view.dh) / dpr;
    const mx = cw * 0.18, my = ch * 0.18;
    if (x < mx) panX += mx - x;
    else if (x > cw - mx) panX -= x - (cw - mx);
    if (y < my) panY += my - y;
    else if (y > ch - my) panY -= y - (ch - my);
  }

  function clickAt(b, n = 1) {
    for (let i = 0; i < n; i++) send({ t: 'c', x: cur.x, y: cur.y, b });
  }

  function flushTap() {
    if (!tapTimer) return;
    clearTimeout(tapTimer);
    tapTimer = null;
    clickAt(1);
  }

  const padH = {
    down(e) {
      pp.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = performance.now();
      clearTimeout(lpTimer);

      if (pp.size === 1) {
        const second = !!tapTimer && now - lastTapAt < DBL_MS;
        if (second) { clearTimeout(tapTimer); tapTimer = null; }
        pg = { mode: 'pending', second, t0: now, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, lt: now, maxN: 1 };
        lpTimer = setTimeout(() => {
          if (pg && pg.mode === 'pending' && pg.maxN === 1) {
            pg.mode = 'done';
            clickAt(2); // giữ lâu = chuột phải (như giữ trên Windows tablet)
            buzz(14);
          }
        }, 550);
        return;
      }

      // thêm ngón -> cử chỉ nhiều ngón
      if (pg && pg.mode === 'drag') send({ t: 'u', b: 1 });
      if (pg && pg.second) clickAt(1); // chạm lần 2 hoá ra là 2 ngón: trả lại click lần 1
      const list = [...pp.values()];
      const c = centroid(list);
      pg = {
        mode: 'multi',
        t0: pg && pg.mode !== 'done' && pg.maxN === 1 && now - pg.t0 < 160 ? pg.t0 : now,
        maxN: Math.max(pp.size, pg ? pg.maxN : 1),
        moved: false,
        kind: null,          // 'scroll' | 'pinch'
        c0: c, cl: c,
        d0: pp.size === 2 ? Math.max(dist(list[0], list[1]), 1) : 0,
        z0: zoom, px0: panX, py0: panY,
      };
    },

    move(e) {
      if (!pp.has(e.pointerId) || !pg) return;
      pp.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const now = performance.now();

      if (pp.size === 1 && (pg.mode === 'pending' || pg.mode === 'move' || pg.mode === 'drag')) {
        if (pg.mode === 'pending') {
          if (Math.hypot(e.clientX - pg.sx, e.clientY - pg.sy) < 7) return;
          clearTimeout(lpTimer);
          pg.mode = pg.second ? 'drag' : 'move';
          if (pg.mode === 'drag') send({ t: 'd', x: cur.x, y: cur.y, b: 1 }); // chạm-rồi-kéo = giữ chuột trái
        }
        moveCursor(e.clientX - pg.lx, e.clientY - pg.ly, now - pg.lt);
        pg.lx = e.clientX; pg.ly = e.clientY; pg.lt = now;
        return;
      }

      if (pg.mode !== 'multi') return;
      const list = [...pp.values()];
      const c = centroid(list);
      if (!pg.moved && dist(c, pg.c0) > 8) pg.moved = true;

      if (pp.size === 2) {
        const d = dist(list[0], list[1]);
        if (!pg.kind && Math.abs(d - pg.d0) > 28) pg.kind = 'pinch';
        else if (!pg.kind && pg.moved) pg.kind = 'scroll';

        if (pg.kind === 'pinch') {
          pg.moved = true;
          zoom = clamp((pg.z0 * d) / pg.d0, 1, 6);
          panX = pg.px0 + (c.x - pg.c0.x);
          panY = pg.py0 + (c.y - pg.c0.y);
          if (zoom === 1) { panX = 0; panY = 0; }
          needRedraw = true;
        } else if (pg.kind === 'scroll') {
          const d2 = imgDelta(c.x - pg.cl.x, c.y - pg.cl.y);
          wheelAcc += d2.dy; // cuộn tự nhiên: kéo xuống = nội dung đi xuống
          flushWheel();
        }
      }
      pg.cl = c;
    },

    up(e) {
      pp.delete(e.pointerId);
      clearTimeout(lpTimer);
      if (!pg) return;
      const now = performance.now();

      if (pg.mode === 'multi') {
        if (pp.size) return; // chờ nhấc hết ngón
        const quick = now - pg.t0 < 320;
        if (!pg.moved && quick) {
          if (pg.maxN === 2) { clickAt(2); buzz(10); }             // chạm 2 ngón = chuột phải
          else if (pg.maxN === 3) { send({ t: 'k', keys: ['WIN', 'S'] }); buzz(10); } // 3 ngón = tìm kiếm
        } else if (pg.maxN === 3 && pg.cl && pg.c0) {
          // vuốt 3 ngón — giống touchpad Windows
          const d = imgDelta(pg.cl.x - pg.c0.x, pg.cl.y - pg.c0.y);
          if (Math.max(Math.abs(d.dx), Math.abs(d.dy)) > 50) {
            if (Math.abs(d.dy) > Math.abs(d.dx)) send({ t: 'k', keys: d.dy < 0 ? ['WIN', 'TAB'] : ['WIN', 'D'] });
            else send({ t: 'k', keys: ['ALT', 'TAB'] });
            buzz(12);
          }
        }
        pg = null;
        return;
      }

      if (pp.size) return;
      if (pg.mode === 'pending' && now - pg.t0 < TAP_MS + 200) {
        if (pg.second) {
          clickAt(1, 2); // chạm 2 lần = double click
        } else {
          // đợi xem có chạm lần 2 không (chạm-rồi-kéo / double click)
          lastTapAt = now;
          tapTimer = setTimeout(() => { tapTimer = null; clickAt(1); }, DBL_MS);
        }
        buzz(6);
      } else if (pg.mode === 'drag') {
        send({ t: 'u', b: 1 });
      }
      pg = null;
    },
  };

  // ─────────────────────────────── 🔍 chỉnh khung nhìn (chỉ phía điện thoại)
  const vp = new Map();
  let vg = null;
  let vTapAt = 0;
  /** lấy mốc mới mỗi khi số ngón thay đổi để khung nhìn không giật */
  function vBase(t0, moved) {
    const list = [...vp.values()];
    const c = centroid(list);
    vg = { c0: c, d0: list.length === 2 ? Math.max(dist(list[0], list[1]), 1) : 0, z0: zoom, px0: panX, py0: panY, t0, moved };
  }
  const viewH = {
    down(e) {
      vp.set(e.pointerId, { x: e.clientX, y: e.clientY });
      vBase(vg ? vg.t0 : performance.now(), vg ? vg.moved : false);
    },
    move(e) {
      if (!vp.has(e.pointerId) || !vg) return;
      vp.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const list = [...vp.values()];
      const c = centroid(list);
      if (dist(c, vg.c0) > 6) vg.moved = true;
      if (list.length === 2 && vg.d0) {
        zoom = clamp((vg.z0 * dist(list[0], list[1])) / vg.d0, 1, 6);
        vg.moved = true;
      }
      panX = vg.px0 + (c.x - vg.c0.x);
      panY = vg.py0 + (c.y - vg.c0.y);
      if (zoom === 1) { panX = 0; panY = 0; }
      needRedraw = true;
    },
    up(e) {
      vp.delete(e.pointerId);
      if (vp.size) { vBase(vg ? vg.t0 : performance.now(), true); return; }
      const now = performance.now();
      if (vg && !vg.moved && now - vg.t0 < 300) {
        if (now - vTapAt < 320) { zoom = 1; panX = 0; panY = 0; needRedraw = true; } // chạm 2 lần = về 1:1
        vTapAt = now;
      }
      vg = null;
    },
  };

  const H = { mouse: mouseH, touch: touchH, pad: padH, view: viewH };

  // mất focus / ẩn tab giữa chừng -> nhả hết, tránh kẹt ngón / kẹt chuột
  function releaseGestures() {
    touchReset();
    if (pg && pg.mode === 'drag') send({ t: 'u', b: 1 });
    pg = null;
    pp.clear();
    vp.clear();
    owner.clear();
    clearTimeout(lpTimer);
  }
  window.addEventListener('blur', releaseGestures);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseGestures(); });

  // ─────────────────────────────── thông báo ngắn
  const toastEl = $('#toast');
  let toastTimer = null;
  function toast(html, ms = 3200) {
    toastEl.innerHTML = html;
    toastEl.hidden = false;
    toastEl.classList.remove('show');
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  const MODE_HELP = {
    touch: '<b>👆 Chạm trực tiếp</b> — như Windows tablet<br>Chạm = click · giữ = chuột phải · 1 ngón kéo = cuộn/kéo · 2 ngón chụm = phóng to màn hình, 2 ngón kéo = di khung',
    pad: '<b>🖱️ Touchpad</b> — có con trỏ chuột<br>Kéo = di chuột · chạm = click · chạm 2 ngón = chuột phải · 2 ngón kéo = cuộn · chạm rồi kéo = kéo thả',
  };

  function setCtrlMode(m, { persist = true, announce = true } = {}) {
    releaseGestures();
    mode = m === 'touch' ? 'touch' : 'pad';
    if (persist) { try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ } }
    const eff = effMode();
    const btn = $('#btnMode');
    btn.textContent = eff === 'touch' ? '👆' : '🖱️';
    btn.title = eff === 'touch' ? 'Đang: chạm trực tiếp · bấm để đổi sang touchpad' : 'Đang: touchpad · bấm để đổi sang chạm trực tiếp';
    $('#cfgMode').value = mode;
    needRedraw = true;
    if (announce) {
      if (mode === 'touch' && !touchAvail) toast('Máy tính này không bơm được cảm ứng thật — dùng <b>touchpad</b>.');
      else toast(MODE_HELP[eff]);
    }
  }

  function setViewMode(on) {
    releaseGestures();
    viewMode = !!on;
    $('#btnZoom').classList.toggle('active', viewMode);
    appEl.classList.toggle('view-mode', viewMode);
    if (viewMode) toast('<b>🔍 Chỉnh khung nhìn</b><br>Chụm để phóng to · kéo để di chuyển · chạm 2 lần = vừa màn hình<br>Bấm 🔍 lần nữa để điều khiển tiếp', 4200);
  }

  function initCtrlMode() {
    let saved = null;
    let sp = null;
    try { saved = localStorage.getItem(MODE_KEY); sp = localStorage.getItem(SPEED_KEY); } catch { /* ignore */ }
    padSpeed = Number(sp) || 1;
    $('#cfgSpeed').value = String(padSpeed);
    setCtrlMode(saved || defaultMode(), { persist: false, announce: true });
  }

  /** Vẽ con trỏ (chế độ touchpad) đè lên khung hình — phản hồi tức thì, không chờ mạng. */
  function drawCursor() {
    if (effMode() !== 'pad' || viewMode || !RW) return;
    const s = 1.15 * view.dpr;
    const x = view.dx + cur.x * view.dw;
    const y = view.dy + cur.y * view.dh;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 17);
    ctx.lineTo(4.4, 13);
    ctx.lineTo(7.4, 19.6);
    ctx.lineTo(10.2, 18.4);
    ctx.lineTo(7.3, 12);
    ctx.lineTo(13, 12);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.3;
    ctx.lineJoin = 'round';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ─────────────────────────────────────────── toolbar
  const kbPanel = $('#kbPanel');
  const cfgPanel = $('#cfgPanel');
  const dock = $('#dock');
  const ball = $('#ball');

  function togglePanel(el) {
    const open = el.hidden;
    kbPanel.hidden = true;
    cfgPanel.hidden = true;
    el.hidden = !open;
    if (!el.hidden) el.scrollTop = 0;
  }

  $('#btnCfg').addEventListener('click', () => { holdUi(); togglePanel(cfgPanel); });
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => { $('#' + b.dataset.close).hidden = true; })
  );

  // ─────────────────────────────── thanh công cụ: kéo thả · thu nhỏ
  const DOCK_KEY = 'webgate.dock.v1';
  let uiMode = 'bar';   // 'bar' (đủ nút) | 'ball' (1 icon tròn)
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

  function setMode(mode) {
    // nhớ vị trí đang đứng trước khi đổi kích thước (bar <-> ball)
    if (!dock.hidden) {
      const r = dock.getBoundingClientRect();
      if (r.width) dockPos = { x: r.left, y: r.top };
    }
    uiMode = mode;
    dock.classList.toggle('mode-ball', mode === 'ball');
    if (dockPos) placeDock(dockPos.x, dockPos.y);
    writeDock();
  }

  /**
   * Kéo thả cho 1 phần tử, đồng thời phân biệt chạm / kéo.
   * Chạm mà không di chuyển -> onTap.
   */
  function draggable(el, { onTap } = {}) {
    let id = null, sx = 0, sy = 0, ox = 0, oy = 0;
    let moved = false;
    let dragEndedAt = 0;

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
      moved = false;
    });

    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      if (!moved) {
        moved = true;
        el.classList.add('dragging');
        try { el.setPointerCapture?.(id); } catch { /* ignore */ }
      }
      placeDock(ox + dx, oy + dy);
      e.preventDefault();
    });

    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('dragging');
      if (moved) {
        dragEndedAt = performance.now();
        writeDock();
      } else if (onTap) {
        onTap();
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  draggable(dock);
  draggable(ball, {
    onTap: () => { setMode('bar'); holdUi(); buzz(6); },
  });

  $('#btnClose').addEventListener('click', () => { holdUi(); setMode('ball'); buzz(6); });

  function restoreDock() {
    const s = readDock();
    if (s.pos && Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y)) {
      placeDock(s.pos.x, s.pos.y);
    } else {
      const r = dock.getBoundingClientRect();
      dockPos = { x: r.left, y: r.top };
    }
    setMode(s.mode === 'ball' ? 'ball' : 'bar');
  }

  window.addEventListener('resize', () => {
    if (dockPos) placeDock(dockPos.x, dockPos.y);
  });

  $('#btnMode').addEventListener('click', () => {
    holdUi();
    if (viewMode) setViewMode(false);
    setCtrlMode(effMode() === 'touch' ? 'pad' : 'touch');
    buzz(10);
  });

  $('#btnZoom').addEventListener('click', () => { holdUi(); setViewMode(!viewMode); buzz(8); });

  $('#btnKb').addEventListener('click', () => {
    holdUi();
    kbPanel.hidden = true;
    cfgPanel.hidden = true;
    if (document.activeElement === ime) closeKeyboard();
    else openKeyboard();
  });

  $('#btnWin').addEventListener('click', () => { holdUi(); togglePanel(kbPanel); });

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

  function paintMods() {
    document.querySelectorAll('[data-mod],[data-bmod]').forEach((b) =>
      b.classList.toggle('on', mods.has(b.dataset.mod || b.dataset.bmod))
    );
  }

  function toggleMod(m) {
    if (mods.has(m)) mods.delete(m);
    else mods.add(m);
    paintMods();
  }

  document.querySelectorAll('[data-mod]').forEach((b) => {
    b.addEventListener('click', () => toggleMod(b.dataset.mod));
  });

  function sendCombo(key) {
    const keys = [...mods, key].slice(0, 6);
    send({ t: 'k', keys });
    clearMods();
  }

  function clearMods() {
    mods.clear();
    paintMods();
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

  // ─────────────────────────────────── bàn phím điện thoại gõ trực tiếp
  // Mở bàn phím hệ thống của điện thoại (như bàn phím cảm ứng tự bật trên
  // Windows tablet). Mỗi lần ô nhập thay đổi, so sánh với lần trước và gửi
  // "xoá n ký tự + gõ chuỗi mới" — nhờ vậy bộ gõ Telex/VNI, gợi ý từ, tự sửa
  // chữ đều ra đúng trên máy tính.
  const ime = $('#ime');
  const kbBar = $('#kbBar');
  const SENT = '  '; // ký tự canh: xoá khi ô trống vẫn sinh sự kiện -> Backspace
  let imePrev = SENT;
  let composing = false;

  const cps = (s) => Array.from(s); // tách theo code point (emoji = 1)

  function imeReset() {
    ime.value = SENT;
    imePrev = SENT;
    try { ime.setSelectionRange(SENT.length, SENT.length); } catch { /* ignore */ }
  }

  function openKeyboard() {
    imeReset();
    ime.focus({ preventScroll: true });
  }

  function closeKeyboard() {
    ime.blur();
  }

  ime.addEventListener('compositionstart', () => { composing = true; });
  ime.addEventListener('compositionend', () => { composing = false; onImeInput(); });
  ime.addEventListener('input', onImeInput);

  function onImeInput() {
    const a = cps(imePrev);
    const b = cps(ime.value);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    const del = a.length - p;
    const ins = b.slice(p).join('');
    imePrev = ime.value;
    if (!del && !ins) return;

    if (mods.size && !del && cps(ins).length === 1 && ins.trim()) {
      sendCombo(ins.toLowerCase()); // đang bật Ctrl/Alt/Win -> phím tắt (vd Ctrl+C)
      if (!composing) imeReset();
      return;
    }
    send({ t: 'ed', del, ins });

    // ô nhập dài ra / mất ký tự canh / xuống dòng -> làm sạch (không làm khi đang ghép chữ)
    if (!composing && (!ime.value.startsWith(SENT) || ins.includes('\n') || b.length > 80)) imeReset();
  }

  // phím đặc biệt bàn phím ảo hay gửi qua keydown thay vì input
  ime.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const map = { ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ArrowUp: 'UP', ArrowDown: 'DOWN', Escape: 'ESC', Tab: 'TAB' };
    const k = map[e.key];
    if (k) {
      e.preventDefault();
      sendCombo(k);
    }
  });

  ime.addEventListener('focus', () => {
    kbBar.hidden = false;
    $('#btnKb').classList.add('active');
    placeKbBar();
  });
  ime.addEventListener('blur', () => {
    kbBar.hidden = true;
    $('#btnKb').classList.remove('active');
    clearMods();
  });

  /** Đặt thanh phím phụ ngay trên bàn phím (iOS không co cửa sổ khi bàn phím mở). */
  function placeKbBar() {
    const vv = window.visualViewport;
    const gap = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    kbBar.style.bottom = gap + 'px';
  }
  window.visualViewport?.addEventListener('resize', placeKbBar);
  window.visualViewport?.addEventListener('scroll', placeKbBar);

  // bấm nút trên thanh phím phụ không được làm mất focus ô nhập (bàn phím sẽ đóng)
  kbBar.addEventListener('pointerdown', (e) => e.preventDefault());
  kbBar.addEventListener('mousedown', (e) => e.preventDefault());
  kbBar.querySelectorAll('[data-bkey]').forEach((b) =>
    b.addEventListener('click', () => { sendCombo(b.dataset.bkey); buzz(5); })
  );
  kbBar.querySelectorAll('[data-bmod]').forEach((b) =>
    b.addEventListener('click', () => { toggleMod(b.dataset.bmod); buzz(5); })
  );
  $('#kbMore').addEventListener('click', () => { closeKeyboard(); togglePanel(kbPanel); });
  $('#kbHide').addEventListener('click', closeKeyboard);

  // phím tắt Windows (Start, Task View, Alt+Tab…) — dự phòng cho cử chỉ vuốt cạnh / 3 ngón
  document.querySelectorAll('[data-combo]').forEach((b) =>
    b.addEventListener('click', () => {
      send({ t: 'k', keys: b.dataset.combo.split(',') });
      buzz(8);
      if (b.closest('.wins')) kbPanel.hidden = true; // thao tác cửa sổ: đóng panel để xem kết quả
    })
  );

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

  $('#cfgMode').addEventListener('change', (e) => setCtrlMode(e.target.value));
  $('#cfgSpeed').addEventListener('change', (e) => {
    padSpeed = Number(e.target.value) || 1;
    try { localStorage.setItem(SPEED_KEY, String(padSpeed)); } catch { /* ignore */ }
  });

  $('#btnReconnect').addEventListener('click', () => connect());
  $('#btnLogout').addEventListener('click', async () => {
    await fetch('/api/logout');
    location.reload();
  });

  // ─────────────────────────────────────────── go
  boot();
})();
