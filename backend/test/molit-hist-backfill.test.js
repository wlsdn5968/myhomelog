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
  {
    const { prevYm, START_YM } = require('../jobs/molitHistBackfill');
    const doneRuns = [];
    for (let ym = START_YM; ym >= '201901'; ym = prevYm(ym)) doneRuns.push({ lawd_cd: '11111', deal_ym: ym });
    const { client } = _makeAdmin({ dbMb: 100, doneRuns });
    const res = await _runWithStubs({ limit: 5 }, client, async () => { throw new Error('호출되면 안 된다 — 대상이 없어야 한다'); }, { '테스트구': '11111' });
    assert.deepEqual(res, { stopped: true, reason: 'complete', dbMb: 100, done: 0, rows: 0, err: 0, lastYm: null });
  }
});
