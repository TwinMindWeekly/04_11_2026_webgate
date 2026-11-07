'use strict';
/**
 * Bơm CẢM ỨNG THẬT vào Windows (InjectTouchInput) — giống cách Windows tablet
 * nhận ngón tay từ màn hình cảm ứng. Nhờ vậy chính Windows nhận diện cử chỉ:
 *   chạm = click, giữ = chuột phải (nhả tay mới bật menu), 1 ngón kéo = cuộn
 *   trong app hỗ trợ cảm ứng, chụm = zoom trong app, cử chỉ 3/4 ngón của Win11…
 *
 * Quy tắc của API:
 *   - Mỗi lần inject phải gửi TẤT CẢ ngón đang chạm trong cùng một mảng.
 *   - Ngón mới: DOWN; đang chạm: UPDATE; nhấc: UP. UPDATE cho id chưa DOWN -> lỗi.
 *   - Ngón đứng yên vẫn phải được "nhắc" UPDATE định kỳ, nếu không Windows huỷ.
 *     -> module này tự giữ nhịp (heartbeat) ở phía máy tính, không phụ thuộc mạng.
 */

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const POINT = koffi.struct('WG_POINT', { x: 'int32', y: 'int32' });
const RECT = koffi.struct('WG_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINTER_INFO = koffi.struct('WG_POINTER_INFO', {
  pointerType: 'uint32',
  pointerId: 'uint32',
  frameId: 'uint32',
  pointerFlags: 'uint32',
  sourceDevice: 'void *',
  hwndTarget: 'void *',
  ptPixelLocation: POINT,
  ptHimetricLocation: POINT,
  ptPixelLocationRaw: POINT,
  ptHimetricLocationRaw: POINT,
  dwTime: 'uint32',
  historyCount: 'uint32',
  InputData: 'int32',
  dwKeyStates: 'uint32',
  PerformanceCount: 'uint64',
  ButtonChangeType: 'int32',
});
const POINTER_TOUCH_INFO = koffi.struct('WG_POINTER_TOUCH_INFO', {
  pointerInfo: POINTER_INFO,
  touchFlags: 'uint32',
  touchMask: 'uint32',
  rcContact: RECT,
  rcContactRaw: RECT,
  orientation: 'uint32',
  pressure: 'uint32',
});

// Khai báo hàm Win32: lỗi ở đây (Windows quá cũ, sai layout) chỉ tắt chế độ
// chạm trực tiếp, server vẫn chạy và client tự dùng touchpad.
let _InitializeTouchInjection, _InjectTouchInput, _GetLastError, _GetSystemMetrics;

// ---- hằng số (WinUser.h)
const PT_TOUCH = 2;
const F_INRANGE = 0x0002;
const F_INCONTACT = 0x0004;
const F_CANCELED = 0x8000;
const F_DOWN = 0x10000;
const F_UPDATE = 0x20000;
const F_UP = 0x40000;
const TOUCH_MASK_ALL = 0x1 | 0x2 | 0x4; // CONTACTAREA | ORIENTATION | PRESSURE
const TOUCH_FEEDBACK_DEFAULT = 0x1;

const MAX_CONTACTS = 10;
const HEARTBEAT_MS = 50;   // nhắc Windows là ngón vẫn đang chạm
const STALE_MS = 1500;     // client im lặng quá lâu (mất mạng) -> tự nhấc hết ngón

let ready = false;
let initError = null;
try {
  if (koffi.sizeof(POINTER_TOUCH_INFO) !== 144) {
    throw new Error(`POINTER_TOUCH_INFO sai kích thước: ${koffi.sizeof(POINTER_TOUCH_INFO)}`);
  }
  _InitializeTouchInjection = user32.func('bool __stdcall InitializeTouchInjection(uint32 maxCount, uint32 dwMode)');
  _InjectTouchInput = user32.func(
    'bool __stdcall InjectTouchInput(uint32 count, WG_POINTER_TOUCH_INFO *contacts)'
  );
  _GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
  _GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int)');
  ready = _InitializeTouchInjection(MAX_CONTACTS, TOUCH_FEEDBACK_DEFAULT);
  if (!ready) initError = `InitializeTouchInjection lỗi ${_GetLastError()}`;
} catch (e) {
  initError = e.message;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function screenSize() {
  return { w: _GetSystemMetrics(0) || 1920, h: _GetSystemMetrics(1) || 1080 };
}

/** id (0..9) -> { x, y } toạ độ pixel đang chạm */
const active = new Map();
let lastInputAt = 0;
let heartbeat = null;

function contact(id, x, y, flags) {
  return {
    pointerInfo: {
      pointerType: PT_TOUCH,
      pointerId: id,
      frameId: 0,
      pointerFlags: flags,
      sourceDevice: null,
      hwndTarget: null,
      ptPixelLocation: { x, y },
      ptHimetricLocation: { x: 0, y: 0 },
      ptPixelLocationRaw: { x: 0, y: 0 },
      ptHimetricLocationRaw: { x: 0, y: 0 },
      dwTime: 0,
      historyCount: 0,
      InputData: 0,
      dwKeyStates: 0,
      PerformanceCount: 0,
      ButtonChangeType: 0,
    },
    touchFlags: 0,
    touchMask: TOUCH_MASK_ALL,
    rcContact: { left: x - 2, top: y - 2, right: x + 2, bottom: y + 2 },
    rcContactRaw: { left: 0, top: 0, right: 0, bottom: 0 },
    orientation: 90,
    pressure: 32000,
  };
}

function inject(list) {
  if (!list.length) return true;
  const ok = _InjectTouchInput(list.length, list);
  if (!ok) {
    const err = _GetLastError();
    // Lỗi khi đang có cửa sổ quyền Admin ở trên (UIPI) hoặc trạng thái lệch:
    // dọn sạch để lần chạm sau bắt đầu lại từ đầu.
    if (process.env.WEBGATE_DEBUG) console.warn(`InjectTouchInput lỗi ${err}`);
    active.clear();
    stopHeartbeat();
  }
  return ok;
}

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    if (!active.size) return stopHeartbeat();
    if (Date.now() - lastInputAt > STALE_MS) return cancelAll();
    const list = [];
    for (const [id, p] of active) list.push(contact(id, p.x, p.y, F_UPDATE | F_INRANGE | F_INCONTACT));
    inject(list);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

function stopHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = null;
}

/**
 * Cập nhật một khung cảm ứng từ client.
 * pts: [{ id: 0..9, x: 0..1, y: 0..1, ph: 'd' | 'm' | 'u' | 'c' }]
 * Ngón đang chạm mà không có trong pts thì giữ nguyên vị trí cũ.
 */
function frame(pts) {
  if (!ready || !Array.isArray(pts)) return false;
  lastInputAt = Date.now();
  const scr = screenSize();
  const seen = new Map();

  for (const raw of pts.slice(0, MAX_CONTACTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = Math.round(Number(raw.id));
    if (!Number.isInteger(id) || id < 0 || id >= MAX_CONTACTS) continue;
    const x = Math.round(clamp01(Number(raw.x) || 0) * (scr.w - 1));
    const y = Math.round(clamp01(Number(raw.y) || 0) * (scr.h - 1));
    const ph = raw.ph;
    if (ph !== 'd' && ph !== 'm' && ph !== 'u' && ph !== 'c') continue;
    seen.set(id, { x, y, ph });
  }

  const list = [];
  const lifted = [];

  for (const [id, s] of seen) {
    const was = active.get(id);
    if (s.ph === 'd') {
      if (was) {
        // DOWN cho ngón đang chạm = client đã lệch trạng thái -> coi như di chuyển
        list.push(contact(id, s.x, s.y, F_UPDATE | F_INRANGE | F_INCONTACT));
      } else {
        list.push(contact(id, s.x, s.y, F_DOWN | F_INRANGE | F_INCONTACT));
      }
      active.set(id, { x: s.x, y: s.y });
    } else if (s.ph === 'm') {
      if (!was) continue; // chưa DOWN thì bỏ qua
      list.push(contact(id, s.x, s.y, F_UPDATE | F_INRANGE | F_INCONTACT));
      active.set(id, { x: s.x, y: s.y });
    } else {
      if (!was) continue;
      const flags = s.ph === 'c' ? F_UP | F_CANCELED : F_UP;
      list.push(contact(id, s.x, s.y, flags));
      lifted.push(id);
    }
  }

  // ngón đang chạm nhưng không có trong khung này -> vẫn phải gửi kèm
  for (const [id, p] of active) {
    if (!seen.has(id)) list.push(contact(id, p.x, p.y, F_UPDATE | F_INRANGE | F_INCONTACT));
  }

  const ok = inject(list);
  for (const id of lifted) active.delete(id);
  if (active.size) startHeartbeat();
  else stopHeartbeat();
  return ok;
}

/** Huỷ mọi ngón đang chạm (mất kết nối, đổi chế độ…) — không sinh click. */
function cancelAll() {
  if (!active.size) return stopHeartbeat();
  const list = [];
  for (const [id, p] of active) list.push(contact(id, p.x, p.y, F_UP | F_CANCELED));
  active.clear();
  stopHeartbeat();
  if (ready) _InjectTouchInput(list.length, list);
}

module.exports = {
  get ready() { return ready; },
  get error() { return initError; },
  frame,
  cancelAll,
  activeCount: () => active.size,
  MAX_CONTACTS,
};
