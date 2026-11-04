'use strict';
/* Kiểm thử end-to-end: login -> WS -> nhận frame -> gửi input */
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://127.0.0.1:6090';
const PASS = process.env.GATE_PASS || 'test1234';

(async () => {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pass: PASS }),
  });
  const cookie = (r.headers.getSetCookie?.() || [r.headers.get('set-cookie')])[0].split(';')[0];
  console.log('login', r.status, cookie.slice(0, 12) + '…');

  const info = await fetch(`${BASE}/api/info`, { headers: { cookie } }).then((x) => x.json());
  console.log('info', JSON.stringify(info));

  const bad = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pass: 'wrong' }),
  });
  console.log('sai mật khẩu ->', bad.status);

  const ws = new WebSocket(`ws://127.0.0.1:6090/ws`, { headers: { cookie } });
  let n = 0, bytes = 0, first = 0;

  ws.on('open', () => console.log('ws open'));
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const m = JSON.parse(data.toString());
      if (m.t !== 'pong') console.log('ctrl', JSON.stringify(m));
      return;
    }
    if (!first) {
      first = data.length;
      // đọc kích thước JPEG từ marker SOF
      let i = 2;
      while (i < data.length) {
        if (data[i] !== 0xff) { i++; continue; }
        const marker = data[i + 1];
        const len = data.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf) {
          console.log(`frame đầu: ${data.length} bytes, ${data.readUInt16BE(i + 7)}x${data.readUInt16BE(i + 5)}`);
          break;
        }
        i += 2 + len;
      }
    }
    n++; bytes += data.length;
  });

  ws.on('close', (c) => console.log('ws closed', c));

  setTimeout(() => {
    console.log(`nhận ${n} frame / 3s, tổng ${(bytes / 1024).toFixed(0)} KB`);
    ws.send(JSON.stringify({ t: 'm', x: 0.5, y: 0.5 }));
    ws.send(JSON.stringify({ t: 'k', keys: ['SHIFT'] }));
    ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
    setTimeout(() => {
      const after = (bytes / 1024).toFixed(0);
      console.log('đã gửi input, không crash. KB:', after);
      ws.close();
      process.exit(0);
    }, 500);
  }, 3000);
})();
