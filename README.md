# WebGate

**Control a Windows PC from your phone's browser — no app to install, nothing to configure on the phone.**

WebGate is a small self-hosted web gateway: open a URL, see the full desktop, and tap / drag / type to drive the machine. Screen streaming is built on `ffmpeg` + WebSocket, and input is injected through real Win32 APIs.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)

🇻🇳 [Đọc bản tiếng Việt](README.vi.md)

---

## Features

- **Full desktop mirror** — the whole screen at 15 fps, adjustable up to 30 fps.
- **Real mouse & keyboard** — clicks, drag & drop, scrolling, right-click, shortcuts, Vietnamese text and emoji.
- **Mobile-first UI** — touch gestures, on-screen keyboard, pinch-to-zoom.
- **Draggable toolbar** — move it anywhere, collapse it to a single icon, or hide it behind an edge tab.
- **Real keyboard passthrough on desktop** — open it on a laptop and every key (Ctrl, Shift, Alt, F1–F12, arrows…) goes straight to the remote machine, like TeamViewer.
- **Landscape fullscreen mode** — one tap locks the view sideways and fills the screen.
- **Quality presets** — saving / balanced / sharp / maximum, switchable from the ⚙️ panel and remembered across restarts.
- **Bandwidth friendly** — unchanged frames are dropped; ffmpeg idles out 15 s after the last viewer leaves.
- **Password protected** — `HttpOnly` session cookie, brute-force throttling.
- **Zero build step** — pure Node.js, no native compilation (`koffi` ships prebuilt FFI bindings).
- **Optional remote access** — one `cloudflared` ingress entry gives you HTTPS from anywhere, and Cloudflare Access adds an email OTP in front of it.

---

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 (x64 or ARM64) |
| Node.js | 18 or newer |
| FFmpeg | must be on `PATH` (or set `FFMPEG=/path/to/ffmpeg.exe`) |
| Network | phone and PC on the same Wi-Fi / LAN |

Check FFmpeg:

```powershell
ffmpeg -version
```

---

## Quick start

```powershell
git clone https://github.com/TwinMindWeekly/04_11_2026_webgate.git
cd webgate
npm install
node server.js
```

Or simply double-click **`start.bat`**.

The console prints everything you need:

```
  ==============================================
     WEBGATE  -  ONLINE
  ==============================================

  May nay    : http://localhost:6090
  Dien thoai : http://192.168.31.78:6090   (Wi-Fi)

  Mat khau   : a1b2c3d4
  Man hinh   : 1920x1080  |  15fps  |  1280px wide
```

Open the phone URL, enter the password, done. A QR code is printed too.

The password is generated once and stored in `.pass` (git-ignored). Delete or edit that file and restart to change it.

### Windows Firewall

On the first run Windows asks whether to allow `node.exe`. Choose **Allow** for **Private networks**. If you dismissed it, run PowerShell **as Administrator**:

```powershell
New-NetFirewallRule -DisplayName "WebGate 6090" -Direction Inbound -LocalPort 6090 -Protocol TCP -Action Allow -Profile Private
```

---

## Using it on the phone

There are **two control modes**, switched with the 👆/🖱️ toolbar button (or in ⚙️). On first launch a **phone** starts in *Touchpad* and a **tablet** in *Direct touch*.

### 👆 Direct touch — like a Windows tablet

Fingers are injected into Windows as **real touch contacts** (`InjectTouchInput`), exactly as a Surface touchscreen reports them. Windows itself recognises the gestures:

| Gesture | Result (handled by Windows) |
| --- | --- |
| Tap | Click |
| Double tap | Double click |
| Press and hold, release | Right click (Windows shows its square indicator) |
| Drag one finger | Pan/scroll or drag, depending on the app |
| Pinch | **Zoom the view** on the phone (the first finger is cancelled, no click) |
| Two-finger drag | Pan the zoomed view |
| 3/4-finger gestures, edge swipes | As on Windows 11 (see note) |

> Whether Windows triggers system gestures (3/4-finger, edge swipes) from injected touch is **not verified on every machine**. The **⊞** panel offers Start, Task View, notifications, quick settings, etc. as a fallback.

### 🖱️ Touchpad — with a mouse pointer

Like Microsoft Remote Desktop's mouse mode: the phone becomes a touchpad and the pointer is drawn locally (no network wait). Much more precise when a 1920 px desktop is squeezed onto a phone.

| Gesture | Action |
| --- | --- |
| Drag one finger | Move the pointer (with acceleration) |
| Tap | Left click at the pointer |
| Double tap | Double click |
| Tap, then drag | Hold left button + drag (drag & drop, text selection) |
| Long press | Right click |
| Two-finger tap | Right click |
| Two-finger drag | Scroll |
| Pinch | Zoom the local view (follows the pointer) |
| Three-finger tap | Search (Win+S) |
| Three-finger swipe up / down / sideways | Task View / Desktop / Alt+Tab |

### Toolbar

| Button | Action |
| --- | --- |
| 👆 / 🖱️ | Switch control mode |
| ⌨️ | Open the **phone's own keyboard** — keystrokes go through live |
| ⊞ | Windows panel: Start, Task View, Alt+Tab, Desktop, notifications, quick settings, copy/paste/undo, special keys |
| 🔍 | Adjust the view: pinch to zoom, drag to pan, double tap to fit. Touches are **not** sent while active (blue border) |
| ⛶ | **Landscape fullscreen** — toolbar hides after 2.6 s, tap to bring it back |
| ⚙️ | Control mode, pointer speed, image quality, FPS, logout |
| ✕ | Collapse the toolbar to a single icon |

**Typing** — tap ⌨️: the phone keyboard opens with an accessory row (Esc, Tab, Ctrl, Alt, Shift, ⊞, arrows, Del, Home, End). Vietnamese Telex/VNI, suggestions and autocorrect all come out right, because WebGate sends the text diff and types it as Unicode via `SendInput` — **the clipboard is not touched**.

**Shortcuts** — tap `Ctrl` on the accessory row, then type `c` = Ctrl+C. For long text use *Dán đoạn văn dài* in the ⊞ panel.

### Image quality

The ⚙️ panel starts with a **quality preset**. Each preset sets the stream width and the JPEG quality together:

| Preset | Width | JPEG `-q:v` | Approx. bandwidth | When to use |
| --- | --- | --- | --- | --- |
| Tiết kiệm | 854 px | 14 | ~0.4 MB/s | mobile data, slow Wi-Fi |
| Cân bằng | 1280 px | 8 | ~0.9–1.2 MB/s | default, good all-rounder |
| **Nét** | 1600 px | 5 | ~1.9–3.0 MB/s | reading small text, LAN |
| **Nét tối đa** | 1920 px | 3 | ~3.2 MB/s | pixel-perfect on a 1080p screen |

Figures are measured on 1920×1080 desktop content at 15 fps; busy screens compress worse.

Two things decide sharpness, and they are independent:

- **Width** matters most. At `1280` the 1920-px desktop is downscaled first and the browser scales it again — text gets softened twice. `1920` sends the native framebuffer, so only one resample happens.
- **`-q:v`** is inverted: **2 = sharpest, 20 = softest**. Lower values mean bigger frames.

Scaling uses `lanczos+accurate_rnd+full_chroma_int`, which keeps edges crisp when the stream does have to be downscaled.

Presets are saved to `.config.json` on the server, so the choice survives a restart. The two dropdowns below the preset (width and JPEG quality) are there for manual override; pick a value that no preset matches and the dropdown switches to *Tuỳ chỉnh*.

### Moving the toolbar

- **Drag** the bar or the icon anywhere. Position is remembered in `localStorage`.
- Inside fullscreen, the dock fades out after 2.6 s; tap the screen to show it again.

### Keyboard passthrough (desktop)

On a machine with a real mouse and keyboard (laptop / PC), WebGate enables **physical keyboard passthrough** automatically: click anywhere on the page and every key you press is injected into the remote machine as a real key — same as sitting in front of it.

- Modifiers are forwarded as themselves, so `Ctrl`+`C`, `Alt`+`F4`, `Shift`+`click`, `Win`+`D` all work.
- **Holding** a key repeats it, because `keydown` repeats are forwarded too.
- Keys are released automatically when the tab loses focus or the connection drops, so nothing gets stuck.
- Typing inside WebGate's own fields (password, text box, FPS select) is **not** forwarded — you can always edit the UI.
- Toggle it in the ⚙️ panel. The HUD shows `⌨ phím thật` while it is on. The setting is remembered per browser.

**Keyboard Lock (Chromium fullscreen)** — when you enter fullscreen via the ⛶ button, WebGate uses the [Keyboard Lock API](https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock) to capture even the keys normally reserved by the browser. With Keyboard Lock active the HUD shows `⌨ phím thật · đã khoá phím` and these keys go to the remote machine instead of the browser:

| Keys | Normally | With lock |
| --- | --- | --- |
| `Escape` | exits fullscreen | forwarded (hold 2 s to exit) |
| `F5`, `F11`, `F12` | reload / fullscreen / devtools | forwarded |
| `Ctrl`+`W` / `T` / `N` | close tab, new tab, new window | forwarded |
| `Ctrl`+`Shift`+`I` / `J` / `C` | devtools | forwarded |
| `Ctrl`+`Tab` | switch browser tab | forwarded |

Requirements: **Chromium** (Chrome / Edge / Opera) ≥ 68, **secure context** (HTTPS or `localhost`), **JS-triggered fullscreen** (the ⛶ button). Chrome 130+ shows a one-time permission prompt; denying it falls back to normal mode. Firefox / Safari do not support this API yet.

**Always OS-level** — no application (web *or* native) can intercept these:

| Keys | Why |
| --- | --- |
| `Alt`+`Tab` | OS window manager |
| `Ctrl`+`Alt`+`Del` | Windows secure attention sequence (kernel) |
| `Win` key | OS Start menu |

Use the on-screen keyboard panel (⌨️) for these if you need them on the remote machine.

---

## Remote access with Cloudflare Tunnel (optional)

Use this to reach the machine from any network — no port forwarding, no public IP, no router changes. Cloudflare takes the traffic over an outbound-only tunnel.

You need: a domain on Cloudflare, and `cloudflared` installed on the PC.

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel login                    # pick the domain in the browser
cloudflared tunnel create webgate           # creates a UUID + credentials json
```

Add the route to your config (`%USERPROFILE%\.cloudflared\config.yml`):

```yaml
tunnel: <UUID-from-create>
credentials-file: C:\Users\<you>\.cloudflared\<UUID>.json

originRequest:
  connectTimeout: 30s

ingress:
  - hostname: remote.example.com
    service: http://127.0.0.1:6090
  - service: http_status:404        # catch-all MUST stay last
```

Create the DNS record and start it:

```powershell
cloudflared tunnel route dns webgate remote.example.com
cloudflared tunnel ingress validate         # checks the YAML
cloudflared tunnel run webgate              # foreground test
cloudflared service install                 # then run as a Windows service
```

Open `https://remote.example.com` — same UI, over HTTPS. The client switches to `wss://` automatically, and it pings every 4 s so Cloudflare does not drop the stream when the screen is idle.

Notes:

- **Adding another hostname later** is just one more `ingress` block + `cloudflared tunnel route dns`, then restart the service (`Restart-Service Cloudflared`, needs admin).
- The service runs as LocalSystem. If you restart it, all hostnames on that tunnel blip for a second or two.
- Bandwidth goes through Cloudflare's edge — watch the free-plan limits if you stream for hours.

### Put Cloudflare Access in front of it

A tunnel gives you HTTPS, not authentication. WebGate's password alone would be the only thing between the Internet and your whole desktop, so add Zero Trust:

1. **dash.cloudflare.com → Zero Trust → Access → Applications → Add an application → Self-hosted**
2. Application name `WebGate`, public hostname = the tunnel hostname
3. **Add a policy**: Action `Allow`, Include → **Emails** → your address
4. Session duration: `1 week` (or whatever suits you) → **Save**

Now every visit asks for an email one-time PIN *before* the WebGate login screen appears. Free plan covers up to 50 users; add more emails to the same policy for family or teammates.

Because Access blocks non-browser clients, scripts that call the API need a **Service Token** (Zero Trust → Access → Service Auth), sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.

---

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `6090` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` = local only) |
| `GATE_PASS` | from `.pass` | Password (overrides the file) |
| `FPS` | `15` | Frames per second (2–30) |
| `WIDTH` | `1280` | Stream width in px, aspect ratio preserved |
| `QUALITY` | `8` | JPEG quality, **lower = sharper** (2–25) |
| `FFMPEG` | `ffmpeg` | Path to the ffmpeg binary |

Quality can also be changed live from the ⚙️ panel (applies to every connected viewer) and is persisted to `.config.json` (git-ignored). Precedence: environment variable → `.config.json` → built-in default.

Low-bandwidth example:

```powershell
$env:FPS=8; $env:WIDTH=1024; $env:QUALITY=14; node server.js
```

---

## Architecture

```
Phone (canvas)  ──wss──►  Node server  ──pipe──►  ffmpeg gdigrab
       │                       │
       └──── JSON input ───────┴──► user32.dll (SetCursorPos / mouse_event / keybd_event)
```

| Path | Responsibility |
| --- | --- |
| `server.js` | HTTP, static files, auth, WebSocket broadcast, input dispatch, config persistence |
| `lib/capture.js` | Spawns ffmpeg, parses the MJPEG pipe, drops identical frames |
| `lib/input.js` | Injects mouse/keyboard via `user32.dll` through `koffi` |
| `lib/touch.js` | Injects real multi-touch contacts (`InjectTouchInput`) for Direct touch mode, with a server-side heartbeat |
| `public/` | Mobile-first client (vanilla JS, no framework) |

One ffmpeg pipeline is shared by every viewer. The process declares itself DPI-aware so coordinates line up on scaled displays (125 % / 150 %).

---

## Security

This grants **full control of your machine**. Treat it accordingly.

- Password login with `HttpOnly` cookie; 5 failed attempts lock the IP for 30 s.
- **No HTTPS built in.** On the LAN, password and screen data travel in clear text — anyone sniffing the Wi-Fi sees everything. Use trusted networks only.
- **Never port-forward this port to the Internet.** If you need remote access, use Cloudflare Tunnel **with Access** (above), or a VPN (Tailscale, WireGuard, …).
- Cloudflare Tunnel alone gives you encryption, not authentication — add Cloudflare Access, and keep a strong WebGate password as the second layer.
- The server runs with your user privileges: it **cannot** drive windows running as Administrator (UAC prompts included).
- Screen content is untrusted input. If an AI agent is watching the same desktop, on-screen text can be used for prompt injection.

---

## Known limitations

- **Ctrl+Alt+Del** cannot be sent (Windows blocks synthetic Secure Attention Sequence).
- The *Send text* button (long paste) uses the clipboard and **overwrites it**. Typing through ⌨️ does not.
- **Elevated windows** (Task Manager, apps run as administrator, UAC prompts) ignore WebGate's mouse/keyboard/touch — Windows blocks it (UIPI). UAC runs on the secure desktop and may not even show in the stream. To control them, run `start.bat` as administrator — at the cost that anyone who gets past the login also gets admin rights.
- *Direct touch* needs Windows 8+. If `InjectTouchInput` is unavailable, the console prints `Cam ung: KHONG dung duoc` and the client falls back to *Touchpad*.
- Primary monitor only — multi-monitor is not supported yet.
- No audio, no file transfer, no two-way clipboard sync.
- GPU-drawn surfaces (games, exclusive fullscreen video) may capture as black with `gdigrab`.
- Over a tunnel, expect 30–80 ms extra round-trip against LAN.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Black screen | ffmpeg failed — check the console, test `ffmpeg -f gdigrab -i desktop -t 1 test.jpg` |
| Phone can't connect | different Wi-Fi, firewall blocked, or `HOST=127.0.0.1` |
| Choppy / laggy | lower the quality preset, lower `FPS` |
| Image looks soft | the stream is downscaled — pick **Nét tối đa** (1920 px) |
| Clicks land in the wrong place | display scaling or multi-monitor setup |
| Clicks do nothing | target app runs as Administrator |
| `EADDRINUSE` on start | another instance is already listening on the port |
| Tunnel domain returns 502 | nothing is listening on the origin port — check WebGate is running |
| Tunnel domain redirects to `*.cloudflareaccess.com` | Cloudflare Access is doing its job; log in with the authorised email |

---

## License

[MIT](LICENSE)
