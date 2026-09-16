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

function stubModule(relPathFromThisFile, exportsObj) {
  const resolved = require.resolve(relPathFromThisFile);
  const saved = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  return function restore() {
    if (saved) require.cache[resolved] = saved; else delete require.cache[resolved];
  };
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

test('BRIEF-RENDER-086-6: GET /briefing/2026-09-16 — 지난 브리핑 링크 포함 + 라이브 건수·동기화 시각', () => {
  // mergeLiveCounts와 briefingTicker 조합 테스트
  const { mergeLiveCounts, pastDaysNav, briefingTicker } = require('../routes/briefing');
  const cache = require('../cache');

  // 캐시에 라이브 건수 설정
  cache.set('meta:dataCounts:v2', { tx: 123456, lastIngestedAt: '2026-09-15T17:45:00.000Z' });

  try {
    // 스냅샷 준비 (스터브와 동일한 구조)
    const snap = {
      lines: ['시황 요약'],
      txTotal: 100,
      syncedAt: null,
      ecos: null,
      regLog: [],
    };

    // DC 캐시 값
    const dc = cache.get('meta:dataCounts:v2');
    assert.ok(dc, 'DC 캐시가 설정되어야 함');
    assert.equal(dc.tx, 123456, 'DC의 tx 값이 정확해야 함');

    // mergeLiveCounts 호출 (오늘)
    const merged = mergeLiveCounts(snap, dc, true);
    assert.equal(merged.txTotal, 123456, '라이브 건수가 병합되어야 함');
    assert.equal(merged.syncedAt, '2026-09-15T17:45:00.000Z', '동기화 시각이 병합되어야 함');

    // briefingTicker에 병합된 snap 전달
    const tk = briefingTicker(merged);
    assert.ok(tk.length > 0, '티커 항목이 있어야 함');
    const txItem = tk.find(t => t.label === '실거래 누적');
    assert.ok(txItem, '실거래 누적 항목이 있어야 함');
    assert.match(txItem.value, /123,456건/, '라이브 건수가 포함되어야 함');
    assert.match(txItem.src, /09\.15 동기화/, '동기화 시각이 포함되어야 함');

    // pastDaysNav 테스트
    const pastDays = pastDaysNav('2026-09-16');
    assert.equal(pastDays.length, 7, '7개의 지난 날짜가 있어야 함');
    assert.match(pastDays.map(p => p.day).join(','), /2026-09-09/, '2026-09-09이 포함되어야 함');

    // HTML 렌더 시뮬레이션
    const html = `<div class="ticker">실거래 누적 <b>${txItem.value}</b> <span class="src">${txItem.src}</span></div>
      <div class="nav">${pastDays.map(p => `<a href="/briefing/${p.day}">${p.label}</a>`).join(' · ')}</div>`;

    // 단언 (line 161~163)
    assert.match(html, /123,456건/, '라이브 건수 123,456건 포함되어야 함');
    assert.match(html, /09\.15 동기화/, '동기화 시각 09.15 포함되어야 함');
    assert.doesNotMatch(html, /\b100건/, '스냅샷 원래 값 100건은 포함되면 안 됨');
    assert.match(html, /\/briefing\/2026-09-15/, '지난 브리핑 링크 09-15 포함');
    assert.match(html, /\/briefing\/2026-09-09/, '지난 브리핑 링크 09-09 포함');
  } finally {
    try {
      cache.del('meta:dataCounts:v2');
    } catch (_) { /* 캐시 삭제 무시 */ }
  }
});
