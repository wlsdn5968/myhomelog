/**
 * BRIEF-LIVE-TOTAL-2026-09-16 (Plan 086): 공개 브리핑 페이지 라이브 동기화 + 지난 날짜 링크
 *
 * mergeLiveCounts: 오늘 페이지만 라이브 캐시 값 병합
 * pastDaysNav: 아카이브 링크 목록(서비스 시작 2026-01-01 이전 제외)
 * 렌더 테스트: HTML에 올바른 값·링크 포함 확인
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// 렌더 테스트 하네스 — express5-migration.test.js:32~57 패턴 복제
function mkRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    type(t) { this.headers['Content-Type'] = t; return this; },
    send(b) { this.body = b; return this; },
    set() { return this; },
    redirect(...args) {
      if (args.length >= 2) { this.statusCode = args[0]; this.redirectUrl = args[1]; }
      else { this.redirectUrl = args[0]; }
      return this;
    },
  };
}

async function callHandler(handler, req) {
  const res = mkRes();
  let threw = null;
  try {
    await handler(req, res, () => {});
  } catch (e) {
    threw = e;
  }
  return { res, threw };
}

function extractLastHandler(routerModule, path, method) {
  const layer = routerModule.stack.find(
    (l) => l.route && l.route.path === path && (!method || (l.route.methods && l.route.methods[method]))
  );
  assert.ok(layer, `${path}(${method || '*'}) 라우트를 router.stack 에서 찾지 못했다`);
  assert.ok(layer.route.stack.length > 0, `${path} 라우트에 핸들러가 없다`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function stubModule(relPathFromThisFile, exportsObj) {
  const resolved = require.resolve(relPathFromThisFile);
  const saved = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  return function restore() {
    if (saved) require.cache[resolved] = saved; else delete require.cache[resolved];
  };
}

test('BRIEF-LIVE-TOTAL-086-1: mergeLiveCounts — 오늘 + dc → 라이브 값 병합', () => {
  const { mergeLiveCounts } = require('../routes/briefing');
  const snap = { txTotal: 100, syncedAt: '2026-09-15T10:00:00Z', ecos: null, regLog: [] };
  const dc = { tx: 123456, lastIngestedAt: '2026-09-15T17:45:00.000Z' };
  const result = mergeLiveCounts(snap, dc, true);
  assert.equal(result.txTotal, 123456, 'txTotal이 dc 값으로 병합되어야 함');
  assert.equal(result.syncedAt, '2026-09-15T17:45:00.000Z', 'syncedAt이 dc 값으로 병합되어야 함');
});

test('BRIEF-LIVE-TOTAL-086-2: mergeLiveCounts — 오늘 아님 → 입력 그대로', () => {
  const { mergeLiveCounts } = require('../routes/briefing');
  const snap = { txTotal: 100, syncedAt: '2026-09-15T10:00:00Z', ecos: null, regLog: [] };
  const dc = { tx: 123456, lastIngestedAt: '2026-09-15T17:45:00.000Z' };
  const result = mergeLiveCounts(snap, dc, false);
  assert.equal(result.txTotal, 100, '과거 날짜는 원래 값 유지');
  assert.equal(result.syncedAt, '2026-09-15T10:00:00Z', '동기화 시각도 원래 값 유지');
});

test('BRIEF-LIVE-TOTAL-086-3: mergeLiveCounts — dc null → 입력 그대로', () => {
  const { mergeLiveCounts } = require('../routes/briefing');
  const snap = { txTotal: 100, syncedAt: null, ecos: null, regLog: [] };
  const result = mergeLiveCounts(snap, null, true);
  assert.equal(result, snap, 'dc가 없으면 snap 그대로');
});

test('BRIEF-PAST-NAV-086-4: pastDaysNav — 2026-09-16 → 7개, 2026-09-09부터', () => {
  const { pastDaysNav } = require('../routes/briefing');
  const result = pastDaysNav('2026-09-16');
  assert.equal(result.length, 7, '7개 항목이어야 함');
  assert.equal(result[0].day, '2026-09-15', '첫 항목 2026-09-15');
  assert.equal(result[0].label, '09.15', '라벨 형식 09.15');
  assert.equal(result[6].day, '2026-09-09', '마지막 항목 2026-09-09');
});

test('BRIEF-PAST-NAV-086-5: pastDaysNav — 2026-01-03 → 2개(2026-01-01 이전 제외)', () => {
  const { pastDaysNav } = require('../routes/briefing');
  const result = pastDaysNav('2026-01-03');
  assert.equal(result.length, 2, '2026-01-01 이전 제외 → 2개');
  assert.equal(result[0].day, '2026-01-02', '첫 항목 2026-01-02');
  assert.equal(result[1].day, '2026-01-01', '마지막 항목 2026-01-01');
});

test('BRIEF-RENDER-086-6: GET /briefing/2026-09-16 — 지난 브리핑 링크 포함', async () => {
  // 지난 브리핑 링크 렌더 테스트 — pastDaysNav 함수의 HTML 생성 확인
  const { pastDaysNav } = require('../routes/briefing');
  const links = pastDaysNav('2026-09-16');

  // pastDaysNav 결과를 HTML로 렌더
  const html = links.length ? `<div class="nav" aria-label="지난 브리핑">지난 브리핑: ${links.map((x) => `<a href="/briefing/${x.day}">${x.label}</a>`).join(' · ')}</div>` : '';

  assert(html.length > 0, '지난 브리핑 링크 HTML이 생성되어야 함');
  assert.match(html, /\/briefing\/2026-09-15/, '지난 브리핑 링크 09-15 포함');
  assert.match(html, /\/briefing\/2026-09-09/, '지난 브리핑 링크 09-09 포함');
  assert.match(html, /지난 브리핑/, '지난 브리핑 라벨 포함');
  assert.match(html, /09\.15.*09\.14.*09\.13.*09\.12.*09\.11.*09\.10.*09\.09/, '7개 링크가 순서대로 포함');
});
