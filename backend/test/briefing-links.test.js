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

test('BRIEF-RENDER-086-6: GET /briefing/2026-09-16 — 렌더된 HTML에 라이브 건수·동기화 시각 포함', async () => {
  // 핸들러 호출 후 **응답 HTML** 검증 (함수 반환값 아님)
  const cache = require('../cache');

  // 캐시에 라이브 건수 설정
  cache.set('meta:dataCounts:v2', { tx: 123456, lastIngestedAt: '2026-09-15T17:45:00.000Z' });

  let restoreBriefingService, restoreLogger;
  try {
    // briefingService.kstDayString() → '2026-09-16' 고정
    // briefingService.getOrCreateSnapshot(day) → 스냅샷 반환
    restoreBriefingService = stubModule(
      '../services/briefingService',
      {
        kstDayString() { return '2026-09-16'; },
        async getOrCreateSnapshot(day) {
          if (day === '2026-09-16') {
            return {
              lines: ['시황 요약'],
              txTotal: 100,         // 스냅샷 원래 값
              syncedAt: null,        // 스냅샷에는 동기화 정보 없음
              ecos: null,
              regLog: [],
            };
          }
          return null;
        },
      }
    );

    // logger (warn 호출 무시)
    restoreLogger = stubModule('../logger', { warn() {} });

    // 라우터 재로드
    delete require.cache[require.resolve('../routes/briefing')];
    const briefingRouter = require('../routes/briefing');
    const handler = extractLastHandler(briefingRouter, '/:date', 'get');

    // 모의 요청/응답
    const req = { params: { date: '2026-09-16' } };
    const res = mkRes();

    // 핸들러 호출
    await handler(req, res);

    // 응답 HTML 검증
    assert.equal(res.statusCode, 200, '상태 코드 200');
    assert.ok(res.body, '응답 본문 있음');
    assert.match(res.body, /123,456건/, 'HTML에 라이브 건수 123,456건 포함되어야 함');
    assert.match(res.body, /09\.15 동기화/, 'HTML에 동기화 시각 09.15 포함되어야 함');
    assert.doesNotMatch(res.body, /\b100건/, 'HTML에 스냅샷 원래 값 100건은 포함되면 안 됨 (라이브로 덮어씌워짐)');
    assert.match(res.body, /\/briefing\/2026-09-09/, 'HTML에 지난 브리핑 링크 09-09 포함');
  } finally {
    try { cache.del('meta:dataCounts:v2'); } catch (_) { /* 캐시 삭제 무시 */ }
    if (restoreBriefingService) restoreBriefingService();
    if (restoreLogger) restoreLogger();
  }
});
