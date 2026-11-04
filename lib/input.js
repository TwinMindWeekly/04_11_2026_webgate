'use strict';
/**
 * Bơm chuột / phím thật vào Windows qua user32.dll (SendInput legacy API).
 * Dùng koffi (FFI, không cần compile) nên chạy được với Node thuần.
 *
 * Lưu ý: đây là input THẬT -> con trỏ chuột trên máy sẽ di chuyển.
 */

const koffi = require('koffi');
const { spawn } = require('child_process');

const user32 = koffi.load('user32.dll');

const _SetProcessDPIAware = user32.func('bool __stdcall SetProcessDPIAware()');
const _GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int)');
const _SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const _mouse_event = user32.func(
  'void __stdcall mouse_event(int32 dwFlags, int32 dx, int32 dy, int32 dwData, uint64 dwExtraInfo)'
);
const _keybd_event = user32.func(
  'void __stdcall keybd_event(uint8 bVk, uint8 bScan, int32 dwFlags, uint64 dwExtraInfo)'
);

// Bắt buộc: nếu process không DPI-aware thì toạ độ chuột là "logical"
// trong khi gdigrab chụp theo pixel vật lý -> lệch trên màn hình scale 125%/150%.
_SetProcessDPIAware();

// ---- hằng số Win32 ----
const MOVE = 0x0001;
const LEFTDOWN = 0x0002;
const LEFTUP = 0x0004;
const RIGHTDOWN = 0x0008;
const RIGHTUP = 0x0010;
const MIDDLEDOWN = 0x0020;
const MIDDLEUP = 0x0040;
const WHEEL = 0x0800;
const ABSOLUTE = 0x8000;

const EXTKEY = 0x0001;
const KEYUP = 0x0002;

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

let SCREEN = { w: 1920, h: 1080 };
function refreshScreen() {
  SCREEN = { w: _GetSystemMetrics(SM_CXSCREEN) || 1920, h: _GetSystemMetrics(SM_CYSCREEN) || 1080 };
  return SCREEN;
}
refreshScreen();
// Màn hình có thể đổi (đổi resolution / cắm thêm) -> cập nhật định kỳ
setInterval(refreshScreen, 5000).unref?.();

// ---- bảng virtual-key code ----
const VK = {
  BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0d, SHIFT: 0x10, CTRL: 0x11, ALT: 0x12,
  PAUSE: 0x13, CAPSLOCK: 0x14, ESC: 0x1b, SPACE: 0x20, PAGEUP: 0x21, PGDN: 0x22,
  END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  PRINTSCREEN: 0x2c, INSERT: 0x2d, DELETE: 0x2e, WIN: 0x5b, MENU: 0x5d,
  NUMLOCK: 0x90, SCROLLLOCK: 0x91,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
};

// các phím cần cờ EXTENDED (nếu không sẽ bị hiểu thành phím numpad)
const EXTENDED = new Set([
  'INSERT', 'DELETE', 'HOME', 'END', 'PAGEUP', 'PGDN',
  'LEFT', 'UP', 'RIGHT', 'DOWN', 'PRINTSCREEN', 'MENU',
]);

function vkOf(name) {
  if (!name) return null;
  const k = String(name).toUpperCase();
  if (VK[k] != null) return { vk: VK[k], ext: EXTENDED.has(k) };
  // ký tự đơn: a-z, 0-9, dấu câu ASCII
  if (k.length === 1) {
    const c = k.charCodeAt(0);
    if (c >= 65 && c <= 90) return { vk: c, ext: false };       // A-Z dùng luôn mã ASCII
    if (c >= 48 && c <= 57) return { vk: c, ext: false };       // 0-9
    const sym = SYMBOLS[k];
    if (sym) return { vk: sym, ext: false };
  }
  return null;
}

// ký tự cần Shift (layout US)
const SYMBOLS = {
  ' ': 0x20, ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf,
  '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};

const SHIFTED = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';',
  '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function screen() {
  return SCREEN;
}

/** Di chuyển con trỏ tới toạ độ chuẩn hoá 0..1 của màn hình chính. */
function moveTo(nx, ny) {
  const x = Math.round(clamp01(Number(nx) || 0) * (SCREEN.w - 1));
  const y = Math.round(clamp01(Number(ny) || 0) * (SCREEN.h - 1));
  _SetCursorPos(x, y);
}

const BUTTONS = {
  1: { down: LEFTDOWN, up: LEFTUP },
  2: { down: RIGHTDOWN, up: RIGHTUP },
  3: { down: MIDDLEDOWN, up: MIDDLEUP },
};

function button(b, isDown) {
  const map = BUTTONS[b] || BUTTONS[1];
  _mouse_event(isDown ? map.down : map.up, 0, 0, 0, 0);
}

function click(b = 1) {
  button(b, true);
  button(b, false);
}

/** delta: số "notch" (âm = lên, dương = xuống) */
function wheel(delta) {
  const d = Math.max(-30, Math.min(30, Math.round(Number(delta) || 0)));
  if (!d) return;
  _mouse_event(WHEEL, 0, 0, d * 120, 0);
}

function keyDown(name) {
  const k = vkOf(name);
  if (!k) return false;
  _keybd_event(k.vk, 0, k.ext ? EXTKEY : 0, 0);
  return true;
}

function keyUp(name) {
  const k = vkOf(name);
  if (!k) return false;
  _keybd_event(k.vk, 0, (k.ext ? EXTKEY : 0) | KEYUP, 0);
  return true;
}

/**
 * Nhấn/nhả theo mã virtual-key thô (1..255).
 * Dùng cho bàn phím thật của máy đang mở trình duyệt: client gửi thẳng VK
 * nên mọi phím (kể cả phím không có tên trong bảng) đều đi được.
 */
function keyVk(vk, ext, isDown) {
  const v = Math.round(Number(vk));
  // phải chặn TRƯỚC khi clamp: 0 sẽ bị kẹp thành 1 = VK_LBUTTON
  if (!Number.isFinite(v) || v < 1 || v > 255) return false;
  _keybd_event(v, 0, (ext ? EXTKEY : 0) | (isDown ? 0 : KEYUP), 0);
  return true;
}

function keyDownVk(vk, ext) {
  return keyVk(vk, ext, true);
}

function keyUpVk(vk, ext) {
  return keyVk(vk, ext, false);
}

/** Nhấn tổ hợp, ví dụ ['CTRL','SHIFT','ESC'] */
function keys(combo) {
  if (!Array.isArray(combo) || !combo.length) return false;
  const list = combo.map(String).filter(Boolean);
  const pressed = [];
  for (const k of list) {
    if (keyDown(k)) pressed.push(k);
  }
  for (let i = pressed.length - 1; i >= 0; i--) keyUp(pressed[i]);
  return pressed.length > 0;
}

/** Gõ 1 ký tự (ASCII) theo layout US, tự thêm Shift nếu cần. */
function typeChar(ch) {
  if (!ch) return false;
  const shifted = SHIFTED[ch];
  if (shifted) {
    keyDown('SHIFT');
    const ok = keyDown(shifted);
    keyUp(shifted);
    keyUp('SHIFT');
    return ok;
  }
  return keys([ch]);
}

/**
 * Dán nguyên một chuỗi (tiếng Việt, emoji, xuống dòng...).
 * Cách làm: đưa chuỗi vào clipboard bằng PowerShell rồi gửi Ctrl+V.
 * -> có ghi đè clipboard hiện tại của máy.
 */
function typeText(text) {
  const s = String(text == null ? '' : text);
  if (!s) return Promise.resolve(false);
  return new Promise((resolve) => {
    const b64 = Buffer.from(s, 'utf8').toString('base64');
    const script =
      "$ErrorActionPreference='Stop';" +
      "try{" +
      `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));` +
      'Set-Clipboard -Value $t' +
      '}catch{exit 1}';
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      // đợi 1 nhịp cho clipboard ổn định rồi mới Ctrl+V
      setTimeout(() => {
        keys(['CTRL', 'V']);
        resolve(ok);
      }, 60);
    };
    try {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
      });
      ps.on('exit', (code) => finish(code === 0));
      ps.on('error', () => finish(false));
      setTimeout(() => finish(true), 4000);
    } catch {
      keys(['CTRL', 'V']);
      resolve(false);
    }
  });
}

module.exports = {
  screen,
  moveTo,
  button,
  click,
  wheel,
  keyDown,
  keyUp,
  keyDownVk,
  keyUpVk,
  keys,
  typeChar,
  typeText,
  vkOf,
};
