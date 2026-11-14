/**
 * AUDIT4-1114: 보안 점검 run-4(needs_validation 15건) 중 소스로 직접 확인되는 것을 고친 회귀 검사.
 * 근거 기록: C:/Users/Woo/security-audit-skill/myhomelog/run-4/NEEDS-VALIDATION.md
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('결제 410 차단은 대소문자 변형 경로(/CONFIRM, /Checkout, /payments/x/REFUND, /WEBHOOK)도 막는다', async () => {
  const prev = process.env.BILLING_ENABLED;
  delete process.env.BILLING_ENABLED;
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/billing', require('../routes/billing'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const post = (p) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    rq.on('error', reject); rq.end('{}');
  });
  try {
    for (const p of ['/api/billing/confirm', '/api/billing/CONFIRM', '/api/billing/Checkout', '/api/billing/payments/abc/REFUND', '/api/billing/WEBHOOK', '/api/billing/webhook']) {
      assert.equal(await post(p), 410, `${p} 가 410 이 아니다`);
    }
  } finally {
    server.close();
    if (prev === undefined) delete process.env.BILLING_ENABLED; else process.env.BILLING_ENABLED = prev;
  }
});

test('카카오 알림 items 는 적재하는 지역 코드만 남긴다', () => {
  const { _allowedItems } = require('../routes/kakao');
  const { isKnownLawdCd } = require('../services/transactionService');
  assert.match(fs.readFileSync(path.join(__dirname, '../routes/kakao.js'), 'utf8'), /const items = allowedItems\(req\.body\?\.items\);/, 'POST /items 가 허용 목록을 거치지 않는다');
  const out = _allowedItems([
    { aptName: '정상단지', lawdCd: '11350' },
    { aptName: '없는코드', lawdCd: '99999' },
    { aptName: '형식오류', lawdCd: '1135' },
  ]);
  assert.ok(isKnownLawdCd('11350'));
  assert.ok(!isKnownLawdCd('99999'));
  assert.deepEqual(out.map((x) => x.aptName), ['정상단지']);
});

test('푸시 cron 의 in 조회 목록은 적재 지역 코드로만 만든다', () => {
  const src = rd('jobs/pushNotify.js');
  assert.match(src, /isKnownLawdCd\(String\(c\)\)\)\)\]/, 'lawds 만들 때 허용 목록 검사가 없다');
  // 실제 함수로도 확인: 허용 목록 밖 코드는 빠진다
  const { isKnownLawdCd } = require('../services/transactionService');
  assert.equal(['11350', '99999'].filter((c) => isKnownLawdCd(c)).length, 1);
});

test('인기 단지 limit 은 1~30 으로 묶인다(음수 차단)', () => {
  const src = rd('routes/search.js');
  const i = src.indexOf("router.get('/popular'");
  assert.ok(i > 0);
  assert.match(src.slice(i, i + 800), /const limit = Math\.max\(1, Math\.min\(parseInt\(req\.query\.limit\) \|\| 12, 30\)\);/);
});

test('익명 동의 기록은 Redis 하루 계수기(IP별, 전체)를 거친 뒤에만 audit_log 에 쓴다', () => {
  const src = rd('routes/account.js');
  const i = src.indexOf("router.post('/consent'");
  const body = src.slice(i, src.indexOf("await writeAudit(req, 'consent.accept'", i));
  assert.match(body, /dl:consent:\$\{todayKey\(\)\}:\$\{ipK\}/);
  assert.match(body, /dl:consent-all:\$\{todayKey\(\)\}/);
  assert.match(body, /ipDay > CONSENT_IP_DAILY \|\| allDay > CONSENT_ALL_DAILY/);
});

test('공개 건축물대장 조회는 Kakao 관문을 넘기고, 관문에 막힌 결과는 없음으로 기억하지 않는다', () => {
  assert.match(rd('routes/properties.js'), /kakaoGate: require\('\.\/geocode'\)\.createKakaoGate\(1, req\)/);
  const svc = rd('services/buildingRegisterService.js');
  const g = svc.indexOf('if (kakaoGate && !(await kakaoGate()))');
  const b = svc.indexOf('const region = await resolveBjdong(rSgg, rUmd, ji.jibun);');
  assert.ok(g > 0 && b > g, '관문 검사가 Kakao 주소검색보다 앞에 있어야 한다');
  assert.match(svc, /if \(t == null && st\.gated\) return \{ _gated: true \};/);
  // 관문에 막힌 응답은 '없음'과 구별되고 화면은 별도 안내를 한다
  assert.match(rd('routes/properties.js'), /if \(title && title\._gated\) return res\.json\(\{ title: null, limited: true \}\);/);
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.match(html, /if \(!t && j && j\.limited\) \{/);
});

test('bump_activity_counter 실행 권한 회수가 마이그레이션 기록에 있다', () => {
  const dir = path.join(__dirname, '../../supabase/migrations');
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.match(all, /revoke execute on function public\.bump_activity_counter\(uuid, integer, text\) from public, anon, authenticated;/);
});
