/**
 * TX-HIST-REGION-2026-10-30 (Plan 170): 원본 창 밖 달을 이력(molit_transactions_hist + molit_apt_dim)에서 읽는다.
 *  ① 이력에 기록된 달(archived 또는 molit_hist_runs)만 — 아니면 null(기존 API 경로)
 *  ② 행 모양 = getTransactionsFromDb(이름류는 dim, ㎡×100 → ㎡, 날짜 분해)
 *  ③ apt_seq IN 은 100개씩 나눠 묻는다 ④ 이력 조회 실패는 null(예외를 던지지 않는다)
 * 실행: cd backend && TZ=UTC node --test test/tx-hist-region.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const DB = require.resolve('../db/client');
let tables = {};
const calls = [];
function q(table) {
  const f = { table, eq: {}, in: null, gte: null, lt: null, range: null };
  const run = () => {
    calls.push(f);
    const src = tables[table];
    if (src instanceof Error) return Promise.resolve({ data: null, error: src });
    return Promise.resolve({ data: typeof src === 'function' ? src(f) : (src || []), error: null });
  };
  const c = {
    select: () => c, order: () => c, limit: () => c,
    eq: (k, v) => { f.eq[k] = v; return c; },
    in: (k, v) => { f.in = v; return c; },
    gte: (k, v) => { f.gte = v; return c; },
    lt: (k, v) => { f.lt = v; return c; },
    range: (a, b) => { f.range = [a, b]; return c; },
    then: (res, rej) => run().then(res, rej),
  };
  return c;
}
require.cache[DB] = { id: DB, filename: DB, loaded: true, exports: { getSupabaseAdmin: () => ({ from: q }), hasAdminEnv: () => false } };
const { getTransactionsFromHist } = require('../services/transactionService');

const dim = (n) => Array.from({ length: n }, (_, i) => ({ apt_seq: `11350-${i}`, apt_name: `단지${i}`, sigungu: '노원구', umd_nm: '공릉동', build_year: 1990, jibun: `${i}` }));

test('① 이력에 기록되지 않은 달은 null — 기존 API 경로로 간다(최신 미적재 달을 이력 0건으로 답하지 않는다)', async () => {
  tables = { molit_ingest_runs: [], molit_hist_runs: [] };
  assert.equal(await getTransactionsFromHist('11350', '202610'), null);
});

test('② archived 달: dim 이름류 + ㎡×100 → ㎡ + 날짜 분해, 그 달 범위로만 묻는다', async () => {
  calls.length = 0;
  tables = {
    molit_ingest_runs: [{ deal_ym: '202505' }], molit_hist_runs: [],
    molit_apt_dim: dim(2),
    molit_transactions_hist: (f) => f.in.includes('11350-1') ? [{ apt_seq: '11350-1', deal_date: '2025-05-19', exclu_use_ar: 8492, deal_amount: 64000, floor: 7 }] : [],
  };
  const rows = await getTransactionsFromHist('11350', '202505');
  assert.deepEqual(rows, [{ aptName: '단지1', sigungu: '노원구', umdNm: '공릉동', excluUseAr: 84.92, buildYear: 1990, floor: 7, dealYear: 2025, dealMonth: 5, dealDay: 19, dealAmount: 64000, lawdCd: '11350', aptSeq: '11350-1', jibun: '1' }]);
  const h = calls.find(c => c.table === 'molit_transactions_hist');
  assert.deepEqual([h.gte, h.lt], ['2025-05-01', '2025-06-01']);
  assert.deepEqual(calls.find(c => c.table === 'molit_ingest_runs').eq, { lawd_cd: '11350', deal_ym: '202505', status: 'archived' });
  // 12월 → 다음 해 1월 경계
  tables.molit_ingest_runs = []; tables.molit_hist_runs = [{ deal_ym: '202412' }];
  calls.length = 0;
  await getTransactionsFromHist('11350', '202412');
  const h2 = calls.find(c => c.table === 'molit_transactions_hist');
  assert.deepEqual([h2.gte, h2.lt], ['2024-12-01', '2025-01-01']);
});

test('③ 이력 backfill 달(molit_hist_runs)도 대상, 0건이면 빈 배열(그 달은 정말 거래 없음), apt_seq 는 100개씩', async () => {
  calls.length = 0;
  tables = { molit_ingest_runs: [], molit_hist_runs: [{ deal_ym: '202411' }], molit_apt_dim: dim(250), molit_transactions_hist: [] };
  assert.deepEqual(await getTransactionsFromHist('11350', '202411'), []);
  const ins = calls.filter(c => c.table === 'molit_transactions_hist').map(c => c.in.length);
  assert.deepEqual(ins, [100, 100, 50]);
});

test('④ 실패는 null(예외 없음) — dim 이 비어도 null', async () => {
  tables = { molit_ingest_runs: new Error('x'), molit_hist_runs: [] };
  assert.equal(await getTransactionsFromHist('11350', '202505'), null);
  tables = { molit_ingest_runs: [{ deal_ym: '202505' }], molit_hist_runs: [], molit_apt_dim: [] };
  assert.equal(await getTransactionsFromHist('11350', '202505'), null);
  tables = { molit_ingest_runs: [{ deal_ym: '202505' }], molit_hist_runs: [], molit_apt_dim: dim(1), molit_transactions_hist: new Error('timeout') };
  assert.equal(await getTransactionsFromHist('11350', '202505'), null);
});

test('⑤ getTransactions 는 원본에 ok 기록이 없을 때(null)만 이력을 본다', () => {
  const src = require('fs').readFileSync(require.resolve('../services/transactionService'), 'utf8');
  assert.match(src, /if \(fromDb === null\) \{\n\s*const fromHist = await getTransactionsFromHist\(lawdCd, dealYm\);\n\s*if \(fromHist\) \{ cache\.set\(cacheKey, fromHist, 21600\); return fromHist; \}/);
});
