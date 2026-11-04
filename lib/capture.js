'use strict';
/**
 * Bắt màn hình Windows bằng ffmpeg (gdigrab) và bóc từng khung JPEG từ stdout.
 * Một pipeline duy nhất dùng chung cho tất cả client (broadcast).
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

class ScreenCapture extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.fps = clamp(opts.fps ?? 15, 2, 30);
    this.width = clamp(opts.width ?? 1280, 480, 2560);
    this.quality = clamp(opts.quality ?? 8, 2, 25);
    this.proc = null;
    this.running = false;
    this.wanting = false;
    this.lastFrame = null;
    this.lastHash = 0;
    this.frames = 0;
    this.bytes = 0;
    this.cpuStderr = '';
    this._restartTimer = null;
    this._buf = Buffer.alloc(0);
  }

  get config() {
    return { fps: this.fps, width: this.width, quality: this.quality };
  }

  /** Đổi cấu hình -> khởi động lại pipeline nếu đang chạy. */
  setConfig(patch = {}) {
    const next = {
      fps: clamp(patch.fps ?? this.fps, 2, 30),
      width: clamp(patch.width ?? this.width, 480, 2560),
      quality: clamp(patch.quality ?? this.quality, 2, 25),
    };
    if (next.fps === this.fps && next.width === this.width && next.quality === this.quality) {
      return false;
    }
    this.fps = next.fps;
    this.width = next.width;
    this.quality = next.quality;
    if (this.running) {
      this.restart();
    }
    return true;
  }

  args() {
    return [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      // chụp desktop kèm con trỏ chuột
      '-f', 'gdigrab',
      '-draw_mouse', '1',
      '-framerate', String(this.fps),
      '-i', 'desktop',
      // thu nhỏ giữ tỉ lệ (không upscale nếu màn hình nhỏ hơn)
      '-vf', `scale=w='min(${this.width},iw)':h=-2:flags=fast_bilinear`,
      '-q:v', String(this.quality),
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-',
    ];
  }

  start() {
    this.wanting = true;
    if (this.running) return;
    this.running = true;
    this._spawn();
  }

  stop() {
    this.wanting = false;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    this._kill();
    this.running = false;
    this.lastFrame = null;
    this.lastHash = 0;
  }

  restart() {
    this._kill();
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      if (this.wanting) {
        this.running = true;
        this._spawn();
      }
    }, 150);
  }

  _kill() {
    const p = this.proc;
    this.proc = null;
    this._buf = Buffer.alloc(0);
    if (!p) return;
    try {
      p.stdout.removeAllListeners('data');
      p.stdout.destroy();
      p.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  _spawn() {
    this._buf = Buffer.alloc(0);
    let proc;
    try {
      proc = spawn(FFMPEG, this.args(), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.running = false;
      this.emit('error', err);
      return;
    }
    this.proc = proc;

    proc.stdout.on('data', (chunk) => this._onData(chunk));

    proc.stderr.on('data', (d) => {
      const s = d.toString();
      this.cpuStderr = (this.cpuStderr + s).slice(-4000);
      if (/error|invalid|unable|not found/i.test(s)) {
        this.emit('warn', s.trim().split('\n').slice(0, 3).join(' | '));
      }
    });

    proc.on('error', (err) => {
      this.running = false;
      this.proc = null;
      const msg = err.code === 'ENOENT'
        ? 'Không tìm thấy ffmpeg trong PATH. Cài ffmpeg hoặc đặt biến môi trường FFMPEG=<đường dẫn>.'
        : `Không chạy được ffmpeg: ${err.message}`;
      this.emit('error', new Error(msg));
    });

    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      if (this.wanting && this.running && !this._restartTimer) {
        // ffmpeg chết bất ngờ -> thử lại sau 1s
        this.running = false;
        this._restartTimer = setTimeout(() => {
          this._restartTimer = null;
          if (this.wanting) {
            this.running = true;
            this._spawn();
          }
        }, 1000);
      }
    });
  }

  _onData(chunk) {
    let buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const s = buf.indexOf(SOI);
      if (s < 0) {
        // giữ lại 1 byte cuối phòng trường hợp 0xFF nằm ở ranh giới gói
        buf = buf.slice(Math.max(0, buf.length - 1));
        break;
      }
      const e = buf.indexOf(EOI, s + 2);
      if (e < 0) {
        buf = buf.slice(s);
        break;
      }
      const frame = Buffer.from(buf.subarray(s, e + 2)); // copy: an toàn khi slice buffer lớn
      buf = buf.slice(e + 2);

      const h = hash(frame);
      if (h === this.lastHash) continue; // màn hình không đổi -> không gửi
      this.lastHash = h;
      this.lastFrame = frame;
      this.frames++;
      this.bytes += frame.length;
      this.emit('frame', frame);
    }
    this._buf = buf;
  }
}

/** FNV-1a 32-bit, lấy mẫu mỗi 3 byte: đủ nhanh và đủ nhạy với thay đổi nhỏ. */
function hash(buf) {
  let h = 0x811c9dc5;
  const n = buf.length;
  for (let i = 0; i < n; i += 3) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= n;
  return h >>> 0;
}

module.exports = { ScreenCapture };
