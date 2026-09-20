/**
 * backend/test/apt-dim-fallback.test.js
 *
 * APT-DIM-FALLBACK-2026-09-20 (Plan 107a): `loadAptFacts`(backend/routes/aptPage.js) 가
 * MV(molit_apt_index) 와 원본 24개월 조회가 동시에 비었을 때 `molit_apt_dim` 을 3번째
 * 소스로 읽는지 고정한다. 이 계획은 원본을 16개월 창으로 자르기(107c) **전에** 배선만
 * 먼저 까는 것이라 오늘은 동작 변화가 없어야 한다 — 그래서 "MV 가 있으면 dim 을 아예
 * 조회하지 않는다"(왕복 낭비 방지)도 같이 고정한다.
 *
 * [실행 방식] aptPage.js 의 loadIndexRow/loadDimRow 는 함수 안에서 그때그때
 * require('../db/client') 하므로, require.cache 를 스텁으로 갈아치우면 라우터를
 * 새로 로드할 필요 없이 loadAptFacts 호출 시점에 그대로 먹힌다
 * (backend/testSupport/_helpers.js 의 _p063Run 과 같은 관례).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const AF_SEQ = '11680-9999';

// idx(molit_apt_index) 행 — 있으면 loadAptFacts 가 dim 을 조회할 이유가 없다.
function _dimIdxRow() {
  return { apt_seq: AF_SEQ, apt_name: '인덱스단지', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 2000, recent_deal_date: '2026-08-01', deal_count: 3 };
}

// dim(molit_apt_dim) 행 — MV·원본이 둘 다 비어도 이 행 하나로 loadAptFacts 가 null 을 반환하지 않아야 한다.
function _dimRow() {
  return { apt_seq: AF_SEQ, apt_name: '이력단지', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1995, last_deal_date: '2020-01-01', deal_count: 12 };
}

// select().eq().limit() 체이닝을 흉내내는 thenable — _p063MockTable(backend/testSupport/_helpers.js)과 동일한 모양.
function _mockTable(rows, error) {
  return {
    select() { return this; },
    eq() { return this; },
    limit() { return this; },
    then(resolve) {
      if (error) return resolve({ data: null, error });
      resolve({ data: rows, error: null });
    },
  };
}

// molit_apt_dim 조회만 진짜 예외(throw)를 내는 테이블 — supabase 스타일 { error } 반환이 아니라
// 쿼리 빌더 자체가 죽는 경우를 흉내낸다(로직상 loadDimRow 안에는 try/catch 가 없다 — 호출부인
// loadAptFacts 의 try/catch(:144 부근)가 이걸 삼키는지가 이 테스트 4의 요지다).
function _throwingTable() {
  return {
    select() { throw new Error('APT-DIM-FALLBACK-TEST 주입 예외'); },
  };
}

async function _runLoadAptFacts({ idxRows, dimRows, dimError, dimThrows, txs }) {
  const dbPath = require.resolve('../db/client');
  const svcPath = require.resolve('../services/transactionService');
  // priceRecordsService 는 최초 로드 시 top-level 에서 transactionService.LAWD_CODES 를 읽는다
  // (backend/testSupport/_helpers.js 의 _p063Run 주석 참고) — 스텁을 걸기 전에 실제 모듈로
  // 한 번 미리 로드해 그 파생 상수를 안전하게 캐시시켜 둔다.
  require('../services/priceRecordsService');
  const calls = [];
  const admin = {
    from(t) {
      calls.push(t);
      if (t === 'molit_apt_index') return _mockTable(idxRows || []);
      if (t === 'molit_apt_dim') {
        if (dimThrows) return _throwingTable();
        return _mockTable(dimRows || [], dimError || null);
      }
      throw new Error(`APT-DIM-FALLBACK-TEST: 예상 밖 테이블 조회 — ${t}`);
    },
  };
  const saved = { db: require.cache[dbPath], svc: require.cache[svcPath] };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => admin } };
  require.cache[svcPath] = {
    id: svcPath, filename: svcPath, loaded: true,
    exports: {
      getTransactionsByAptSeq: async () => (txs || []),
      analyzeTransactions: () => [],
    },
  };
  try {
    const { loadAptFacts } = require('../routes/aptPage');
    const result = await loadAptFacts(AF_SEQ);
    return { result, calls };
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
  }
}



test('APT-DIM-FALLBACK — MV 에 행이 있으면 molit_apt_dim 을 조회하지 않는다 (Plan 107a Step 1, 왕복 낭비 방지)', async () => {
  const { result, calls } = await _runLoadAptFacts({ idxRows: [_dimIdxRow()], txs: [] });
  assert.ok(result, 'MV 행이 있는데 loadAptFacts 가 null 을 반환했다');
  assert.ok(!calls.includes('molit_apt_dim'), `MV 히트인데도 molit_apt_dim 을 조회했다(불필요한 왕복): calls=${JSON.stringify(calls)}`);
});



test('APT-DIM-FALLBACK — MV·거래가 둘 다 비어도 dim 에 행이 있으면 null 이 아니다 (Plan 107a Step 1, 이 계획의 본질)', async () => {
  const { result, calls } = await _runLoadAptFacts({ idxRows: [], dimRows: [_dimRow()], txs: [] });
  assert.ok(calls.includes('molit_apt_dim'), 'MV·거래가 둘 다 비었는데 molit_apt_dim 을 조회하지 않았다');
  assert.ok(result, 'dim 에 행이 있는데도 loadAptFacts 가 null 을 반환했다 — 창을 자르면 이 단지 페이지가 404 가 된다');
  assert.equal(result.aptName, '이력단지', 'dim 의 apt_name 이 idx 자리로 안 들어왔다');
  assert.equal(result.stat, null, '거래가 없는데 stat 이 생겼다 — 값을 지어내면 안 된다');
});



test('APT-DIM-FALLBACK — MV·거래·dim 셋 다 비면 여전히 null 이다 (Plan 107a Step 1, 없는 단지를 지어내지 않는다)', async () => {
  const { result } = await _runLoadAptFacts({ idxRows: [], dimRows: [], txs: [] });
  assert.equal(result, null, '세 소스 모두 비었는데 loadAptFacts 가 값을 반환했다 — 없는 단지를 지어냈다');
});



test('APT-DIM-FALLBACK — dim 조회가 예외를 던져도 loadAptFacts 는 밖으로 던지지 않는다 (Plan 107a Step 1, 500 방지)', async () => {
  let outcome;
  await assert.doesNotReject(async () => {
    outcome = await _runLoadAptFacts({ idxRows: [], dimThrows: true, txs: [] });
  }, 'dim 조회 예외가 loadAptFacts 밖으로 던져졌다 — 페이지가 500 으로 죽는다');
  assert.equal(outcome.result, null, 'dim 예외 상황에서 idx 도 txs 도 없는데 값을 지어냈다');
});
