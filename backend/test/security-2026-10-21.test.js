/**
 * backend/test/security-2026-10-21.test.js — 2026-10-21 보안 점검 후속(M1·M2·L2·L3·L5·화면 이스케이프)이 되돌아가지 않게 고정한다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

test('M1 푸시 구독: 키 형식(base64url p256dh 87자·auth 22자)을 보고, 총수 상한은 새 endpoint 만 막는다', () => {
  const s = read('../routes/push.js');
  assert.match(s, /const B64U = \/\^\[A-Za-z0-9_-\]\+=\{0,2\}\$\/;/);
  assert.match(s, /p256dh\.replace\(\/=\+\$\/, ''\)\.length !== 87/);
  assert.match(s, /auth\.replace\(\/=\+\$\/, ''\)\.length !== 22/);
  assert.match(s, /const PUSH_SUB_CAP = 5000;/);
  // 실제 브라우저 값 모양(운영 구독 2건과 같은 길이)은 통과, 아무 문자열은 거절
  const B64U = /^[A-Za-z0-9_-]+={0,2}$/;
  const ok = (p, a) => B64U.test(p) && p.replace(/=+$/, '').length === 87 && B64U.test(a) && a.replace(/=+$/, '').length === 22;
  assert.equal(ok('B'.repeat(87), 'a'.repeat(22)), true);
  assert.equal(ok('x', 'x'), false);
  assert.equal(ok('B'.repeat(86) + '+', 'a'.repeat(22)), false, '표준 base64 문자(+)는 PushSubscription.toJSON 형식이 아니다');
});

test('L5 단지 검색: ILIKE 와일드카드(%·_·\\)를 빼고 나서 최소 길이를 본다', () => {
  const s = read('../routes/search.js');
  const i = s.indexOf("router.get('/apt', async (req, res) => {");
  const body = s.slice(i, i + 1200);
  assert.match(body, /const q = String\(req\.query\.q \|\| ''\)\.replace\(\/\[%_\\\\\]\/g, ''\)\.trim\(\);/);
  assert.ok(body.indexOf('.replace(/[%_\\\\]/g') < body.indexOf('if (q.length < 2)'), '제거가 길이 검사보다 먼저');
  const strip = (x) => String(x).replace(/[%_\\]/g, '').trim();
  assert.equal(strip('__'), ''); assert.equal(strip('%%'), ''); assert.equal(strip('은마'), '은마');
});

test('L3 /api/health/apis 키는 상수시간 비교 · L2 Permissions-Policy(서버·정적 응답)', () => {
  const s = read('../server.js');
  assert.match(s, /!require\('crypto'\)\.timingSafeEqual\(_pb, _eb\)/);
  assert.doesNotMatch(s, /provided !== expected/);
  assert.match(s, /res\.setHeader\('Permissions-Policy', 'camera=\(\), microphone=\(\), geolocation=\(\), usb=\(\)'\)/);
  const v = JSON.parse(read('../../vercel.json'));
  const idx = v.routes.find((r) => r.dest === '/frontend/index.html');
  assert.equal(idx.headers['Permissions-Policy'], 'camera=(), microphone=(), geolocation=(), usb=()');
});

test('M2 follow-redirects 는 취약 버전 1.16.0 이 아니다(백엔드·루트 잠금 파일)', () => {
  for (const f of ['../package-lock.json', '../../package-lock.json']) {
    const lock = JSON.parse(read(f));
    const fr = lock.packages && lock.packages['node_modules/follow-redirects'];
    assert.ok(fr, `${f} 에 follow-redirects 없음`);
    assert.notEqual(fr.version, '1.16.0', `${f} 가 취약 버전`);
  }
});

test('화면: 통근 목적지 이름은 이스케이프해서 넣는다', () => {
  const html = read('../../frontend/index.html');
  assert.match(html, /\$\{_escHtml\(tran\.destinationName\)\} 통근: 대중교통 추정/);
  assert.doesNotMatch(html, /\$\{tran\.destinationName\} 통근/);
});
