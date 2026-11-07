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

Có **2 chế độ điều khiển**. Đổi bằng nút 👆/🖱️ trên thanh công cụ (hoặc trong ⚙️). Lần đầu mở, **điện thoại** dùng *Touchpad*, **tablet** dùng *Chạm trực tiếp*.

### 👆 Chạm trực tiếp — như Windows tablet

Ngón tay được bơm vào Windows dưới dạng **cảm ứng thật** (`InjectTouchInput`), y như màn hình cảm ứng của Surface. Windows tự nhận diện cử chỉ, nên cách dùng giống hệt một chiếc tablet chạy Windows:

| Thao tác | Kết quả (do Windows xử lý) |
|---|---|
| Chạm | Click |
| Chạm 2 lần | Double click |
| Giữ rồi nhả | Chuột phải (Windows hiện ô vuông khi giữ) |
| 1 ngón kéo | Cuộn trang / kéo đối tượng (tuỳ app, như tablet) |
| Chụm / mở 2 ngón | Zoom **trong app** (trình duyệt, ảnh, bản đồ…) |
| Cử chỉ 3/4 ngón, vuốt từ cạnh | Theo Windows 11 (xem ghi chú bên dưới) |

> Cử chỉ 3/4 ngón và vuốt từ cạnh màn hình phụ thuộc việc Windows có nhận cảm ứng giả lập cho cử chỉ hệ thống hay không — **chưa kiểm chứng trên mọi máy**. Nếu không ăn, dùng panel **⊞** (Start, Các cửa sổ, Thông báo, Cài đặt nhanh…).

### 🖱️ Touchpad — có con trỏ chuột

Giống chế độ chuột của Microsoft Remote Desktop: màn hình điện thoại thành touchpad, con trỏ được vẽ ngay trên điện thoại (không chờ mạng). Chính xác hơn nhiều khi màn hình 1920px bị thu vào điện thoại 6 inch.

| Thao tác | Kết quả |
|---|---|
| 1 ngón kéo | Di con trỏ (có gia tốc như chuột Windows) |
| Chạm | Click trái tại con trỏ |
| Chạm 2 lần | Double click |
| Chạm rồi kéo ngay | Giữ chuột trái + kéo (kéo thả, bôi đen chữ) |
| Giữ | Chuột phải |
| Chạm 2 ngón | Chuột phải |
| 2 ngón kéo | Cuộn |
| Chụm 2 ngón | Phóng to khung nhìn (khung tự đi theo con trỏ) |
| Chạm 3 ngón | Tìm kiếm (Win+S) |
| Vuốt 3 ngón lên / xuống / ngang | Các cửa sổ (Win+Tab) / Desktop (Win+D) / App trước (Alt+Tab) |

### Thanh công cụ

| Nút | Chức năng |
|---|---|
| 👆 / 🖱️ | Đổi chế độ điều khiển |
| ⌨️ | Mở **bàn phím điện thoại** — gõ tới đâu ra tới đó |
| ⊞ | Panel Windows: Start, Các cửa sổ, Alt+Tab, Desktop, Thông báo, Cài đặt nhanh, Copy/Paste/Undo, phím đặc biệt |
| 🔍 | Chỉnh khung nhìn: chụm để phóng to, kéo để di chuyển, chạm 2 lần = vừa màn hình. Lúc này chạm **không** gửi sang máy (có viền xanh) |
| ⛶ | Toàn màn hình + **xoay ngang** (thanh công cụ tự ẩn sau 2.6s) |
| ⚙️ | Chế độ điều khiển, tốc độ con trỏ, chất lượng hình, FPS, đăng xuất |
| ✕ | Thu nhỏ thanh công cụ thành 1 icon tròn |

**Gõ chữ:** bấm ⌨️ → bàn phím của điện thoại bật lên, kèm thanh phím phụ (Esc, Tab, Ctrl, Alt, Shift, ⊞, mũi tên, Del, Home, End). Gõ Telex/VNI, gợi ý từ, tự sửa… đều ra đúng trên máy, vì WebGate gửi phần chữ thay đổi và gõ bằng Unicode (`SendInput`) — **không đụng clipboard**.

**Phím tắt:** chạm `Ctrl` trên thanh phụ rồi gõ `c` = Ctrl+C. Đoạn văn dài thì dán vào ô *Dán đoạn văn dài* trong panel ⊞.

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

### Kéo thả thanh công cụ

- **Kéo** thanh hoặc icon tròn tới bất kỳ đâu; **nhớ vị trí** (localStorage).
- Trong toàn màn hình, cả cụm tự mờ đi sau 2.6s; chạm vào màn hình để hiện lại.

### Bàn phím máy tính (desktop)

Mở WebGate trên laptop/PC có chuột + bàn phím thật thì **bàn phím thật được bật sẵn**: bấm vào trang rồi gõ, mọi phím đi thẳng sang máy đích như đang ngồi trước máy đó.

- Phím bổ trợ đi đúng: `Ctrl`+`C`, `Alt`+`F4`, `Shift`+click, `Win`+`D`…
- **Giữ phím** sẽ tự lặp, vì sự kiện lặp của `keydown` cũng được gửi.
- Tự **nhả hết phím** khi tab mất focus hoặc mất kết nối → không bị kẹt phím.
- Gõ trong ô của chính WebGate (mật khẩu, ô văn bản, ô chọn FPS) thì **không** gửi sang — luôn sửa được giao diện.
- Bật/tắt ở panel ⚙️. Khi bật, HUD hiện `⌨ phím thật`. Trình duyệt nhớ lựa chọn.

**Keyboard Lock (toàn màn hình Chromium)** — khi bạn vào toàn màn hình bằng nút ⛶, WebGate dùng [Keyboard Lock API](https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock) để bắt cả những phím trình duyệt thường giữ riêng. Khi khoá phím thành công, HUD hiện `⌨ phím thật · đã khoá phím` và các phím sau đi sang máy đích thay vì tác động lên trình duyệt:

| Phím | Bình thường | Khi khoá phím |
|---|---|---|
| `Escape` | thoát toàn màn hình | gửi sang máy đích (giữ 2 giây để thoát) |
| `F5`, `F11`, `F12` | tải lại / toàn màn hình / devtools | gửi sang máy đích |
| `Ctrl`+`W` / `T` / `N` | đóng tab, tab mới, cửa sổ mới | gửi sang máy đích |
| `Ctrl`+`Shift`+`I` / `J` / `C` | devtools | gửi sang máy đích |
| `Ctrl`+`Tab` | chuyển tab trình duyệt | gửi sang máy đích |

Điều kiện: **Chromium** (Chrome / Edge / Opera) ≥ 68, **secure context** (HTTPS hoặc `localhost`), **toàn màn hình do JS gọi** (nút ⛶). Chrome 130+ hỏi quyền một lần; từ chối thì quay về chế độ thường. Firefox / Safari chưa hỗ trợ API này.

**Luôn thuộc về HĐH** — không ứng dụng nào (web *lẫn* native) chặn được:

| Phím | Lý do |
|---|---|
| `Alt`+`Tab` | trình quản lý cửa sổ của HĐH |
| `Ctrl`+`Alt`+`Del` | chuỗi bảo mật Windows (kernel) |
| Phím `Win` | menu Start của HĐH |

Dùng panel bàn phím ảo (⌨️) nếu cần gửi các phím này sang máy đích.

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
- `lib/touch.js` — bơm cảm ứng thật nhiều ngón (`InjectTouchInput`) cho chế độ Chạm trực tiếp, tự giữ nhịp cho ngón đang chạm.
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
- Nút *Gửi văn bản* (dán đoạn dài) dùng clipboard → **ghi đè clipboard** hiện tại của máy. Gõ bằng ⌨️ thì không.
- **Cửa sổ chạy quyền Admin** (Task Manager, app "Run as administrator", hộp thoại UAC) không nhận chuột/phím/cảm ứng từ WebGate — Windows chặn (UIPI). Hộp thoại UAC nằm trên màn hình bảo mật riêng nên có thể không thấy cả trong stream. Cần điều khiển các cửa sổ đó thì chạy `start.bat` bằng **Run as administrator** — đổi lại, ai vượt qua được lớp đăng nhập cũng có quyền Admin trên máy.
- Chế độ *Chạm trực tiếp* cần Windows 8 trở lên; nếu `InjectTouchInput` không dùng được, console in `Cam ung: KHONG dung duoc` và giao diện tự dùng *Touchpad*.
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
