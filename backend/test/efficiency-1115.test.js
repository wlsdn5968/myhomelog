/**
 * backend/test/efficiency-1115.test.js
 *
 * 2026-11-15 정기 점검의 부하 정리(운영자 지시: 서비스와 사용자 기기에 과부하가 걸리지 않게).
 *   A11Y-ONE-OBSERVER  화면의 body 전체 감시를 하나로(변화가 멎은 뒤 한 번)
 *   REGPOP-SHARE       구별 순위 요청을 세 곳이 나눠 씀
 *   NIW-CAP            지도 말풍선 최근 거래 기억에 상한
 *   PUSH-BUDGET        푸시 알림 작업 전체 시간 상한
 *   MAP-CAP            서버 계수 Map 이 5000 을 넘으면 4000 까지 줄임
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const html = read('../../frontend/index.html');

test('화면: body 전체를 보는 MutationObserver 는 하나뿐이고, 변화가 멎은 뒤 두 보정 함수를 함께 부른다', () => {
  const bodyObs = html.match(/\.observe\(document\.body,\s*\{\s*childList:\s*true,\s*subtree:\s*true\s*\}\)/g) || [];
  assert.equal(bodyObs.length, 1);
  assert.match(html, /new MutationObserver\(\(\) => clearTimeout\(window\._a11yT\) \|\| \(window\._a11yT = setTimeout\(\(\) => \{ _enhanceA11y\(\); try\{ _a11yEnhance\(document\); \}catch\(_\)\{\} \}, 200\)\)\);/);
  // 처음 한 번은 바로 보정한다(감시가 붙기 전의 요소)
  assert.match(html, /const start = \(\) => \{\r?\n\s*_a11yEnhance\(document\);/);
});

test('화면: 구별 순위는 _regPopJson 한 곳에서만 요청하고 같은 시도의 진행 중 요청을 나눠 쓴다', async () => {
  assert.equal((html.match(/search\/popular-region\?sido=/g) || []).length, 1, '요청 주소는 한 곳');
  assert.equal((html.match(/_regPopJson\(/g) || []).length, 4, '정의 1 + 사용 3(첫 화면, 지도 패널, 단지 상세)');
  const src = html.slice(html.indexOf('function _regPopJson('), html.indexOf('async function _loadLandingRegions('));
  const calls = [];
  const sandbox = {
    window: {}, CFG: { api: '/api' }, AbortSignal: { timeout: () => null }, Promise, Array, Error,
    fetch: (u) => { calls.push(u); return new Promise((res) => setTimeout(() => res({ ok: true, json: async () => ({ groups: calls.length === 3 ? [] : [{ lawdCd: '11680' }] }) }), 5)); },
  };
  const fn = new Function(...Object.keys(sandbox), `${src}; return _regPopJson;`)(...Object.values(sandbox));
  const [a, b] = await Promise.all([fn('11'), fn('11')]);
  assert.equal(calls.length, 1, '동시에 두 번 불러도 요청은 한 번');
  assert.equal(a, b);
  await fn('11');
  assert.equal(calls.length, 1, '받은 뒤에는 다시 묻지 않는다');
  await fn('41');
  assert.equal(calls.length, 2, '다른 시도는 따로');
  const empty = await fn('26');
  assert.deepEqual(empty.groups, []);
  await fn('26');
  assert.equal(calls.length, 4, '빈 응답은 기억하지 않고 다음에 다시 묻는다');
});

test('화면: 지도 말풍선 최근 거래 기억은 200개를 넘으면 오래된 것부터 버린다', () => {
  assert.match(html, /_niwRcCache\.set\(key, items\); if\(_niwRcCache\.size > 200\) _niwRcCache\.delete\(_niwRcCache\.keys\(\)\.next\(\)\.value\);/);
});

test('서버: 푸시 알림 작업은 전체 시간 상한을 넘으면 남은 구독을 다음 회차로 넘긴다', () => {
  const src = read('../jobs/pushNotify.js');
  assert.equal(require('../jobs/pushNotify').SEND_BUDGET_MS, 240000);
  // 처리 표시보다 먼저 확인해야 넘긴 구독이 다음 회차에 다시 잡힌다
  assert.match(src, /for \(const s of push\.rows\) \{\r?\n\s*if \(overBudget\(\)\) break;\r?\n\s*pushProcessed\.push\(s\.id\);/);
  assert.match(src, /for \(const t of kakao\.rows\) \{\r?\n\s*if \(overBudget\(\)\) break;\r?\n\s*kakaoProcessed\.push\(t\.user_id\);/);
  assert.match(src, /txScanned: rows\.length, budgetHit,/);
  assert.equal(require('../services/cronStats')._pick({ budgetHit: true }).budgetHit, true, '실행 기록에 남는다');
});

test('서버: 인증 실패 계수 Map 은 창 안의 새 IP 가 5000 을 넘어도 4000 으로 줄어든다', () => {
  const auth = require('../middleware/auth');
  auth._authFail.clear();
  for (let i = 0; i < 5200; i++) auth._authFailed({ ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` });
  assert.ok(auth._authFail.size <= 5000, `size ${auth._authFail.size}`);
  assert.ok(auth._authFail.size >= 4000);
  // 가장 최근 IP 의 계수는 남아 있다
  assert.ok(auth._authFail.has(require('../utils/ipKey').normalizeIpKey('10.0.20.79')));
  auth._authFail.clear();
  const acc = read('../routes/account.js');
  assert.equal((acc.match(/\.size <= 4000\) break;/g) || []).length, 2);
});
