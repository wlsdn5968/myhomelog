/**
 * backend/test/apt-history.test.js — Plan 102 (2026-09-20)
 *
 * 단지(apt_seq) 장기 월별 이력 서비스(backend/services/aptHistoryService.js)와
 * 라우트(GET /api/transactions/history) 테스트. DB/캐시는 require.cache 스텁으로 대체한다
 * (패턴: backend/test/popular-snapshot-shortfall.test.js 의 _withSnapshot,
 *  라우트는 backend/test/express5-migration.test.js:98~125 의 express 마운트 + fetch 방식).
 * 외부 API·프로덕션 DB 호출 없음 — 전부 스텁.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── require.cache 스텁 헬퍼 ──────────────────────────────────────────────
/** db/client·cache 를 목으로 바꿔치기하고 aptHistoryService 를 새로 로드해 fn 에 넘긴다. */
function _withAdmin(admin, cacheStub, fn) {
  const clientPath = require.resolve('../db/client');
  const cachePath = require.resolve('../cache');
  const svcPath = require.resolve('../services/aptHistoryService');
  const saved = { c: require.cache[clientPath], ch: require.cache[cachePath], s: require.cache[svcPath] };
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { getSupabaseAdmin: () => admin } };
  require.cache[cachePath] = { id: cachePath, filename: cachePath, loaded: true, exports: cacheStub };
  delete require.cache[svcPath];
  return Promise.resolve().then(() => fn(require('../services/aptHistoryService'))).finally(() => {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.ch) require.cache[cachePath] = saved.ch; else delete require.cache[cachePath];
    if (saved.s) require.cache[svcPath] = saved.s; else delete require.cache[svcPath];
  });
}

/** node-cache 의 get/set 최소 동작만 흉내내는 스텁(Map 백엔드) — set 호출 여부를 store 로 검증. */
function makeCache() {
  const store = new Map();
  return { store, get: (k) => store.get(k), set: (k, v) => { store.set(k, v); return true; } };
}

/** PostgREST 체이닝(select/in/order/range)을 흉내내는 admin 목. 테이블별로 페이지 배열을 소비한다. */
function makeAdmin({ histPages = [[]], recentPages = [[]], histErrorAt = -1, recentErrorAt = -1 } = {}) {
  const calls = { hist: [], recent: [] };
  function chain(key, pages, errorAt) {
    const q = {
      select() { return q; },
      in() { return q; },
      order() { return q; },
      range(from, to) {
        const idx = calls[key].length;
        calls[key].push([from, to]);
        if (idx === errorAt) return Promise.resolve({ data: null, error: new Error('DB 오류(테스트 주입)') });
        return Promise.resolve({ data: pages[idx] || [], error: null });
      },
    };
    return q;
  }
  return {
    calls,
    from(table) {
      if (table === 'molit_transactions_hist') return chain('hist', histPages, histErrorAt);
      if (table === 'molit_transactions') return chain('recent', recentPages, recentErrorAt);
      throw new Error('테스트 목이 모르는 테이블: ' + table);
    },
  };
}

/** require.cache 를 바꿔치기해 의존 모듈을 목으로 교체(express5-migration.test.js 의 stubModule 과 동일 기법). */
function stubModule(relPathFromThisFile, exportsObj) {
  const resolved = require.resolve(relPathFromThisFile);
  const saved = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
  return function restore() {
    if (saved) require.cache[resolved] = saved; else delete require.cache[resolved];
  };
}

// ── ① parseSeqs ──────────────────────────────────────────────────────────
test('parseSeqs — 정상 1개 형식', () => {
  const { parseSeqs } = require('../services/aptHistoryService');
  assert.deepEqual(parseSeqs('11500-10189'), ['11500-10189']);
});
test('parseSeqs — 형식 오류(숫자-숫자 패턴이 아님) → null', () => {
  const { parseSeqs } = require('../services/aptHistoryService');
  assert.equal(parseSeqs('b,a'), null);
});
test('parseSeqs — 4개(최대 3개 초과) → null', () => {
  const { parseSeqs } = require('../services/aptHistoryService');
  assert.equal(parseSeqs('11500-1,11500-2,11500-3,11500-4'), null);
});
test('parseSeqs — 중복 제거 + 정렬', () => {
  const { parseSeqs } = require('../services/aptHistoryService');
  assert.deepEqual(parseSeqs('11500-2,11500-1,11500-2'), ['11500-1', '11500-2']);
});

// ── ② aggregateMonthly ───────────────────────────────────────────────────
test('aggregateMonthly — hist+recent 월별 합계·건수, since/until/counts', () => {
  const { aggregateMonthly } = require('../services/aptHistoryService');
  const hist = [
    { deal_date: '2021-03-05', exclu_use_ar: 8499, deal_amount: 100000 },
    { deal_date: '2021-03-05', exclu_use_ar: 8499, deal_amount: 100000 },
    { deal_date: '2021-03-20', exclu_use_ar: 5998, deal_amount: 70000 },
  ];
  const recent = [
    { deal_date: '2025-06-01', exclu_use_ar: '84.99', deal_amount: 120000 },
  ];
  const out = aggregateMonthly(hist, recent);
  assert.deepEqual(out.rows.find(r => r.ym === '2021-03' && r.sqm === 85), { ym: '2021-03', sqm: 85, sum: 200000, n: 2 });
  assert.deepEqual(out.rows.find(r => r.ym === '2021-03' && r.sqm === 60), { ym: '2021-03', sqm: 60, sum: 70000, n: 1 });
  assert.deepEqual(out.rows.find(r => r.ym === '2025-06' && r.sqm === 85), { ym: '2025-06', sqm: 85, sum: 120000, n: 1 });
  assert.equal(out.since, '2021-03');
  assert.equal(out.until, '2025-06');
  assert.deepEqual(out.counts, { hist: 3, recent: 1 });
});

test('aggregateMonthly — 겹침 방지: 원본(recent) 최소월과 같은 달의 hist 행은 버려진다(두 번 세지 않음)', () => {
  const { aggregateMonthly } = require('../services/aptHistoryService');
  const hist = [
    { deal_date: '2021-03-05', exclu_use_ar: 8499, deal_amount: 100000 },
    { deal_date: '2025-06-10', exclu_use_ar: 8499, deal_amount: 999000 }, // recent 최소월(2025-06)과 같은 달 — 버려져야 함
  ];
  const recent = [
    { deal_date: '2025-06-01', exclu_use_ar: '84.99', deal_amount: 120000 },
  ];
  const out = aggregateMonthly(hist, recent);
  const juneRow = out.rows.find(r => r.ym === '2025-06' && r.sqm === 85);
  assert.deepEqual(juneRow, { ym: '2025-06', sqm: 85, sum: 120000, n: 1 },
    'hist 의 2025-06 행이 recent 와 합쳐지면 안 된다(두 번 세지 않음)');
  assert.equal(out.counts.hist, 1, '겹치는 달의 hist 행은 counts.hist 에서도 제외돼야 한다');
});

// ── ④ getAptHistoryMonthly ───────────────────────────────────────────────
test('getAptHistoryMonthly — hist 1000행+230행 두 페이지: range(0,999)·(1000,1999) 두 번, counts.hist===1230', async () => {
  const page1 = Array.from({ length: 1000 }, (_, i) => ({ deal_date: '2021-01-01', exclu_use_ar: 8499, deal_amount: 10000 + i }));
  const page2 = Array.from({ length: 230 }, (_, i) => ({ deal_date: '2021-02-01', exclu_use_ar: 8499, deal_amount: 20000 + i }));
  const admin = makeAdmin({ histPages: [page1, page2], recentPages: [[]] });
  const cacheStub = makeCache();
  await _withAdmin(admin, cacheStub, async ({ getAptHistoryMonthly }) => {
    const out = await getAptHistoryMonthly(['11500-10189']);
    assert.deepEqual(admin.calls.hist, [[0, 999], [1000, 1999]], 'range 호출이 (0,999)·(1000,1999) 두 번이어야 한다');
    assert.equal(out.counts.hist, 1230);
    assert.equal(out.capped, false);
  });
});

test('getAptHistoryMonthly — DB 오류면 null, 캐시에 아무것도 넣지 않는다', async () => {
  const admin = makeAdmin({ histErrorAt: 0 });
  const cacheStub = makeCache();
  await _withAdmin(admin, cacheStub, async ({ getAptHistoryMonthly }) => {
    const out = await getAptHistoryMonthly(['11500-10189']);
    assert.equal(out, null);
    assert.equal(cacheStub.store.size, 0, '실패 응답을 캐시에 넣으면 안 된다');
  });
});

// ── ⑤ 라우트 GET /api/transactions/history ────────────────────────────────
test('GET /api/transactions/history — aptSeq 형식 오류 → 400', async () => {
  const transactionsPath = require.resolve('../routes/transactions');
  delete require.cache[transactionsPath];
  const express = require('express');
  const app = express();
  app.use('/api/transactions', require('../routes/transactions'));
  let srv;
  try {
    srv = app.listen(0);
    const port = srv.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/transactions/history?aptSeq=abc`);
    assert.equal(res.status, 400);
  } finally {
    if (srv) srv.close();
    delete require.cache[transactionsPath];
  }
});

test('GET /api/transactions/history — 서비스 실패(null) → 503 + no-store', async () => {
  const restore = stubModule('../services/aptHistoryService', {
    parseSeqs: () => ['11500-10189'],
    getAptHistoryMonthly: async () => null,
  });
  const transactionsPath = require.resolve('../routes/transactions');
  delete require.cache[transactionsPath];
  const express = require('express');
  const app = express();
  app.use('/api/transactions', require('../routes/transactions'));
  let srv;
  try {
    srv = app.listen(0);
    const port = srv.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/transactions/history?aptSeq=11500-10189`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    if (srv) srv.close();
    restore();
    delete require.cache[transactionsPath];
  }
});

test('GET /api/transactions/history — 정상 → 200 + s-maxage=21600 + source', async () => {
  const restore = stubModule('../services/aptHistoryService', {
    parseSeqs: () => ['11500-10189'],
    getAptHistoryMonthly: async () => ({
      aptSeqs: ['11500-10189'],
      rows: [{ ym: '2021-03', sqm: 85, sum: 200000, n: 2 }],
      since: '2021-03', until: '2021-03',
      counts: { hist: 2, recent: 0 },
      capped: false,
    }),
  });
  const transactionsPath = require.resolve('../routes/transactions');
  delete require.cache[transactionsPath];
  const express = require('express');
  const app = express();
  app.use('/api/transactions', require('../routes/transactions'));
  let srv;
  try {
    srv = app.listen(0);
    const port = srv.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/transactions/history?aptSeq=11500-10189`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /s-maxage=21600/);
    const body = await res.json();
    assert.equal(body.source, '국토교통부 실거래가 공개시스템 (적재분)');
  } finally {
    if (srv) srv.close();
    restore();
    delete require.cache[transactionsPath];
  }
});
