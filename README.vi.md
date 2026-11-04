# WebGate — điều khiển máy tính từ điện thoại qua LAN

🇬🇧 [Read in English](README.md)

Cổng web nhỏ gọn: mở trình duyệt trên điện thoại → thấy **toàn bộ màn hình** máy tính → chạm/kéo/gõ phím để điều khiển.

- Không cloud, không tài khoản, không cần cài app trên điện thoại.
- Chỉ chạy trong LAN của bạn (Wi-Fi nhà/công ty).
- Toàn bộ code nằm trong thư mục này.

---

## 1. Chạy

```bat
start.bat
```

hoặc

```bat
node server.js
```

Console sẽ in ra:

```
  May nay    : http://localhost:6090
  Dien thoai : http://192.168.31.78:6090   (Wi-Fi)
  Mat khau   : a1b2c3d4
```

Điện thoại (cùng Wi-Fi) mở `http://192.168.31.78:6090` → nhập mật khẩu → xong.
Hoặc quét **mã QR** in ngay dưới đó.

Mật khẩu được sinh 1 lần và lưu ở file `.pass`. Muốn đổi: sửa/xoá file đó rồi chạy lại.

### Lần đầu bị chặn?

Windows Firewall sẽ hỏi khi `node.exe` mở cổng → chọn **Allow access** cho **Private networks**.
Nếu lỡ bấm Cancel, mở PowerShell **Admin** và chạy:

```powershell
New-NetFirewallRule -DisplayName "WebGate 6090" -Direction Inbound -LocalPort 6090 -Protocol TCP -Action Allow -Profile Private
```

---

## 2. Cách dùng trên điện thoại

| Thao tác | Kết quả |
|---|---|
| Chạm 1 lần | Click trái |
| Chạm 2 lần liên tiếp | Double click |
| **Giữ 1 giây** | Click phải (có rung) |
| Kéo 1 ngón | Giữ chuột trái + di chuyển (drag & drop) |
| Kéo 2 ngón | Cuộn (scroll) |
| Chụm 2 ngón | Zoom khung hình (chỉ zoom phía điện thoại) |
| 2 ngón khi đã zoom | Di chuyển khung nhìn |
| Nút 🖱️ | Bật chế độ "chạm = click phải" cho lần chạm kế tiếp |
| Nút ⌨️ | Bàn phím: gõ tiếng Việt, phím tắt, phím mũi tên… |
| Nút ⤢ | Về mức zoom 1:1 vừa màn hình |
| Nút ⛶ | Toàn màn hình (ẩn thanh địa chỉ) |
| Nút ⚙️ | FPS / độ nét / chất lượng, đăng xuất |

**Gõ chữ:** mở ⌨️ → gõ vào ô văn bản → **Gửi văn bản**. Cách này dán nguyên chuỗi nên tiếng Việt, emoji, nhiều dòng đều đúng.

**Phím tắt:** bật `Ctrl` (hoặc Alt/Shift/Win) rồi bấm phím tương ứng. Ví dụ `Ctrl` + `c` = Ctrl+C.

---

## 3. Cấu hình (biến môi trường)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `6090` | Cổng HTTP |
| `HOST` | `0.0.0.0` | Địa chỉ lắng nghe (`127.0.0.1` = chỉ máy này) |
| `GATE_PASS` | (file `.pass`) | Mật khẩu |
| `FPS` | `15` | Số khung/giây |
| `WIDTH` | `1280` | Chiều rộng ảnh gửi về (thu nhỏ, giữ tỉ lệ) |
| `QUALITY` | `8` | Chất lượng JPEG, **số nhỏ = nét hơn** (2–25) |
| `FFMPEG` | `ffmpeg` | Đường dẫn ffmpeg nếu không có trong PATH |

Ví dụ chạy nhẹ cho mạng yếu:

```bat
set FPS=8 && set WIDTH=1024 && set QUALITY=14 && node server.js
```

Chỉnh nhanh ngay trong app ở nút ⚙️ (áp dụng cho mọi thiết bị đang xem).

---

## 4. Kiến trúc

```
Điện thoại (canvas)  ──wss──►  Node server  ──stdin/stdout──►  ffmpeg gdigrab
        │                          │
        └──── JSON input ──────────┴──► user32.dll (SetCursorPos / mouse_event / keybd_event)
```

- `server.js` — HTTP + WebSocket + đăng nhập + broadcast khung hình.
- `lib/capture.js` — chạy ffmpeg, bóc từng ảnh JPEG từ pipe, **bỏ qua khung không đổi** (tiết kiệm băng thông khi màn hình tĩnh).
- `lib/input.js` — bơm chuột/phím thật qua `koffi` (FFI, không cần biên dịch).
- `public/` — giao diện mobile-first.

Một pipeline ffmpeg dùng chung cho mọi client; ffmpeg tự tắt sau 15s khi không còn ai xem.

---

## 5. Bảo mật — đọc trước khi dùng

Đây là **toàn quyền điều khiển máy**, đừng đùa với nó.

- ✅ Có mật khẩu + cookie `HttpOnly`, chống dò 5 lần sai → khoá 30s.
- ⚠️ **Không có HTTPS.** Mật khẩu và hình ảnh đi dạng thô trong LAN. Ai sniff được Wi-Fi là thấy hết. Chỉ dùng trong mạng tin cậy.
- ⚠️ **Không chống được prompt injection**: nếu agent AI nào đó trên máy bạn đọc nội dung màn hình, nó có thể bị lừa. Đừng để WebGate chạy khi đang cho AI điều khiển máy.
- ⚠️ Không nên mở cổng này ra Internet (port forwarding). Cần truy cập từ xa thì dùng VPN (Tailscale/WireGuard) rồi truy cập qua IP nội bộ của VPN.
- Server chạy bằng quyền user hiện tại → **không** điều khiển được cửa sổ chạy quyền Admin (UAC).
- Đăng xuất: nút ⚙️ → Đăng xuất (xoá cookie). Đổi mật khẩu: xoá `.pass`, chạy lại.

---

## 6. Giới hạn đã biết

- **Ctrl+Alt+Del** không gửi được (Windows chặn Secure Attention Sequence từ app thường) — phải bấm tay.
- Gõ chữ dùng clipboard → **ghi đè clipboard** hiện tại của máy.
- Chỉ màn hình chính (1 màn hình). Đa màn hình chưa hỗ trợ.
- Không có âm thanh, không chuyển file, không đồng bộ clipboard 2 chiều.
- Một số app vẽ bằng GPU (game, video full-screen) có thể không bắt được bằng `gdigrab`.
- Chạy như cửa sổ console; muốn tự khởi động cùng Windows thì tạo shortcut `start.bat` trong `shell:startup`.

---

## 7. Gỡ lỗi nhanh

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Màn hình đen | ffmpeg lỗi → xem console; kiểm tra `ffmpeg -f gdigrab -i desktop -t 1 test.jpg` |
| Điện thoại không vào được | sai Wi-Fi / firewall / `HOST` bị đặt `127.0.0.1` |
| Nhấp nháy, giật | hạ `fps`, tăng `quality` (số lớn hơn), giảm `width` |
| Chuột lệch vị trí | màn hình scale lạ → server đã gọi `SetProcessDPIAware()`; nếu vẫn lệch, kiểm tra đa màn hình |
| Bấm không ăn | app đang chạy quyền Admin, hoặc app không nhận input tổng hợp |
