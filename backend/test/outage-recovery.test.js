/**
 * backend/test/outage-recovery.test.js
 *
 * Plan 160 — 일시 장애가 지나간 뒤 화면이 스스로 회복된다.
 *   ① 인기 12곳 요청은 목록 패널과 지도 마커가 공유한다(진행 중·60초) — 실패하면 다음 호출이 다시 부른다.
 *   ② 대체 응답(degraded)을 붙잡지 않는다: 60초 뒤 다음 호출에서 재조회 + 다시 불러오기 버튼.
 *   ③ 서버 연결 확인은 실패 상태에서 60초마다 다시 돌고 성공하면 멈춘다.
 *   ④ 랭킹 카드는 저장된 순위가 대체 경로면 한 번 다시 불러온다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

function extractFn(src, name) {
  const m = src.match(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(m, `${name} 함수를 찾지 못했다`);
  const start = m.index;
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 의 닫는 중괄호를 찾지 못했다`);
}

test('Plan 160 ① _popular12 — 연속 호출은 요청 1회, 실패 뒤에는 다시 부른다', async () => {
  let calls = 0;
  let mode = 'ok';
  const ctx = {
    CFG: { api: '' },
    AbortSignal: { timeout: () => undefined },
    Date,
    Promise,
    fetch: () => {
      calls++;
      return mode === 'ok'
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) })
        : Promise.reject(new Error('down'));
    },
  };
  vm.createContext(ctx);
  vm.runInContext(['let _pop12P = null, _pop12At = 0;', extractFn(html, '_popular12'), 'globalThis.__p = _popular12;'].join('\n'), ctx);
  const a = ctx.__p();
  const b = ctx.__p();
  await Promise.all([a, b]);
  assert.equal(calls, 1, '연속 두 번 호출은 fetch 1회');

  // 실패 → 다음 호출이 다시 부른다
  vm.runInContext('_pop12P = null; _pop12At = 0;', ctx);
  mode = 'fail';
  await assert.rejects(ctx.__p());
  const before = calls;
  mode = 'ok';
  await ctx.__p();
  assert.equal(calls, before + 1, '거절 뒤 다음 호출은 fetch 다시');
});

test('Plan 160 ② _hpLoad 는 오래된 대체 응답을 다시 부르고, 대체 문구에 다시 불러오기 버튼이 있다', () => {
  const src = extractFn(html, '_hpLoad');
  assert.ok(src.includes('_degOld'), '_degOld 조건');
  assert.ok(/_hpData\.degraded && Date\.now\(\) - _hpDataAt > 60000/.test(src));
  assert.ok(/_hpReq = _popular12\(force\)/.test(src), '공용 요청 사용');
  const deg = html.match(/const degMsg = [^\n]*/);
  assert.ok(deg, 'degMsg');
  assert.ok(deg[0].includes('onclick="_hpLoad(true)"') && deg[0].includes('다시 불러오기'));
});

test('Plan 160 ③ chkAPI — 실패 분기에 60초 재확인 타이머, 성공 분기에서 해제', () => {
  const src = extractFn(html, 'chkAPI');
  const failIdx = src.indexOf("el.textContent='서버에 연결되지 않아요'");
  assert.ok(failIdx > 0);
  const failPart = src.slice(failIdx);
  const okPart = src.slice(0, failIdx);
  assert.ok(failPart.includes('setInterval(') && failPart.includes('_apiRecheckT'));
  assert.ok(okPart.includes('clearInterval(window._apiRecheckT)'));
});

test('Plan 160 ④ openRankCard — 저장된 순위가 대체 경로면 다시 불러온다', () => {
  const src = extractFn(html, 'openRankCard');
  const m = src.match(/if\(!ps\|\|!ps\.length[^\n]*\{/);
  assert.ok(m, '첫 조건');
  assert.ok(m[0].includes('_degraded'));
  assert.equal((src.match(/_lastPopular\s*=\s*ps/g) || []).length, 1);
});

test('Plan 160 ⑤ 인기 12곳 요청 리터럴은 공용 함수 한 곳뿐', () => {
  assert.equal(html.split('search/popular?limit=12').length - 1, 1);
});
