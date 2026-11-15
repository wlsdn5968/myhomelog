// 미리보기 전용: 화면 파일은 작업 폴더에서, /api 와 서버 렌더 경로는 운영으로 넘긴다(읽기 확인용. 쓰기 요청은 막는다).
// PREVIEW-CACHE-1115: 운영으로 넘긴 GET 응답을 잠시 기억한다.
//   미리보기를 새로 고칠 때마다 운영 함수가 다시 돌았다(11-15 실측: 50분 동안 미리보기 요청 26건이 운영 CPU 약 1.1초).
//   Vercel Hobby 는 Active CPU 를 30일 합계로 제한하므로, 같은 주소는 PREVIEW_CACHE_SEC(기본 600초) 동안 운영에 다시 묻지 않는다.
//   운영 값을 방금 것으로 다시 받아야 하면 주소에 _fresh=1 을 붙이거나 PREVIEW_CACHE_SEC=0 으로 띄운다.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2];
const PORT = Number(process.argv[3] || 4179);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain' };
const CACHE_MS = Math.max(0, Number(process.env.PREVIEW_CACHE_SEC || 600)) * 1000;
const CACHE_MAX = 300;                 // 주소 수 상한
const CACHE_BODY_MAX = 2 * 1024 * 1024; // 한 응답 2MB 까지만 기억
const cache = new Map();               // 주소 -> { at, status, headers, body }
const stats = { hit: 0, miss: 0 };

function cacheGet(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() - c.at > CACHE_MS) { cache.delete(key); return null; }
  return c;
}
function cachePut(key, status, headers, body) {
  if (!CACHE_MS || status !== 200 || body.length > CACHE_BODY_MAX) return;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), status, headers, body });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__preview_cache') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ...stats, size: cache.size, ttlSec: CACHE_MS / 1000 }));
  }
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/_vercel/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(204); return res.end(); }
    const fresh = u.searchParams.has('_fresh');
    const key = req.method + ' ' + req.url;
    const hit = !fresh && req.method === 'GET' ? cacheGet(key) : null;
    if (hit) {
      stats.hit += 1;
      res.writeHead(hit.status, { ...hit.headers, 'x-preview-cache': 'hit' });
      return res.end(hit.body);
    }
    stats.miss += 1;
    const pr = https.request({ host: 'myhomelog.vercel.app', path: req.url, method: req.method, headers: { 'user-agent': 'Mozilla/5.0 local-preview', accept: req.headers.accept || '*/*' } }, (r) => {
      const h = { ...r.headers }; delete h['content-security-policy']; delete h['strict-transport-security'];
      res.writeHead(r.statusCode, { ...h, 'x-preview-cache': 'miss' });
      const chunks = []; let size = 0;
      r.on('data', (c) => { size += c.length; if (size <= CACHE_BODY_MAX) chunks.push(c); res.write(c); });
      r.on('end', () => { res.end(); if (req.method === 'GET' && size <= CACHE_BODY_MAX) cachePut(key, r.statusCode, h, Buffer.concat(chunks)); });
      r.on('error', () => { try { res.end(); } catch (_) {} });
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
});
if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log('preview on ' + PORT));
module.exports = { cacheGet, cachePut, cache, CACHE_MS };
