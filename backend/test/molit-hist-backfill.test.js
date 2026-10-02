/**
 * backend/test/molit-hist-backfill.test.js
 *
 * HIST-BACKFILL-2026-09-16 (Plan 091): 과거 실거래 협폭 이력 backfill 잡.
 * 순수 함수(toHistRow·prevYm)는 직접 고정하고, DB 접근이 있는 runHistBackfill 시나리오는
 * require.cache 주입으로 admin·fetchRegionMonth·LAWD_CODES 를 스텁해 고정한다(popularService/
 * pushNotify 테스트와 같은 기법 — backend/test/cron-observability.test.js 참고). 여러 시나리오를
 * **한 test() 안에서 순차 await** 한다 — pushNotify 테스트와 동일한 이유: require.cache 를 직접
 * 주고받는 스텁은 같은 모듈 경로를 여러 top-level test() 가 동시에 건드리면 서로 덮어쓸 수 있어,
 * 이 저장소는 그 위험을 등록조차 하지 않고 한 test() 로 묶어 원천 차단하는 쪽을 택해왔다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('toHistRow — 정상 변환(84.99→8499, 만원 정수, floor 보존) · apt_seq/날짜/금액 없으면 null · 면적 캡', () => {
  const { toHistRow } = require('../jobs/molitHistBackfill');

  assert.deepEqual(
    toHistRow({ apt_seq: '11680-1234', deal_date: '2025-04-15', exclu_use_ar: 84.99, deal_amount: 120000, floor: 5 }),
    { apt_seq: '11680-1234', deal_date: '2025-04-15', exclu_use_ar: 8499, deal_amount: 120000, floor: 5 },
  );
  // apt_seq 가 숫자로 와도 문자열로 정규화(테이블 컬럼이 text)
  assert.equal(toHistRow({ apt_seq: 11680, deal_date: '2025-04-15', exclu_use_ar: 59.9, deal_amount: 80000, floor: 1 }).apt_seq, '11680');

  // apt_seq 가 없으면 이력에서 단지 식별이 안 되므로 버린다 — DDL 주석과 계획서의 명시 규칙
  assert.equal(toHistRow({ apt_seq: null, deal_date: '2025-04-15', exclu_use_ar: 84.99, deal_amount: 120000, floor: 5 }), null);
  assert.equal(toHistRow({ apt_seq: '', deal_date: '2025-04-15', exclu_use_ar: 84.99, deal_amount: 120000, floor: 5 }), null);
  // 날짜 없음 → null
  assert.equal(toHistRow({ apt_seq: '11680-1', deal_date: null, exclu_use_ar: 84.99, deal_amount: 120000, floor: 5 }), null);
  // 금액 0 이하 → null
  assert.equal(toHistRow({ apt_seq: '11680-1', deal_date: '2025-04-15', exclu_use_ar: 84.99, deal_amount: 0, floor: 5 }), null);
  assert.equal(toHistRow({ apt_seq: '11680-1', deal_date: '2025-04-15', exclu_use_ar: 84.99, deal_amount: -1, floor: 5 }), null);

  // 655㎡ 초과 — smallint 상한(32767)으로 캡
  const capped = toHistRow({ apt_seq: '11680-1', deal_date: '2025-04-15', exclu_use_ar: 900, deal_amount: 500000, floor: 10 });
  assert.equal(capped.exclu_use_ar, 32767);
  // 음수 면적(비정상 입력) 방어 — 0 미만으로 내려가지 않는다
  assert.equal(toHistRow({ apt_seq: '11680-1', deal_date: '2025-04-15', exclu_use_ar: -5, deal_amount: 10000, floor: 1 }).exclu_use_ar, 0);

  // floor 없음(null) → null 유지, 0 층(필로티 등)은 0 그대로 보존
  assert.equal(toHistRow({ apt_seq: '11680-1', deal_date: '2025-04-15', exclu_use_ar: 59.9, deal_amount: 80000, floor: null }).floor, null);
  assert.equal(toHistRow({ apt_seq: '11680-1', deal_date: '2025-04-15', exclu_use_ar: 59.9, deal_amount: 80000, floor: 0 }).floor, 0);
});

test('prevYm — 1월은 전년도 12월로, 그 외엔 월만 감소', () => {
  const { prevYm } = require('../jobs/molitHistBackfill');
  assert.equal(prevYm('202601'), '202512');
  assert.equal(prevYm('202504'), '202503');
  assert.equal(prevYm('202510'), '202509');
  assert.equal(prevYm('202001'), '201912');
});

test('START_YM/DB_STOP_MB — 계획서 상수 고정(현재 molit_transactions 시작월과 겹치지 않는 첫 달 · 무료 티어 안전선)', () => {
  const { START_YM, DB_STOP_MB } = require('../jobs/molitHistBackfill');
  assert.equal(START_YM, '202504');
  assert.equal(DB_STOP_MB, 470);
});



// ── 스텁 admin — rpc('db_size_mb') 값 주입, from().insert/upsert/delete, runs 조회 ──────────
//   supabase-js 의 각 빌더 메서드는 체이닝되다 마지막 호출이 awaited 될 때 실행된다(postgrest-js
//   thenable 관례) — 이 저장소의 다른 스텁(popularService/pushNotify 테스트)과 동일한 형태.
function _makeAdmin({ dbMb = 100, doneRuns = [] } = {}) {
  const calls = { inserted: [], upserted: [], deletedRanges: [] };
  const client = {
    rpc: async (name) => (name === 'db_size_mb'
      ? { data: dbMb, error: null }
      : { data: null, error: new Error('molit-hist-backfill 테스트 스텁: 예상 밖 rpc ' + name) }),
    from(table) {
      if (table === 'molit_hist_runs') {
        return {
          select: () => ({
            order: () => ({
              range: async (from) => (from === 0 ? { data: doneRuns, error: null } : { data: [], error: null }),
            }),
          }),
          upsert: async (row) => { calls.upserted.push(row); return { error: null }; },
        };
      }
      if (table === 'molit_transactions_hist') {
        return {
          delete: () => ({
            like: (col, pat) => ({
              gte: (col2, first) => ({
                lte: async (col3, last) => { calls.deletedRanges.push({ pat, first, last }); return { error: null }; },
              }),
            }),
          }),
          insert: async (rows) => { calls.inserted.push(...rows); return { error: null }; },
        };
      }
      throw new Error('molit-hist-backfill 테스트 스텁: 예상 밖 테이블 ' + table);
    },
  };
  return { client, calls };
}

// require.cache 주입으로 admin(db/client)·fetchRegionMonth(molitIngest)·LAWD_CODES(transactionService)
// 를 스텁하고 runHistBackfill 을 실행한다. molitHistBackfill 은 최상단에서 이들을 구조분해하므로
// require 시점에 스텁이 이미 캐시에 있어야 한다(호출 후 교체는 이미 바인딩된 참조에 안 먹는다).
async function _runWithStubs(opts, admin, fetchImpl, lawdCodes) {
  const jobPath = require.resolve('../jobs/molitHistBackfill');
  const ingestPath = require.resolve('../jobs/molitIngest');
  const clientPath = require.resolve('../db/client');
  const txPath = require.resolve('../services/transactionService');
  const paths = [jobPath, ingestPath, clientPath, txPath];
  const saved = {};
  for (const p of paths) saved[p] = require.cache[p];
  const stub = (p, exportsObj) => { require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj }; };
  stub(ingestPath, { fetchRegionMonth: fetchImpl });
  stub(clientPath, { requireSupabaseAdmin: () => admin });
  stub(txPath, { LAWD_CODES: lawdCodes || { '테스트구': '11111' } });
  delete require.cache[jobPath];
  try {
    const { runHistBackfill } = require(jobPath);
    return await runHistBackfill(opts);
  } finally {
    for (const p of paths) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; }
  }
}

test('runHistBackfill — 스텁 admin 시나리오: 용량 정지 · 정상 처리 · 재실행 건너뛰기 · fetch 실패 · 전 구간 완료', async () => {
  // ① 용량 ≥ 470 이면 fetch 없이 즉시 정지 — MOLIT 쿼터를 쓰지 않아야 한다
  {
    const { client } = _makeAdmin({ dbMb: 470 });
    let fetchCalled = false;
    const res = await _runWithStubs({}, client, async () => { fetchCalled = true; return []; }, { '테스트구': '11111' });
    assert.deepEqual(res, { stopped: true, reason: 'db-size', dbMb: 470, done: 0 });
    assert.equal(fetchCalled, false, 'DB 용량 임계에서 fetch 가 호출되면 안 된다 — MOLIT 쿼터 낭비');
  }

  // ② 정상 2개 region-month 처리 — runs upsert 2회, insert 행수가 fetch·변환 결과와 일치, 삭제-후-삽입 멱등 경로 확인
  {
    const { client, calls } = _makeAdmin({ dbMb: 100, doneRuns: [] });
    const rowsFor = {
      '11111|202504': [
        { apt_seq: '11111-1', deal_date: '2025-04-10', exclu_use_ar: 84.99, deal_amount: 100000, floor: 3 },
        { apt_seq: '11111-2', deal_date: '2025-04-11', exclu_use_ar: 59.8, deal_amount: 70000, floor: 7 },
      ],
      '22222|202504': [
        { apt_seq: '22222-1', deal_date: '2025-04-12', exclu_use_ar: 114.5, deal_amount: 200000, floor: 12 },
      ],
    };
    const fetchCalls = [];
    const fetchImpl = async (lawdCd, ym) => { fetchCalls.push([lawdCd, ym]); return rowsFor[`${lawdCd}|${ym}`] || []; };
    const res = await _runWithStubs({ limit: 2 }, client, fetchImpl, { '테스트구1': '11111', '테스트구2': '22222' });

    assert.equal(res.done, 2);
    assert.equal(res.err, 0);
    assert.equal(res.rows, 3, 'insert 된 총 행수(2+1)와 일치해야 한다');
    assert.equal(res.lastYm, '202504');
    assert.equal(res.stopped, false);
    assert.deepEqual(fetchCalls.sort(), [['11111', '202504'], ['22222', '202504']], '최신월(START_YM)부터 LAWD_CODES 전 지역을 대상으로 fetch 해야 한다');
    assert.equal(calls.upserted.length, 2, 'molit_hist_runs upsert 가 region-month 당 1회씩 총 2회 있어야 한다');
    assert.deepEqual(calls.upserted.map((u) => u.rows).sort(), [1, 2]);
    assert.equal(calls.inserted.length, 3, 'insert 된 행 수가 fetch·변환 결과와 일치해야 한다');
    assert.equal(calls.deletedRanges.length, 2, '삽입 전 그 region-month 를 비우는 delete 가 region-month 당 1회 있어야 한다(멱등)');
    assert.ok(calls.deletedRanges.every((d) => d.first === '2025-04-01' && d.last === '2025-04-30'), '월 경계(1일~말일) 계산이 어긋났다');
  }

  // ③ 이미 완료된 (lawd,ym) 은 runs 조회로 건너뛴다(재실행 안전)
  {
    const { client, calls } = _makeAdmin({ dbMb: 100, doneRuns: [{ lawd_cd: '11111', deal_ym: '202504' }] });
    const fetchCalls = [];
    const fetchImpl = async (lawdCd, ym) => { fetchCalls.push([lawdCd, ym]); return []; };
    const res = await _runWithStubs({ limit: 5 }, client, fetchImpl, { '테스트구1': '11111', '테스트구2': '22222' });
    assert.deepEqual(fetchCalls[0], ['22222', '202504']);
    assert.ok(fetchCalls.every(([lawd, ym]) => !(lawd === '11111' && ym === '202504')), '완료된 (lawd,ym) 을 다시 처리했다');
    assert.equal(res.done, 5);
    assert.equal(calls.upserted.some((u) => u.lawd_cd === '11111' && u.deal_ym === '202504'), false, '이미 완료된 쌍을 다시 기록하면 안 된다');
  }

  // ④ fetch 예외 시 err 카운트만 오르고 runs 에는 기록되지 않는다(다음 실행이 재시도)
  {
    const { client, calls } = _makeAdmin({ dbMb: 100 });
    const res = await _runWithStubs({ limit: 1 }, client, async () => { throw new Error('MOLIT 네트워크 오류(테스트)'); }, { '테스트구': '11111' });
    assert.equal(res.err, 1);
    assert.equal(res.done, 0);
    assert.equal(res.rows, 0);
    assert.equal(res.lastYm, null);
    assert.equal(res.stopped, false);
    assert.equal(calls.upserted.length, 0, '실패한 region-month 는 runs 에 기록되면 안 된다(멱등 재시도 전제가 깨진다)');
    assert.equal(calls.inserted.length, 0);
  }

  // ⑤ 더 처리할 대상이 없으면(전 구간 완료) stopped:true, reason:'complete'
    const { prevYm, START_YM } = require('../jobs/molitHistBackfill');
    const doneRuns = [];
    for (let ym = START_YM; ym >= '201901'; ym = prevYm(ym)) doneRuns.push({ lawd_cd: '11111', deal_ym: ym });
    const { client } = _makeAdmin({ dbMb: 100, doneRuns });
    const res = await _runWithStubs({ limit: 5 }, client, async () => { throw new Error('호출되면 안 된다 — 대상이 없어야 한다'); }, { '테스트구': '11111' });
    assert.equal(res.stopped, true);
    assert.equal(res.reason, 'complete');
    assert.equal(res.dbMb, 100);
    assert.equal(res.done, 0);
    assert.equal(res.rows, 0);
    assert.equal(res.err, 0);
    assert.equal(res.lastYm, null);
    assert.equal(res.budgetHit, false);
    assert.ok(typeof res.elapsedMs === 'number');

  // ⑥ 시간예산: timeBudgetMs:0 이면 첫 region-month 를 끝낸 직후 멈춘다(budgetHit) — 대상이 남았으니 stopped:false
  {
    const { client } = _makeAdmin({ dbMb: 100 });
    const fetchCalls = [];
    const res = await _runWithStubs({ limit: 5, timeBudgetMs: 0 }, client, async (l, y) => { fetchCalls.push([l, y]); return []; }, { '테스트구1': '11111', '테스트구2': '22222' });
    assert.equal(fetchCalls.length, 1, '예산 0 이면 정확히 1개만 처리하고 멈춰야 한다');
    assert.equal(res.budgetHit, true);
    assert.equal(res.stopped, false);
    assert.equal(typeof res.elapsedMs, 'number');
  }

  // ⑦ 연속 실패 3회면 남은 대상을 두들기지 않고 reason:'errors' 로 끝낸다(다음 슬롯이 재시도)
  {
    const { client, calls } = _makeAdmin({ dbMb: 100 });
    let n = 0;
    const res = await _runWithStubs({ limit: 10 }, client, async () => { n++; throw new Error('MOLIT 쿼터 소진(테스트)'); }, { '테스트구1': '11111', '테스트구2': '22222', '테스트구3': '33333', '테스트구4': '44444', '테스트구5': '55555' });
    assert.equal(n, 3, '3회 연속 실패 뒤엔 더 호출하면 안 된다');
    assert.equal(res.reason, 'errors');
    assert.equal(res.err, 3);
    assert.equal(res.stopped, false);
    assert.equal(calls.upserted.length, 0);
  }
});

test('FLOOR_YM — 2020-09 에서 동결: START_YM~2020-09 가 끝났으면 2020-08 이전은 대상이 아니다 (용량 보호, Plan 100)', async () => {
  const { prevYm, START_YM, FLOOR_YM } = require('../jobs/molitHistBackfill');
  assert.equal(FLOOR_YM, '202009');
  const doneRuns = [];
  for (let ym = START_YM; ym >= '202009'; ym = prevYm(ym)) doneRuns.push({ lawd_cd: '11111', deal_ym: ym });
  const { client, calls } = _makeAdmin({ dbMb: 100, doneRuns });
  let fetchCalled = false;
  const res = await _runWithStubs({ limit: 5 }, client, async () => { fetchCalled = true; return []; }, { '테스트구': '11111' });
  assert.equal(fetchCalled, false, '2020-08 이전을 가져오면 안 된다 — 되찾은 DB 공간을 backfill 이 다시 채운다');
  assert.equal(res.stopped, true);
  assert.equal(res.reason, 'complete');
  assert.equal(calls.inserted.length, 0);
});


// ══════════════════════════════════════════════════════════════════════════
// HIST-PATCH-2026-10-02 (Plan 131) — 이미 자른 달 가운데 이력에 빠진 (지역, 월) 지정 보강.
//   실사례: 107c-1 이 2025-05 를 자를 때 화성 신설 3구는 원본에 그 달이 없어 이력에도 없다.
//   아래 스텁은 이력·경신 기준선을 메모리 배열로 흉내 낸다(in/like 삭제, 정렬+range 조회, peaks upsert).
// ══════════════════════════════════════════════════════════════════════════
function _makeMemAdmin({ histRows = [], peaks = [], doneRuns = [], failRunsUpsertOnce = false } = {}) {
  const state = {
    hist: histRows.map((r) => ({ ...r })),
    peaks: new Map(peaks.map((p) => [`${p.apt_seq}|${p.exclu_use_ar}`, { ...p }])),
    runs: [],
    peaksUpserts: 0,
  };
  let runsFail = failRunsUpsertOnce;
  const inMonth = (r, first, last) => r.deal_date >= first && r.deal_date <= last;
  const client = {
    rpc: async (name) => (name === 'db_size_mb' ? { data: 100, error: null } : { data: null, error: new Error('예상 밖 rpc ' + name) }),
    from(table) {
      if (table === 'molit_hist_runs') {
        return {
          select: () => ({ order: () => ({ range: async (from) => (from === 0 ? { data: [...doneRuns, ...state.runs], error: null } : { data: [], error: null }) }) }),
          upsert: async (row) => {
            if (runsFail) { runsFail = false; return { error: new Error('runs upsert 실패(테스트)') }; }
            state.runs.push(row); return { error: null };
          },
        };
      }
      if (table === 'molit_transactions_hist') {
        return {
          delete: () => ({
            like: (_c, pat) => ({ gte: (_c2, first) => ({ lte: async (_c3, last) => {
              const prefix = pat.replace(/%$/, '');
              state.hist = state.hist.filter((r) => !(r.apt_seq.startsWith(prefix) && inMonth(r, first, last)));
              return { error: null };
            } }) }),
            in: (_c, vals) => ({ gte: (_c2, first) => ({ lte: async (_c3, last) => {
              state.hist = state.hist.filter((r) => !(vals.includes(r.apt_seq) && inMonth(r, first, last)));
              return { error: null };
            } }) }),
          }),
          insert: async (rows) => { state.hist.push(...rows.map((r) => ({ ...r }))); return { error: null }; },
          select: () => {
            let vals = [];
            const chain = {
              in(_c, v) { vals = v; return chain; },
              order() { return chain; },
              range: async (from, to) => {
                const out = state.hist.filter((r) => vals.includes(r.apt_seq))
                  .sort((a, b) => (a.apt_seq < b.apt_seq ? -1 : a.apt_seq > b.apt_seq ? 1 : a.deal_date < b.deal_date ? -1 : a.deal_date > b.deal_date ? 1 : a.deal_amount - b.deal_amount));
                return { data: out.slice(from, to + 1).map((r) => ({ apt_seq: r.apt_seq, exclu_use_ar: r.exclu_use_ar, deal_amount: r.deal_amount })), error: null };
              },
            };
            return chain;
          },
        };
      }
      if (table === 'molit_hist_peaks') {
        return {
          upsert: async (rows, opts) => {
            assert.equal(opts && opts.onConflict, 'apt_seq,exclu_use_ar', 'peaks upsert 의 충돌 키가 PK 와 다르다');
            state.peaksUpserts++;
            for (const p of rows) state.peaks.set(`${p.apt_seq}|${p.exclu_use_ar}`, { ...p });
            return { error: null };
          },
        };
      }
      throw new Error('molit-hist-backfill 메모리 스텁: 예상 밖 테이블 ' + table);
    },
  };
  return { client, state };
}

// 화성 만세구(41591) 2025-05 — MOLIT 이 돌려주는 원천 행(apt_seq 접두어는 옛 통합코드 41590).
const _EXTRA_FETCH = [
  { apt_seq: '41590-100', deal_date: '2025-05-03', exclu_use_ar: 84.99, deal_amount: 52000, floor: 5 },
  { apt_seq: '41590-100', deal_date: '2025-05-20', exclu_use_ar: 84.99, deal_amount: 47000, floor: 9 },
  { apt_seq: '41590-200', deal_date: '2025-05-11', exclu_use_ar: 59.5, deal_amount: 31000, floor: 2 },
];
// 이미 이력에 있는 행: 같은 단지의 다른 달(2025-04) · 같은 달의 다른 단지(동탄, 건드리면 안 됨).
const _EXTRA_EXISTING = [
  { apt_seq: '41590-100', deal_date: '2025-04-10', exclu_use_ar: 8499, deal_amount: 50000, floor: 3 },
  { apt_seq: '41590-900', deal_date: '2025-05-07', exclu_use_ar: 8400, deal_amount: 90000, floor: 11 },
];
const _EXTRA_EXISTING_PEAKS = [
  { apt_seq: '41590-100', exclu_use_ar: 8499, mx: 50000, mn: 50000, n: 1 },
  { apt_seq: '41590-900', exclu_use_ar: 8400, mx: 90000, mn: 90000, n: 1 },
];

test('지정 보강(Plan 131) — 대상 목록은 화성 신설 3구의 2025-05 뿐이고, LAWD_CODES 에 없는 코드는 무시한다', async () => {
  const { EXTRA_TARGETS } = require('../jobs/molitHistBackfill');
  assert.deepEqual(EXTRA_TARGETS, [['41591', '202505'], ['41593', '202505'], ['41595', '202505']],
    '인천 신설구 등을 넣으면 옛 코드분으로 이미 이력에 있는 행이 중복된다');
  const { client } = _makeMemAdmin();
  const fetchCalls = [];
  await _runWithStubs({ limit: 2 }, client, async (l, y) => { fetchCalls.push([l, y]); return []; }, { '테스트구': '11111' });
  assert.ok(fetchCalls.every(([, ym]) => ym !== '202505'), 'LAWD_CODES 에 없는 지정 대상이 처리됐다');
});

test('지정 보강(Plan 131) — 먼저 처리되고, 가져온 단지의 그 달 행만 바꾸며, 경신 기준선을 이력 전체에서 다시 계산한다', async () => {
  const { client, state } = _makeMemAdmin({ histRows: _EXTRA_EXISTING, peaks: _EXTRA_EXISTING_PEAKS });
  const fetchCalls = [];
  const fetchImpl = async (l, y) => { fetchCalls.push([l, y]); return l === '41591' && y === '202505' ? _EXTRA_FETCH : []; };
  const res = await _runWithStubs({ limit: 1 }, client, fetchImpl, { '화성만세': '41591', '테스트구': '11111' });

  assert.deepEqual(fetchCalls, [['41591', '202505']], '지정 대상이 START_YM 대상보다 먼저여야 한다');
  assert.equal(res.done, 1);
  assert.equal(res.rows, 3);
  assert.deepEqual(state.runs, [{ lawd_cd: '41591', deal_ym: '202505', rows: 3 }]);
  assert.equal(state.hist.length, 5, '기존 2행 + 새 3행');
  assert.ok(state.hist.some((r) => r.apt_seq === '41590-900' && r.deal_date === '2025-05-07'), '같은 달의 다른 단지(동탄) 행이 지워졌다');
  assert.ok(state.hist.some((r) => r.apt_seq === '41590-100' && r.deal_date === '2025-04-10'), '같은 단지의 다른 달 행이 지워졌다');
  assert.deepEqual(state.peaks.get('41590-100|8499'), { apt_seq: '41590-100', exclu_use_ar: 8499, mx: 52000, mn: 47000, n: 3 },
    '기준선 = 이력 전체(4월 1건 + 5월 2건)의 최고·최저·건수');
  assert.deepEqual(state.peaks.get('41590-200|5950'), { apt_seq: '41590-200', exclu_use_ar: 5950, mx: 31000, mn: 31000, n: 1 });
  assert.deepEqual(state.peaks.get('41590-900|8400'), { apt_seq: '41590-900', exclu_use_ar: 8400, mx: 90000, mn: 90000, n: 1 }, '가져오지 않은 단지의 기준선이 바뀌었다');
});

test('지정 보강(Plan 131) — 기록 실패로 다시 돌아도 이력 중복·건수 이중 계상이 없다', async () => {
  const { client, state } = _makeMemAdmin({ histRows: _EXTRA_EXISTING, peaks: _EXTRA_EXISTING_PEAKS, failRunsUpsertOnce: true });
  const fetchImpl = async (l, y) => (l === '41591' && y === '202505' ? _EXTRA_FETCH : []);
  const first = await _runWithStubs({ limit: 1 }, client, fetchImpl, { '화성만세': '41591' });
  assert.equal(first.err, 1, '첫 회차는 runs 기록 실패로 err 여야 한다');
  assert.equal(state.runs.length, 0);
  const second = await _runWithStubs({ limit: 1 }, client, fetchImpl, { '화성만세': '41591' });
  assert.equal(second.done, 1);
  assert.equal(state.hist.filter((r) => r.apt_seq === '41590-100' && r.deal_date >= '2025-05-01').length, 2, '재시도로 5월 행이 중복됐다');
  assert.equal(state.hist.length, 5);
  assert.equal(state.peaks.get('41590-100|8499').n, 3, '재시도로 건수가 이중 계상됐다');
});

test('지정 보강(Plan 131) — 이미 기록된 대상은 건너뛰고, 일반 대상의 접두어 삭제 경로는 그대로다', async () => {
  const { client, state } = _makeMemAdmin({
    doneRuns: [{ lawd_cd: '41591', deal_ym: '202505' }],
    histRows: [{ apt_seq: '41591-7', deal_date: '2025-04-02', exclu_use_ar: 8400, deal_amount: 1, floor: 1 }],
  });
  const fetchCalls = [];
  const res = await _runWithStubs({ limit: 1 }, client, async (l, y) => { fetchCalls.push([l, y]); return []; }, { '화성만세': '41591' });
  assert.deepEqual(fetchCalls, [['41591', '202504']], '완료된 지정 대상을 다시 처리했거나 일반 대상 순서가 바뀌었다');
  assert.equal(res.done, 1);
  assert.equal(state.hist.length, 0, '일반 대상은 종전처럼 접두어(lawd-%)로 그 달을 비워야 한다');
  assert.equal(state.peaksUpserts, 0, '일반 대상은 기준선을 건드리지 않는다');
});
