// 미리보기 전용: 화면 파일은 작업 폴더에서, /api 와 서버 렌더 경로는 운영으로 넘긴다(읽기 확인용. 쓰기 요청은 막는다).
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2];
const PORT = Number(process.argv[3] || 4179);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/_vercel/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(204); return res.end(); }
    const pr = https.request({ host: 'myhomelog.vercel.app', path: req.url, method: req.method, headers: { 'user-agent': 'Mozilla/5.0 local-preview', accept: req.headers.accept || '*/*' } }, (r) => {
      const h = { ...r.headers }; delete h['content-security-policy']; delete h['strict-transport-security'];
      res.writeHead(r.statusCode, h); r.pipe(res);
    });
    pr.on('error', () => { try { if (!res.headersSent) res.writeHead(502); res.end(); } catch (_) {} });
    return pr.end();
  }
  let f = u.pathname === '/' ? '/index.html' : u.pathname;
  const file = path.join(ROOT, 'frontend', path.normalize(f).replace(/^([/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'frontend'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log('preview on ' + PORT));
