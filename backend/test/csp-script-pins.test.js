/**
 * CSP-NARROW-2026-10-30 (보안 점검 U15): jsDelivr·unpkg 는 아무 npm 패키지나 내주므로 CSP script-src 에
 * 호스트 전체가 아니라 화면이 실제로 불러오는 파일 주소만 둔다. 버전을 올리면 index.html·vercel.json·server.js
 * 세 곳이 같이 바뀌어야 한다 — 하나라도 어긋나면 운영에서 스크립트가 막힌다(이 테스트가 먼저 잡는다).
 * 결제 페이지(billing)는 운영자 결정으로 제외(보고 전용 CSP, 다른 버전).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8');

// 화면이 동적으로 붙이는 두 CDN 스크립트 주소
const used = [...html.matchAll(/\.src\s*=\s*'(https:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com)\/[^']+)'/g)].map(m => m[1]);

function scriptSrc(csp) {
  const d = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src '));
  return d ? d.split(/\s+/).slice(1) : [];
}

test('index.html 이 jsDelivr·unpkg 에서 불러오는 스크립트는 2개(supabase-js·leaflet)', () => {
  assert.equal(used.length, 2, used.join(', '));
  assert.ok(used.some(u => u.includes('@supabase/supabase-js@')));
  assert.ok(used.some(u => u.includes('leaflet@')));
});

test('vercel.json: CSP 가 있는 일반 페이지는 두 파일 주소만 허용하고 호스트 전체는 허용하지 않는다', () => {
  let checked = 0;
  for (const r of vercel.routes) {
    const csp = r.headers && r.headers['Content-Security-Policy'];
    if (!csp) continue;
    const toks = scriptSrc(csp);
    assert.ok(!toks.includes('https://cdn.jsdelivr.net'), r.src);
    assert.ok(!toks.includes('https://unpkg.com'), r.src);
    for (const u of used) assert.ok(toks.includes(u), `${r.src} 에 ${u} 없음`);
    checked += 1;
  }
  assert.equal(checked, 5); // privacy·terms·refund·index·404
});

test('server.js helmet scriptSrc 도 같은 두 주소만', () => {
  const block = server.slice(server.indexOf('scriptSrc: ['), server.indexOf(']', server.indexOf('scriptSrc: [')));
  assert.doesNotMatch(block, /'https:\/\/cdn\.jsdelivr\.net',/);
  assert.doesNotMatch(block, /'https:\/\/unpkg\.com',/);
  for (const u of used) assert.ok(block.includes(`'${u}'`), u);
});

test('정적 파일 경로에 nosniff', () => {
  for (const src of ['/robots\\.txt', '/manifest\\.json', '/sw\\.js', '/(icon-192|icon-512|icon-512-maskable|og)\\.png', '/geo/sgg-(\\d{2})\\.json']) {
    const r = vercel.routes.find(x => x.src === src);
    assert.ok(r, src);
    assert.equal(r.headers['X-Content-Type-Options'], 'nosniff', src);
  }
});
