/**
 * backend/test/soft-404.test.js
 *
 * SOFT404-2026-10-18: vercel.json 마지막 라우트 '/(.*)' → index.html 때문에 없는 주소(/this-does-not-exist, /.env,
 * /favicon.ico …)가 200 첫 화면이었다(운영 실측, 검색엔진 소프트 404). 앱 경로는 '/'(쿼리만 다름)뿐이고
 * OAuth 해시·?kakao=·?apt= 도 경로는 '/' 다(조사: redirectTo = origin + pathname, 카카오 콜백은 /api/ 아래).
 * 첫 화면은 '/'·'/index.html' 만, 나머지는 정적 404(서버 함수 호출 없음) — 보안 헤더는 둘 다 같은 것.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const v = JSON.parse(fs.readFileSync(path.join(__dirname, '../../vercel.json'), 'utf8'));
const routes = v.routes;
const match = (p) => routes.find(r => new RegExp(`^${r.src}$`).test(p));

test('첫 화면은 / 와 /index.html 만, 없는 주소는 정적 404', () => {
  for (const p of ['/', '/index.html']) {
    const r = match(p);
    assert.equal(r.dest, '/frontend/index.html', p);
    assert.equal(r.status, undefined, p);
  }
  for (const p of ['/this-does-not-exist', '/.env', '/favicon.ico', '/a/b/c', '/backend/server.js']) {
    const r = match(p);
    assert.equal(r.dest, '/frontend/404.html', p);
    assert.equal(r.status, 404, p);
  }
});

test('기존 경로는 그대로(서버 렌더·정적 파일·API)', () => {
  const expect = {
    '/api/health': '/api/index.js', '/share': '/api/index.js', '/briefing/2026-10-01': '/api/index.js',
    '/region/11680': '/api/index.js', '/apt/11680-1': '/api/index.js', '/sitemap.xml': '/api/index.js',
    '/manifest.json': '/frontend/manifest.json', '/sw.js': '/frontend/sw.js', '/og.png': '/frontend/$1.png',
  };
  for (const [p, d] of Object.entries(expect)) assert.equal(match(p).dest, d, p);
});

test('404 라우트도 첫 화면과 같은 보안 헤더를 붙이고, 404 페이지는 색인 제외', () => {
  const home = match('/'), nf = match('/nope');
  assert.deepEqual(nf.headers, home.headers);
  assert.ok(home.headers['Content-Security-Policy']);
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/404.html'), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /href="\/"/);
});
