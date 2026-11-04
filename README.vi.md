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
| Nút ⛶ | Toàn màn hình + **xoay ngang** (thanh công cụ tự ẩn sau 2.6s) |
| Nút ⚙️ | Chất lượng hình / FPS, đăng xuất |

**Gõ chữ:** mở ⌨️ → gõ vào ô văn bản → **Gửi văn bản**. Cách này dán nguyên chuỗi nên tiếng Việt, emoji, nhiều dòng đều đúng.

**Phím tắt:** bật `Ctrl` (hoặc Alt/Shift/Win) rồi bấm phím tương ứng. Ví dụ `Ctrl` + `c` = Ctrl+C.

### Chất lượng hình

Trong ⚙️, mục đầu tiên là **preset chất lượng**. Mỗi preset đặt đồng thời độ rộng và chất lượng JPEG:

| Preset | Độ rộng | JPEG `-q:v` | Băng thông | Dùng khi |
|---|---|---|---|---|
| Tiết kiệm | 854 px | 14 | ~0.4 MB/s | dùng 4G, Wi-Fi yếu |
| Cân bằng | 1280 px | 8 | ~0.9–1.2 MB/s | mặc định |
| **Nét** | 1600 px | 5 | ~1.9–3.0 MB/s | cần đọc chữ nhỏ, trong LAN |
| **Nét tối đa** | 1920 px | 3 | ~3.2 MB/s | màn hình 1080p, nét từng pixel |

Số đo trên nội dung 1920×1080 ở 15 fps; màn hình càng nhiều chi tiết thì càng tốn băng thông.

Hai yếu tố quyết định độ nét, độc lập nhau:

- **Độ rộng** là quan trọng nhất. Để `1280`, màn hình 1920 bị thu nhỏ một lần rồi trình duyệt thu nhỏ thêm lần nữa → chữ mờ đi hai lần. Để `1920`, server gửi nguyên khung hình gốc, chỉ còn một lần resample.
- **`-q:v`** ngược đời: **2 = nét nhất, 20 = mờ nhất**. Số càng nhỏ thì ảnh càng nặng.

Khi phải thu nhỏ, ffmpeg dùng `lanczos+accurate_rnd+full_chroma_int` để giữ cạnh chữ sắc.

Preset được lưu vào `.config.json` trên server nên **khởi động lại không mất**. Hai ô bên dưới preset để chỉnh tay: chọn cặp giá trị không preset nào khớp thì ô preset tự chuyển thành *Tuỳ chỉnh*.

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

Chỉnh nhanh ngay trong app ở nút ⚙️ (áp dụng cho mọi thiết bị đang xem). Giá trị chỉnh trong app được ghi vào `.config.json` (đã gitignore) nên **giữ nguyên sau khi restart**. Thứ tự ưu tiên: biến môi trường → `.config.json` → mặc định.

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

## 5. Truy cập từ xa bằng Cloudflare Tunnel (tuỳ chọn)

Dùng khi cần vào máy từ mạng khác (4G, Wi-Fi công ty) mà **không mở port, không cần IP tĩnh**: Cloudflare nhận traffic qua một tunnel chỉ đi ra ngoài.

Cần: một domain đã trỏ về Cloudflare, và `cloudflared` trên máy.

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel login              # chọn domain trong trình duyệt
cloudflared tunnel create webgate     # sinh UUID + file credentials
```

Thêm route vào `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: <UUID-vua-tao>
credentials-file: C:\Users\<ban>\.cloudflared\<UUID>.json

ingress:
  - hostname: remote.example.com
    service: http://127.0.0.1:6090
  - service: http_status:404        # dòng catch-all BẮT BUỘC nằm cuối
```

Tạo DNS rồi chạy:

```powershell
cloudflared tunnel route dns webgate remote.example.com
cloudflared tunnel ingress validate      # kiểm tra YAML
cloudflared tunnel run webgate           # chạy thử
cloudflared service install              # sau đó chạy dạng service Windows
```

Mở `https://remote.example.com` — giao diện y như trong LAN nhưng qua HTTPS. Client tự đổi sang `wss://`, và ping mỗi 4 giây nên Cloudflare không cắt stream khi màn hình đứng yên.

Lưu ý:

- **Thêm domain khác** chỉ là thêm 1 block `ingress` + `cloudflared tunnel route dns`, rồi restart service (`Restart-Service Cloudflared`, cần Admin). Restart sẽ làm các domain khác trên cùng tunnel mất kết nối 1–2 giây.
- Service chạy dưới quyền LocalSystem, đọc config trong `%USERPROFILE%\.cloudflared\`.
- Băng thông đi qua edge Cloudflare — xem giới hạn free plan nếu stream nhiều giờ.

### Nên bật Cloudflare Access

Tunnel chỉ cho bạn HTTPS, **không phải xác thực**. Nếu chỉ có mật khẩu WebGate thì đó là thứ duy nhất chắn giữa Internet và toàn bộ máy tính. Bật Zero Trust:

1. **dash.cloudflare.com → Zero Trust → Access → Applications → Add an application → Self-hosted**
2. Tên `WebGate`, public hostname = hostname của tunnel
3. **Add policy**: Action `Allow`, Include → **Emails** → email của bạn
4. Session duration: `1 week` → **Save**

Từ đó mỗi lần vào sẽ hỏi email + mã OTP **trước khi** hiện màn hình đăng nhập WebGate. Free plan tối đa 50 user; thêm email vào cùng policy cho người nhà/đồng nghiệp.

Vì Access chặn cả client không phải trình duyệt, script gọi API phải dùng **Service Token** (Zero Trust → Access → Service Auth), gửi kèm header `CF-Access-Client-Id` / `CF-Access-Client-Secret`.

---

## 6. Bảo mật — đọc trước khi dùng

Đây là **toàn quyền điều khiển máy**, đừng đùa với nó.

- ✅ Có mật khẩu + cookie `HttpOnly`, chống dò 5 lần sai → khoá 30s.
- ⚠️ **Không có HTTPS.** Mật khẩu và hình ảnh đi dạng thô trong LAN. Ai sniff được Wi-Fi là thấy hết. Chỉ dùng trong mạng tin cậy.
- ⚠️ **Không chống được prompt injection**: nếu agent AI nào đó trên máy bạn đọc nội dung màn hình, nó có thể bị lừa. Đừng để WebGate chạy khi đang cho AI điều khiển máy.
- ⚠️ **Không nên mở cổng này ra Internet** (port forwarding). Cần truy cập từ xa thì dùng Cloudflare Tunnel **kèm Access** (mục 5) hoặc VPN (Tailscale/WireGuard) rồi truy cập qua IP nội bộ của VPN.
- ⚠️ Cloudflare Tunnel chỉ mã hoá, **không xác thực** — phải bật Access, và vẫn nên giữ mật khẩu WebGate đủ mạnh làm lớp 2.
- Server chạy bằng quyền user hiện tại → **không** điều khiển được cửa sổ chạy quyền Admin (UAC).
- Đăng xuất: nút ⚙️ → Đăng xuất (xoá cookie). Đổi mật khẩu: xoá `.pass`, chạy lại.

---

## 7. Giới hạn đã biết

- **Ctrl+Alt+Del** không gửi được (Windows chặn Secure Attention Sequence từ app thường) — phải bấm tay.
- Gõ chữ dùng clipboard → **ghi đè clipboard** hiện tại của máy.
- Chỉ màn hình chính (1 màn hình). Đa màn hình chưa hỗ trợ.
- Không có âm thanh, không chuyển file, không đồng bộ clipboard 2 chiều.
- Một số app vẽ bằng GPU (game, video full-screen) có thể không bắt được bằng `gdigrab`.
- Chạy như cửa sổ console; muốn tự khởi động cùng Windows thì tạo shortcut `start.bat` trong `shell:startup`.

---

## 8. Gỡ lỗi nhanh

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Màn hình đen | ffmpeg lỗi → xem console; kiểm tra `ffmpeg -f gdigrab -i desktop -t 1 test.jpg` |
| Điện thoại không vào được | sai Wi-Fi / firewall / `HOST` bị đặt `127.0.0.1` |
| Nhấp nháy, giật | hạ `fps`, tăng `quality` (số lớn hơn), giảm `width` |
| Hình hơi mờ | stream đang bị thu nhỏ → chọn preset **Nét tối đa** (1920px) |
| Chuột lệch vị trí | màn hình scale lạ → server đã gọi `SetProcessDPIAware()`; nếu vẫn lệch, kiểm tra đa màn hình |
| Bấm không ăn | app đang chạy quyền Admin, hoặc app không nhận input tổng hợp |
| Domain tunnel trả 502 | không có gì lắng nghe ở cổng gốc — kiểm tra WebGate còn chạy không |
| Domain tunnel nhảy sang `*.cloudflareaccess.com` | Access đang chặn đúng — đăng nhập bằng email đã cho phép |
