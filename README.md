# WebGate

**Control a Windows PC from your phone's browser over LAN — no app, no cloud, no account.**

WebGate is a small self-hosted web gateway: open a URL on your phone, see the full desktop, and tap / drag / type to drive the machine. Screen streaming is built on `ffmpeg` + WebSocket, and input is injected through real Win32 APIs.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![Node](https://img.shields.io/badge/node-%3E%3D18-339933)

🇻🇳 [Đọc bản tiếng Việt](README.vi.md)

---

## Features

- **Full desktop mirror** — the whole screen at 15 fps, adjustable up to 30 fps.
- **Real mouse & keyboard** — clicks, drag & drop, scrolling, right-click, shortcuts, Vietnamese text and emoji.
- **Mobile-first UI** — touch gestures, on-screen keyboard, pinch-to-zoom.
- **Landscape fullscreen mode** — one tap locks the view sideways and fills the screen.
- **Bandwidth friendly** — unchanged frames are dropped; ffmpeg idles out 15 s after the last viewer leaves.
- **Password protected** — `HttpOnly` session cookie, brute-force throttling.
- **Zero build step** — pure Node.js, no native compilation (`koffi` ships prebuilt FFI bindings).

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
git clone https://github.com/ThanhNhanDang/webgate.git
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

| Gesture | Action |
| --- | --- |
| Tap | Left click |
| Double tap | Double click |
| **Long press 1 s** | Right click (haptic feedback) |
| Drag one finger | Hold left button + move (drag & drop) |
| Drag two fingers | Scroll |
| Pinch two fingers | Zoom the view locally |
| ⤢ | Reset zoom to fit |
| ⛶ | **Landscape fullscreen** — toolbar hides after 2.6 s, tap to bring it back |
| 🖱️ | Next tap = right click |
| ⌨️ | Keyboard: clipboard text, arrows, shortcuts |
| ⚙️ | FPS / resolution / JPEG quality, logout |

**Typing text** — open ⌨️, type or paste into the box, press *Send*. The whole string is pasted at once, so Vietnamese diacritics, emoji and multi-line text work correctly.

**Shortcuts** — toggle `Ctrl` (or Alt / Shift / Win), then press the key. `Ctrl` + `c` = Ctrl+C.

---

## Configuration

All settings are environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `6090` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` = local only) |
| `GATE_PASS` | from `.pass` | Password (overrides the file) |
| `FPS` | `15` | Frames per second (2–30) |
| `WIDTH` | `1280` | Stream width in px, aspect ratio preserved |
| `QUALITY` | `8` | JPEG quality, **lower = sharper** (2–25) |
| `FFMPEG` | `ffmpeg` | Path to the ffmpeg binary |

Low-bandwidth example:

```powershell
$env:FPS=8; $env:WIDTH=1024; $env:QUALITY=14; node server.js
```

Quality can also be changed live from the ⚙️ panel (applies to every connected viewer).

---

## Architecture

```
Phone (canvas)  ──wss──►  Node server  ──pipe──►  ffmpeg gdigrab
       │                       │
       └──── JSON input ───────┴──► user32.dll (SetCursorPos / mouse_event / keybd_event)
```

| Path | Responsibility |
| --- | --- |
| `server.js` | HTTP, static files, auth, WebSocket broadcast, input dispatch |
| `lib/capture.js` | Spawns ffmpeg, parses the MJPEG pipe, drops identical frames |
| `lib/input.js` | Injects mouse/keyboard via `user32.dll` through `koffi` |
| `public/` | Mobile-first client (vanilla JS, no framework) |

One ffmpeg pipeline is shared by every viewer. The process declares itself DPI-aware so coordinates line up on scaled displays (125 % / 150 %).

---

## Security

This grants **full control of your machine**. Treat it accordingly.

- Password login with `HttpOnly` cookie; 5 failed attempts lock the IP for 30 s.
- **No HTTPS.** Password and screen data travel in clear text on the LAN — anyone sniffing the Wi-Fi sees everything. Use trusted networks only.
- **Never expose this port to the Internet** (port forwarding). For remote access use a VPN (Tailscale, WireGuard, …) and reach it over the VPN address.
- The server runs with your user privileges: it **cannot** drive windows running as Administrator (UAC prompts included).
- Screen content is untrusted input. If an AI agent is watching the same desktop, on-screen text can be used for prompt injection.

---

## Known limitations

- **Ctrl+Alt+Del** cannot be sent (Windows blocks synthetic Secure Attention Sequence).
- Typing text uses the clipboard, so pressing *Send* **overwrites your current clipboard**.
- Primary monitor only — multi-monitor is not supported yet.
- No audio, no file transfer, no two-way clipboard sync.
- GPU-drawn surfaces (games, exclusive fullscreen video) may capture as black with `gdigrab`.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Black screen | ffmpeg failed — check the console, test `ffmpeg -f gdigrab -i desktop -t 1 test.jpg` |
| Phone can't connect | different Wi-Fi, firewall blocked, or `HOST=127.0.0.1` |
| Choppy / laggy | lower `FPS`, higher `QUALITY` number, lower `WIDTH` |
| Clicks land in the wrong place | display scaling or multi-monitor setup |
| Clicks do nothing | target app runs as Administrator |
| `EADDRINUSE` on start | another instance is already listening on the port |

---

## License

[MIT](LICENSE)
