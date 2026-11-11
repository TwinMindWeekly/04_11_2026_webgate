'use strict';
/**
 * Stream màn hình dạng video H.264 (thay cho chuỗi ảnh JPEG).
 *
 * Mỗi khung JPEG là một ảnh đầy đủ; H.264 chỉ gửi phần thay đổi giữa các khung
 * -> nhẹ hơn nhiều lần, chạy 30fps mượt qua 4G. Mã hoá bằng GPU nếu có
 * (AMD AMF / NVIDIA NVENC / Intel QSV), không có thì libx264 trên CPU.
 * Điện thoại giải mã bằng WebCodecs (phần cứng).
 *
 * ffmpeg xuất FLV: mỗi tag có độ dài sẵn -> tách đúng từng khung, gửi ngay
 * (không phải chờ khung sau như khi cắt luồng Annex-B theo start code).
 *
 * Gói nhị phân gửi client: 1 byte đầu là loại
 *   0x03 = cấu hình giải mã (AVCDecoderConfigurationRecord / avcC)
 *   0x02 = khung khoá (IDR)   0x01 = khung delta
 * phần sau là dữ liệu AVCC (mỗi NAL có 4 byte độ dài phía trước).
 * (JPEG luôn bắt đầu bằng 0xFF nên client phân biệt được.)
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const TAG_DELTA = 0x01;
const TAG_KEY = 0x02;
const TAG_CONFIG = 0x03;
const FAIL_COOLDOWN_MS = 60000;

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Bộ mã hoá thử theo thứ tự. q: thang "chất lượng JPEG" cũ (2 = đẹp nhất,
 * 25 = nhẹ nhất) để dùng chung một ô cài đặt.
 */
const ENCODERS = [
  {
    name: 'h264_amf',
    label: 'AMD AMF (GPU)',
    pix: 'nv12',
    args: (q, kbps, gop) => [
      '-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-quality', 'speed',
      '-rc', 'qvbr', '-qvbr_quality_level', String(clamp(35.5 - q * 0.77, 12, 36)),
      '-b:v', `${kbps}k`, '-maxrate', `${kbps * 2}k`,
      '-bf', '0', '-g', String(gop), '-header_insertion_mode', 'idr',
    ],
  },
  {
    name: 'h264_nvenc',
    label: 'NVIDIA NVENC (GPU)',
    pix: 'nv12',
    args: (q, kbps, gop) => [
      '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1',
      '-rc', 'vbr', '-cq', String(clamp(17 + q * 0.75, 18, 38)),
      '-b:v', `${kbps}k`, '-maxrate', `${kbps * 2}k`,
      '-bf', '0', '-g', String(gop), '-forced-idr', '1',
    ],
  },
  {
    name: 'h264_qsv',
    label: 'Intel Quick Sync (GPU)',
    pix: 'nv12',
    args: (q, kbps, gop) => [
      '-c:v', 'h264_qsv', '-preset', 'veryfast', '-low_power', '1',
      '-global_quality', String(clamp(17 + q * 0.75, 18, 38)),
      '-maxrate', `${kbps * 2}k`, '-bf', '0', '-g', String(gop),
    ],
  },
  {
    name: 'libx264',
    label: 'libx264 (CPU)',
    pix: 'yuv420p',
    args: (q, kbps, gop) => [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-crf', String(clamp(17 + q * 0.75, 18, 38)),
      '-maxrate', `${kbps * 2}k`, '-bufsize', `${kbps}k`,
      '-bf', '0', '-g', String(gop), '-keyint_min', String(gop),
    ],
  },
];

/** Bitrate trung bình mục tiêu theo độ rộng (kbps). */
function targetKbps(width) {
  return clamp((width / 1280) ** 2 * 2500, 600, 8000);
}

function captureInput(fps) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'gdigrab', '-draw_mouse', '1', '-framerate', String(fps), '-i', 'desktop'];
}

function scaleFilter(width, pix) {
  // chiều rộng chẵn (H.264 yêu cầu), không upscale
  return `scale=w='trunc(min(${width},iw)/2)*2':h=-2:flags=bicubic,format=${pix}`;
}

/** Thử mã hoá 0.4s -> bộ mã hoá đầu tiên chạy được. Kết quả được nhớ. */
let probed = null;
function probeEncoder() {
  if (probed) return probed;
  const forced = process.env.H264_ENCODER;
  const list = forced ? ENCODERS.filter((e) => e.name === forced) : ENCODERS;
  probed = (async () => {
    for (const enc of list) {
      const ok = await new Promise((resolve) => {
        const args = [...captureInput(10), '-t', '0.4', '-vf', scaleFilter(640, enc.pix),
          ...enc.args(8, 1000, 20), '-f', 'h264', '-'];
        let bytes = 0;
        let p;
        try {
          p = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
          resolve(false);
          return;
        }
        const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }, 8000);
        p.stdout.on('data', (d) => { bytes += d.length; });
        p.on('error', () => { clearTimeout(timer); resolve(false); });
        p.on('exit', (code) => { clearTimeout(timer); resolve(code === 0 && bytes > 0); });
      });
      if (ok) return enc;
    }
    return null;
  })();
  // thất bại thì không nhớ: lần sau thử lại (vd. lúc đó đang ở màn hình UAC)
  probed.then((r) => { if (!r) probed = null; });
  return probed;
}

class H264Capture extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.fps = clamp(opts.fps ?? 30, 2, 60);
    this.width = clamp(opts.width ?? 1280, 480, 2560);
    this.quality = clamp(opts.quality ?? 8, 2, 25);
    this.encoder = null;      // { name, label, ... } sau khi probe
    this._failedAt = 0;       // lúc H.264 hỏng (không bộ mã hoá / chết liên tục)
    this.proc = null;
    this.running = false;
    this.wanting = false;
    this.gop = [];            // các khung từ IDR gần nhất -> cho người mới vào
    this.crashes = [];
    this._restartTimer = null;
    this._buf = Buffer.alloc(0);
    this.avcC = null;         // gói cấu hình (0x03 + avcC) gần nhất
    this._hdrDone = false;    // đã bỏ qua header FLV 13 byte chưa
  }

  get config() {
    return { fps: this.fps, width: this.width, quality: this.quality };
  }

  /** Hỏng gần đây (< 60s): tạm dùng JPEG. Hết hạn thì người kết nối sau được thử lại H.264. */
  get failed() {
    return !!this._failedAt && Date.now() - this._failedAt < FAIL_COOLDOWN_MS;
  }

  setConfig(patch = {}) {
    const next = {
      fps: clamp(patch.fps ?? this.fps, 2, 60),
      width: clamp(patch.width ?? this.width, 480, 2560),
      quality: clamp(patch.quality ?? this.quality, 2, 25),
    };
    if (next.fps === this.fps && next.width === this.width && next.quality === this.quality) return false;
    Object.assign(this, next);
    if (this.running) this.restart();
    return true;
  }

  args() {
    const enc = this.encoder;
    const gop = this.fps * 2; // khung khoá mỗi 2 giây (theo thời gian, không theo số khung)
    return [
      ...captureInput(this.fps),
      '-vf', scaleFilter(this.width, enc.pix),
      ...enc.args(this.quality, targetKbps(this.width), gop),
      '-flush_packets', '1',
      '-f', 'flv', '-',
    ];
  }

  async start() {
    this.wanting = true;
    if (this.running || this.failed) return;
    this.running = true;
    if (!this.encoder) {
      this.encoder = await probeEncoder();
      if (!this.encoder) {
        this.running = false;
        this._failedAt = Date.now();
        this.emit('failed', 'Không có bộ mã hoá H.264 nào chạy được');
        return;
      }
      this.emit('encoder', this.encoder);
    }
    if (!this.wanting) { this.running = false; return; }
    this._spawn();
  }

  stop() {
    this.wanting = false;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    this._kill();
    this.running = false;
    this.gop = [];
  }

  restart() {
    this._kill();
    this.gop = [];
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this.wanting) { this.running = true; this._spawn(); }
    }, 150);
  }

  _kill() {
    const p = this.proc;
    this.proc = null;
    this._buf = Buffer.alloc(0);
    this._hdrDone = false;
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
    this._hdrDone = false;
    let proc;
    try {
      proc = spawn(FFMPEG, this.args(), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.running = false;
      this.emit('error', err);
      return;
    }
    this.proc = proc;
    const started = Date.now();

    proc.stdout.on('data', (chunk) => this._onData(chunk));
    proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) this.emit('warn', s.split('\n').slice(0, 3).join(' | '));
    });
    proc.on('error', (err) => {
      this.running = false;
      this.proc = null;
      this.emit('error', err);
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      if (!(this.wanting && this.running) || this._restartTimer) return;
      // chết bất ngờ: chết 3 lần trong 30s (mỗi lần sống < 10s) -> bỏ H.264
      const now = Date.now();
      if (now - started < 10000) this.crashes.push(now);
      this.crashes = this.crashes.filter((t) => now - t < 30000);
      this.running = false;
      if (this.crashes.length >= 3) {
        this.crashes = [];
        this._failedAt = Date.now();
        this.emit('failed', 'ffmpeg H.264 dừng liên tục');
        return;
      }
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        if (this.wanting) { this.running = true; this._spawn(); }
      }, 1000);
    });
  }

  /** Đọc luồng FLV: header 9 byte + 4 byte, sau đó các tag [11 byte đầu | data | 4 byte]. */
  _onData(chunk) {
    let buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    if (!this._hdrDone) {
      if (buf.length < 13) { this._buf = buf; return; }
      if (buf[0] !== 0x46 || buf[1] !== 0x4c || buf[2] !== 0x56) { // 'FLV'
        this.emit('warn', 'luồng FLV không hợp lệ');
        this._buf = Buffer.alloc(0);
        return;
      }
      buf = buf.subarray(13);
      this._hdrDone = true;
    }
    let off = 0;
    while (buf.length - off >= 11) {
      const size = buf.readUIntBE(off + 1, 3);
      const end = off + 11 + size + 4;
      if (buf.length < end) break;
      if (buf[off] === 9 && size > 5) this._video(buf.subarray(off + 11, off + 11 + size));
      off = end;
    }
    this._buf = off ? Buffer.from(buf.subarray(off)) : buf;
  }

  /** Tag video FLV: [frameType<<4 | codec][AVCPacketType][CTS 3 byte][data] */
  _video(d) {
    if ((d[0] & 0x0f) !== 7) return; // không phải AVC
    const key = d[0] >> 4 === 1;
    const kind = d[1];
    const data = d.subarray(5);
    if (kind === 0) {
      this.avcC = Buffer.concat([Buffer.from([TAG_CONFIG]), data]);
      this.emit('config', this.avcC);
      return;
    }
    if (kind !== 1 || !data.length) return;
    const frame = Buffer.concat([Buffer.from([key ? TAG_KEY : TAG_DELTA]), data]);
    if (key) this.gop = [frame];
    else if (this.gop.length) {
      this.gop.push(frame);
      if (this.gop.length > 600) this.gop = []; // phòng hờ: GOP bất thường dài
    }
    this.emit('frame', frame, key);
  }
}

module.exports = { H264Capture, probeEncoder, TAG_KEY, TAG_DELTA, TAG_CONFIG };
