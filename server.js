'use strict';
/**
 * WebGate - cổng web điều khiển máy tính Windows qua LAN.
 *   - Xem màn hình realtime: video H.264 (WebCodecs) hoặc JPEG dự phòng (ffmpeg -> WebSocket -> canvas)
 *   - Chuột / bàn phím thật (Win32)
 *   - Đăng nhập bằng mật khẩu, cookie HttpOnly
 *
 * Chạy: node server.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const input = require('./lib/input');
const touch = require('./lib/touch');
const { ScreenCapture } = require('./lib/capture');
const { H264Capture } = require('./lib/h264');

// ---------------------------------------------------------------- cấu hình
const PORT = Number(process.env.PORT || 6090);
const BIND = process.env.HOST || '0.0.0.0';

// Mật khẩu: ưu tiên biến môi trường, không có thì đọc/tạo file .pass (giữ nguyên giữa các lần chạy)
function loadPassword() {
  if (process.env.GATE_PASS) return process.env.GATE_PASS;
  const file = path.join(__dirname, '.pass');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {
    /* chưa có file */
  }
  const generated = crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(file, generated + '\n', { mode: 0o600 });
  } catch {
    /* không ghi được thì dùng tạm */
  }
  return generated;
}

const PASSWORD = loadPassword();
const COOKIE_NAME = 'webgate';
const PUBLIC_DIR = path.join(__dirname, 'public');

const CONFIG_FILE = path.join(__dirname, '.config.json');
const cfg = loadCfg();

/**
 * Cấu hình khởi động: ưu tiên biến môi trường > file .config.json (do người
 * dùng chỉnh trên web) > mặc định. Nhờ vậy chỉnh chất lượng trên điện thoại
 * không bị mất khi khởi động lại server.
 */
function loadCfg() {
  const base = {
    fps: Number(process.env.FPS || 15),
    width: Number(process.env.WIDTH || 1280),
    quality: Number(process.env.QUALITY || 8),
  };
  const h264Base = { fps: 30, width: 1280, quality: 8 };
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    /* chưa có file */
  }
  const h = saved.h264 || {};
  const h264 = {
    fps: Number(h.fps) || h264Base.fps,
    width: Number(h.width) || h264Base.width,
    quality: Number(h.quality) || h264Base.quality,
  };
  if (process.env.FPS || process.env.WIDTH || process.env.QUALITY) return { ...base, h264 };
  return {
    fps: Number(saved.fps) || base.fps,
    width: Number(saved.width) || base.width,
    quality: Number(saved.quality) || base.quality,
    h264,
  };
}

function saveCfg(c) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + '\n');
  } catch {
    /* không ghi được thì thôi, không ảnh hưởng stream */
  }
}

// Token phiên: salt ngẫu nhiên -> restart server là mọi phiên cũ hết hiệu lực
const TOKEN = crypto
  .createHmac('sha256', crypto.randomBytes(32))
  .update(`webgate|${PASSWORD}`)
  .digest('hex');

const cap = new ScreenCapture(cfg);   // JPEG (dự phòng / trình duyệt cũ)
const hcap = new H264Capture(cfg.h264);
const clients = new Set();

/** Lưu cả 2 cấu hình: JPEG ở gốc file (tương thích bản cũ) + mục h264. */
function saveAllCfg() {
  saveCfg({ ...cap.config, h264: hcap.config });
}

const capOf = (ws) => (ws.codec === 'h264' ? hcap : cap);

// ---------------------------------------------------------------- tiện ích
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const v = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!v || v.length !== TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(TOKEN));
  } catch {
    return false;
  }
}

function json(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body quá lớn'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// chống dò mật khẩu: 5 lần sai / 60s -> khoá 30s
const attempts = new Map();
function throttleKey(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, until: 0, at: now };
  return { rec, now };
}

// ---------------------------------------------------------------- HTTP
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  // ---- đăng nhập
  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || '?';
    const { rec, now } = throttleKey(ip);
    if (rec.until > now) {
      return json(res, 429, { ok: false, error: `Thử quá nhiều, đợi ${Math.ceil((rec.until - now) / 1000)}s` });
    }
    let pass = '';
    try {
      pass = String(JSON.parse(await readBody(req)).pass || '');
    } catch {
      return json(res, 400, { ok: false, error: 'Dữ liệu không hợp lệ' });
    }
    const a = Buffer.from(pass);
    const b = Buffer.from(PASSWORD);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      const n = rec.n + 1;
      attempts.set(ip, { n, until: n >= 5 ? now + 30000 : 0, at: now });
      return json(res, 401, { ok: false, error: 'Sai mật khẩu' });
    }
    attempts.delete(ip);
    return json(res, 200, { ok: true }, {
      'set-cookie': `${COOKIE_NAME}=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
    });
  }

  if (pathname === '/api/logout') {
    return json(res, 200, { ok: true }, {
      'set-cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
  }

  // ---- thông tin phiên
  if (pathname === '/api/info') {
    if (!isAuthed(req)) return json(res, 401, { ok: false });
    const s = input.screen();
    return json(res, 200, {
      ok: true,
      screen: s,
      capture: cap.config,
      h264: { ...hcap.config, encoder: hcap.encoder ? hcap.encoder.label : null, failed: hcap.failed },
      viewers: clients.size,
      frames: cap.frames,
      bytes: cap.bytes,
    });
  }

  // ---- file tĩnh
  if (req.method === 'GET' || req.method === 'HEAD') {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(405).end('method not allowed');
});

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (!isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

let idleTimer = null;

function wanted() {
  let jpeg = false, h264 = false;
  for (const c of clients) {
    if (c.codec === 'h264') h264 = true;
    else jpeg = true;
  }
  return { jpeg, h264 };
}

/** Chạy pipeline nào đang có người xem; pipeline không ai xem thì tắt sau 15s. */
function ensureCapture() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const w = wanted();
  if (w.jpeg && !cap.running) cap.start();
  if (w.h264 && !hcap.running) hcap.start();
  if ((!w.jpeg && cap.running) || (!w.h264 && hcap.running)) scheduleStop();
}

function scheduleStop() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const w = wanted();
    if (!w.jpeg && cap.running) { cap.stop(); log('không còn ai xem JPEG -> tạm dừng ffmpeg'); }
    if (!w.h264 && hcap.running) { hcap.stop(); log('không còn ai xem H.264 -> tạm dừng ffmpeg'); }
  }, 15000);
}

function infoFor(ws) {
  return {
    t: 'info',
    screen: input.screen(),
    codec: ws.codec,
    encoder: ws.codec === 'h264' && hcap.encoder ? hcap.encoder.label : null,
    capture: capOf(ws).config,
    touch: touch.ready,
  };
}

/** Gửi cấu hình giải mã + các khung từ IDR gần nhất -> hình hiện ngay, không chờ khung khoá kế. */
function sendH264Start(ws) {
  ws.needKey = true;
  if (ws.readyState !== 1 || !hcap.avcC || !hcap.gop.length) return;
  try {
    ws.send(hcap.avcC, { binary: true });
    for (const f of hcap.gop) ws.send(f, { binary: true });
    ws.needKey = false;
  } catch {
    /* ignore */
  }
}

/** Gửi khung hiện có cho client mới / client xin lại hình. */
function sendCurrent(ws) {
  if (ws.codec === 'h264') return sendH264Start(ws);
  if (cap.lastFrame && ws.readyState === 1) {
    try {
      ws.send(cap.lastFrame, { binary: true });
    } catch {
      /* ignore */
    }
  }
}

wss.on('connection', (ws, req) => {
  // client tự chọn codec qua /ws?codec=h264 (chỉ khi trình duyệt giải mã được)
  const want = new URL(req.url, 'http://localhost').searchParams.get('codec');
  ws.codec = want === 'h264' && !hcap.failed ? 'h264' : 'jpeg';
  ws.needKey = true;
  clients.add(ws);
  ensureCapture();

  send(ws, infoFor(ws));
  sendCurrent(ws);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handleInput(msg, ws);
  });

  // mất kết nối giữa lúc đang chạm -> nhấc hết ngón, tránh "kẹt ngón" trên máy
  const drop = () => {
    clients.delete(ws);
    if (touchOwner === ws) {
      touch.cancelAll();
      touchOwner = null;
    }
    ensureCapture();
  };
  ws.on('close', drop);
  ws.on('error', drop);
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

// chống nghẽn: nếu client không theo kịp thì bỏ khung
function broadcastFrame(buf) {
  for (const c of clients) {
    if (c.readyState !== 1 || c.codec === 'h264') continue;
    if (c.bufferedAmount > 600 * 1024) continue;
    c.send(buf, { binary: true });
  }
}

/**
 * H.264: khung delta phụ thuộc khung trước. Bỏ một khung = hình vỡ tới khung
 * khoá kế -> client nghẽn thì bỏ luôn tới IDR tiếp theo (needKey).
 */
function broadcastH264(buf, key) {
  for (const c of clients) {
    if (c.readyState !== 1 || c.codec !== 'h264') continue;
    if (c.needKey && !key) continue;
    if (c.bufferedAmount > 1024 * 1024) { c.needKey = true; continue; }
    if (key && c.needKey && hcap.avcC) c.send(hcap.avcC, { binary: true });
    c.needKey = false;
    c.send(buf, { binary: true });
  }
}

cap.on('frame', broadcastFrame);
hcap.on('frame', broadcastH264);
hcap.on('config', (buf) => {
  for (const c of clients) {
    if (c.codec !== 'h264' || c.readyState !== 1) continue;
    c.send(buf, { binary: true });
    c.needKey = true;
  }
});
hcap.on('encoder', (e) => log(`H.264: dùng bộ mã hoá ${e.label}`));
hcap.on('warn', (s) => log(`ffmpeg H.264: ${s}`));
hcap.on('error', (err) => log(`LỖI ffmpeg H.264: ${err.message}`));
// H.264 hỏng hẳn -> chuyển mọi người xem sang JPEG, không để màn hình đen
hcap.on('failed', (why) => {
  log(`H.264 tắt (${why}) -> dùng JPEG`);
  for (const c of clients) {
    if (c.codec !== 'h264') continue;
    c.codec = 'jpeg';
    send(c, infoFor(c));
  }
  ensureCapture();
});
cap.on('error', (err) => {
  log(`LỖI ffmpeg: ${err.message}`);
  broadcast({ t: 'error', message: err.message });
});
cap.on('warn', (s) => log(`ffmpeg: ${s}`));

// ---------------------------------------------------------------- input
const num = (v, lo, hi, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
};

// thiết bị đang chạm (chỉ 1 thiết bị được chạm tại một thời điểm)
let touchOwner = null;

function handleInput(msg, ws) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'tch': { // cảm ứng thật: [{ id, x, y, ph: d|m|u|c }]
      if (!Array.isArray(msg.pts) || msg.pts.length > touch.MAX_CONTACTS) break;
      if (touchOwner && touchOwner !== ws && touch.activeCount()) break;
      touchOwner = ws;
      touch.frame(msg.pts);
      break;
    }

    case 'tcx': // client huỷ mọi ngón (đổi chế độ, mất focus…)
      if (touchOwner === ws) touch.cancelAll();
      break;

    case 'm': // move
      input.moveTo(num(msg.x, 0, 1, 0), num(msg.y, 0, 1, 0));
      break;

    case 'd': // mouse down
      input.moveTo(num(msg.x, 0, 1, 0), num(msg.y, 0, 1, 0));
      input.button(num(msg.b, 1, 3, 1), true);
      break;

    case 'u': // mouse up
      input.button(num(msg.b, 1, 3, 1), false);
      break;

    case 'c': // click
      input.moveTo(num(msg.x, 0, 1, 0), num(msg.y, 0, 1, 0));
      input.click(num(msg.b, 1, 3, 1));
      break;

    case 'w': // wheel
      input.wheel(num(msg.d, -30, 30, 0));
      break;

    case 'k': // tổ hợp phím
      if (Array.isArray(msg.keys) && msg.keys.length <= 6) input.keys(msg.keys);
      break;

    // Bàn phím thật của máy đang xem: client gửi từng phím nhấn/nhả riêng,
    // nhờ vậy giữ phím (auto-repeat), Ctrl/Shift/Alt và phím lạ đều đúng.
    case 'kd': {
      const vk = num(msg.vk, 1, 255, 0);
      if (vk) input.keyDownVk(vk, !!msg.ext);
      break;
    }

    case 'ku': {
      const vk = num(msg.vk, 1, 255, 0);
      if (vk) input.keyUpVk(vk, !!msg.ext);
      break;
    }

    case 'ed': { // bàn phím điện thoại gõ trực tiếp: xoá `del` ký tự rồi gõ `ins`
      const ins = typeof msg.ins === 'string' ? msg.ins.slice(0, 2000) : '';
      input.edit(num(msg.del, 0, 200, 0), ins);
      break;
    }

    case 'txt': {
      const s = typeof msg.s === 'string' ? msg.s.slice(0, 20000) : '';
      input.typeText(s);
      break;
    }

    case 'cfg': {
      const target = capOf(ws);
      const changed = target.setConfig({
        fps: msg.fps,
        width: msg.width,
        quality: msg.quality,
      });
      if (changed) {
        log(`cấu hình ${ws.codec} mới: ${JSON.stringify(target.config)}`);
        saveAllCfg();
        for (const c of clients) if (c.codec === ws.codec) send(c, infoFor(c));
      }
      break;
    }

    case 'refresh': // client xin lại khung hình (khi màn hình đang tĩnh)
      ensureCapture();
      sendCurrent(ws);
      break;

    case 'ping':
      send(ws, { t: 'pong', ts: msg.ts });
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------- khởi động
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`);
}

server.listen(PORT, BIND, () => {
  const ips = lanAddresses();
  const url = ips.length ? `http://${ips[0].address}:${PORT}` : `http://localhost:${PORT}`;

  console.log('');
  console.log('  ==============================================');
  console.log('     WEBGATE  -  ONLINE');
  console.log('  ==============================================');
  console.log('');
  console.log(`  May nay    : http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Dien thoai : http://${ip.address}:${PORT}   (${ip.name})`);
  console.log('');
  console.log(`  Mat khau   : ${PASSWORD}`);
  console.log(`  Man hinh   : ${input.screen().w}x${input.screen().h}`);
  console.log(`  Video      : H.264 ${hcap.fps}fps ${hcap.width}px  |  JPEG du phong ${cap.fps}fps ${cap.width}px`);
  console.log(`  Cam ung    : ${touch.ready ? 'san sang (InjectTouchInput)' : 'KHONG dung duoc - ' + touch.error}`);
  console.log('');
  console.log('  Ctrl+C de tat.');
  console.log('');

  try {
    const qrcode = require('qrcode-terminal');
    qrcode.generate(url, { small: true }, (qr) => {
      console.log('  Quét mã để mở trên điện thoại:');
      console.log(qr);
    });
  } catch {
    /* thiếu module QR thì thôi */
  }
});

process.on('SIGINT', () => {
  cap.stop();
  hcap.stop();
  process.exit(0);
});
