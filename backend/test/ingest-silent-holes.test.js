/**
 * backend/test/ingest-silent-holes.test.js
 *
 * SILENT-HOLE-2026-09-27 (Plan 119) — retryFailedGaps 확장(molitIngest.js) 고정.
 *
 * [배경] 2026-08-16 경기 과거분 백필의 한 회차가 연속 3실패 회로차단(CIRCUIT_BREAK_CONSECUTIVE_FAILURES)
 * 에 걸려 남은 작업을 skipped 로 넘겼다 — skipped 작업은 ingestOne 을 타지 않아 molit_ingest_runs 에
 * 행이 아예 안 남는다. 기존 retryFailedGaps 는 status in ('error','timeout') 행에서만 후보를 뽑아
 * 이런 "행 자체가 없는" 조합(경기 36곳 3개월·청주 2026-05)은 영원히 못 잡았다. Plan 119 는 최신 3개월
 * 밖에서 ok/archived 기록이 전혀 없는 (지역,월)을 구멍 후보로 추가해 같은 재시도 루프에 합류시킨다.
 *
 * [이 파일이 하는 일] retryFailedGaps 자체를 module.exports._retryFailedGaps 로 직접 불러 실행한다
 * (cron 핸들러를 거치지 않는다 — 이 파일의 관심사는 gap-backfill 알고리즘 자체뿐이다). 네트워크를
 * 타지 않도록 이 저장소의 확립된 require.cache 스텁 패턴(testSupport/_helpers.js 의 여러 헬퍼와 동일
 * 방식)으로 dataGoKrClient.get 과 transactionService.LAWD_CODES 를 갈아치운 뒤 molitIngest.js 를
 * 다시 불러온다. LAWD_CODES 는 3개 코드로 고정해 기대값 계산을 단순하게 유지한다(계획서 §2-4).
 * molit_ingest_runs 는 배열 기반 가짜 admin 으로 흉내 낸다(insert/update/select 체인).
 *
 * [날짜 하드코드 금지] recentYearMonths(lookbackMonths)의 산출 방식을 그대로 재현한 로컬 헬퍼
 * (_recentYms)로 기대 월을 계산한다 — 절대 날짜 문자열을 쓰지 않는다(memory test-absolute-date-rot).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TX_SERVICE_PATH = require.resolve('../services/transactionService');
const DGK_PATH = require.resolve('../services/dataGoKrClient');
const MOLIT_INGEST_PATH = require.resolve('../jobs/molitIngest');

// 3개 지역만 — 실제 125개를 쓰면 기대값 계산이 복잡해진다(계획서 §2-4 "LAWD_CODES 는
// transactionService 스텁으로 3개 코드만").
const STUB_LAWD_CODES = { 'A동': '11111', 'B동': '22222', 'C동': '33333' };
const STUB_LAWD_CODE_TO_NAME = { '11111': 'A동', '22222': 'B동', '33333': 'C동' };

// molitIngest.js 의 recentYearMonths(months) 와 동일한 산출식 — 절대 날짜를 하드코드하지 않고
// 코드와 같은 방식으로 "지금 기준" 기대 월을 계산한다.
function _recentYms(months) {
  const now = new Date();
  const out = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** dataGoKrClient.get 스텁 — 네트워크 무호출, 항상 빈 응답(rows=0 → ingestOne 이 status='ok' 로 기록). */
function _dgkStub() {
  const calls = [];
  const get = (_url, config) => {
    calls.push({ lawdCd: config.params.LAWD_CD, dealYm: config.params.DEAL_YMD });
    return Promise.resolve({
      data: { response: { header: { resultCode: '00', resultMsg: 'OK' }, body: { items: { item: [] }, totalCount: 0 } } },
    });
  };
  return { get, calls };
}

/**
 * molit_ingest_runs 를 흉내 내는 가짜 admin. initialRows 는 {id, lawd_cd, deal_ym, status} 배열.
 * opts.coveredShouldFail=true 면 status in ('ok','archived') 구멍-후보 조회(covered 조회)만 에러를
 * 낸다(기존 실패/성공 목록 조회는 그대로 성공) — 계획서 단언 6 전용.
 */
function _fakeIngestAdmin(initialRows, opts = {}) {
  const rows = initialRows.map(r => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;

  function selectChain() {
    const filters = { in: {}, eq: {}, gte: null, lte: null };
    const chain = {
      in(col, vals) { filters.in[col] = vals; return chain; },
      eq(col, val) { filters.eq[col] = val; return chain; },
      gte(col, val) { filters.gte = [col, val]; return chain; },
      lte(col, val) { filters.lte = [col, val]; return chain; },
      order() { return chain; },
      range(from, to) {
        const statusIn = filters.in.status || [];
        const isCoveredQuery = statusIn.includes('ok') && statusIn.includes('archived');
        if (opts.coveredShouldFail && isCoveredQuery) {
          return Promise.resolve({ data: null, error: { message: 'stub: covered 조회 실패' } });
        }
        let out = rows.slice();
        for (const [col, vals] of Object.entries(filters.in)) out = out.filter(r => vals.includes(r[col]));
        for (const [col, val] of Object.entries(filters.eq)) out = out.filter(r => r[col] === val);
        if (filters.gte) out = out.filter(r => r[filters.gte[0]] >= filters.gte[1]);
        if (filters.lte) out = out.filter(r => r[filters.lte[0]] <= filters.lte[1]);
        return Promise.resolve({ data: out.slice(from, to + 1), error: null });
      },
    };
    return chain;
  }

  return {
    from(table) {
      if (table === 'molit_ingest_runs') {
        return {
          select() { return selectChain(); },
          insert(obj) {
            return {
              select() {
                return {
                  single() {
                    const row = { id: nextId++, status: 'running', ...obj };
                    rows.push(row);
                    return Promise.resolve({ data: { id: row.id }, error: null });
                  },
                };
              },
            };
          },
          update(patch) {
            return {
              eq(col, val) {
                const row = rows.find(r => r[col] === val);
                if (row) Object.assign(row, patch);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      if (table === 'molit_transactions') {
        return { upsert: () => Promise.resolve({ error: null, count: 0 }) }; // 이 스위트에서는 rows=0 이라 호출되지 않는다
      }
      throw new Error('_fakeIngestAdmin: 예상 밖 테이블 — ' + table);
    },
  };
}

/** dgk.get·LAWD_CODES 를 스텁으로 갈아치우고 molitIngest.js 를 새로 불러온다(require.cache 관례). */
function _loadMolitIngest(dgkGet) {
  const saved = {
    tx: require.cache[TX_SERVICE_PATH],
    dgk: require.cache[DGK_PATH],
    molit: require.cache[MOLIT_INGEST_PATH],
  };
  require.cache[TX_SERVICE_PATH] = {
    id: TX_SERVICE_PATH, filename: TX_SERVICE_PATH, loaded: true,
    exports: { LAWD_CODES: STUB_LAWD_CODES, LAWD_CODE_TO_NAME: STUB_LAWD_CODE_TO_NAME },
  };
  require.cache[DGK_PATH] = { id: DGK_PATH, filename: DGK_PATH, loaded: true, exports: { get: dgkGet } };
  delete require.cache[MOLIT_INGEST_PATH];
  const mod = require('../jobs/molitIngest');
  return {
    mod,
    restore() {
      if (saved.tx) require.cache[TX_SERVICE_PATH] = saved.tx; else delete require.cache[TX_SERVICE_PATH];
      if (saved.dgk) require.cache[DGK_PATH] = saved.dgk; else delete require.cache[DGK_PATH];
      if (saved.molit) require.cache[MOLIT_INGEST_PATH] = saved.molit; else delete require.cache[MOLIT_INGEST_PATH];
    },
  };
}

async function _run(admin, dgk, opts) {
  const { mod, restore } = _loadMolitIngest(dgk.get);
  try {
    return await mod._retryFailedGaps(admin, opts);
  } finally { restore(); }
}


// ══════════════════════════════════════════════════════════════════════════
// 단언 1 — 기록이 아예 없는 (지역,월)(최신 3개월 밖)이 재시도된다.
// ══════════════════════════════════════════════════════════════════════════
test('retryFailedGaps — molit_ingest_runs 에 행이 아예 없는 (지역,월)(최신 3개월 밖)이 재시도된다 (Plan 119 단언 1)', async () => {
  const LB = 6;
  const yms = _recentYms(LB);
  const holeYms = yms.slice(3); // 3개
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin([]); // 완전 빈 molit_ingest_runs
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });

  assert.equal(result.gaps, 0, '기존 오류 기반 갭이 없어야 한다(이 테스트는 순수 구멍 시나리오)');
  assert.equal(result.holes, 3 * holeYms.length, `구멍 후보 총수가 3지역×${holeYms.length}개월 이 아니다`);
  assert.equal(result.retried, result.holes);
  assert.equal(result.filled, result.holes, 'dgk 스텁은 항상 성공이라 전부 filled 여야 한다');

  const calledPairs = new Set(dgk.calls.map(c => `${c.lawdCd}|${c.dealYm}`));
  for (const code of Object.values(STUB_LAWD_CODES)) {
    for (const ym of holeYms) {
      assert.ok(calledPairs.has(`${code}|${ym}`), `구멍 후보 ${code}|${ym} 이 재시도되지 않았다`);
    }
  }
});


// ══════════════════════════════════════════════════════════════════════════
// 단언 2 — archived 만 있는 조합은 구멍이 아니다.
// ══════════════════════════════════════════════════════════════════════════
test('retryFailedGaps — archived 상태만 있는 조합은 구멍 후보에서 빠진다 (Plan 119 단언 2)', async () => {
  const LB = 6;
  const yms = _recentYms(LB);
  const holeYms = yms.slice(3);
  const h0 = holeYms[0]; // 최신 구멍-대상 월
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin([
    { id: 1, lawd_cd: STUB_LAWD_CODES['A동'], deal_ym: h0, status: 'archived' },
  ]);
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });

  assert.equal(result.holes, 3 * holeYms.length - 1, 'archived 로 커버된 1건이 후보에서 빠지지 않았다');
  const calledPairs = new Set(dgk.calls.map(c => `${c.lawdCd}|${c.dealYm}`));
  assert.equal(calledPairs.has(`${STUB_LAWD_CODES['A동']}|${h0}`), false, 'archived 조합이 재시도됐다');
  assert.ok(calledPairs.has(`${STUB_LAWD_CODES['A동']}|${holeYms[1]}`), 'archived 가 아닌 나머지 A동 구멍은 재시도돼야 한다');
});


// ══════════════════════════════════════════════════════════════════════════
// 단언 3 — 최신 3개월은 기록이 없어도 구멍 후보가 아니다.
// ══════════════════════════════════════════════════════════════════════════
test('retryFailedGaps — 최신 3개월은 molit_ingest_runs 에 기록이 없어도 구멍 후보가 아니다 (Plan 119 단언 3)', async () => {
  const LB = 4;
  const yms = _recentYms(LB); // [최신, -1, -2, -3]
  const recentExcluded = yms.slice(0, 3); // 최신 3개월 — 구멍 후보가 되면 안 된다
  const holeYms = yms.slice(3); // 나머지(이 lookback 에서는 가장 오래된 1개월만)
  assert.equal(holeYms.length, 1, '테스트 설계 전제(LB=4 → 구멍-대상 1개월) 가 깨졌다');
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin([]); // 완전 빈 molit_ingest_runs
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });

  assert.equal(result.holes, 3 * holeYms.length, `구멍 후보가 최신 3개월 제외 규칙과 다르다(holes=${result.holes})`);
  const calledYms = new Set(dgk.calls.map(c => c.dealYm));
  for (const ym of recentExcluded) {
    assert.equal(calledYms.has(ym), false, `최신 3개월 중 ${ym} 이 구멍 후보로 재시도됐다`);
  }
  for (const code of Object.values(STUB_LAWD_CODES)) {
    assert.equal(dgk.calls.some(c => c.lawdCd === code && c.dealYm === holeYms[0]), true,
      `${code}|${holeYms[0]} 은 구멍-대상 월인데 재시도되지 않았다`);
  }
});


// ══════════════════════════════════════════════════════════════════════════
// 단언 4 — 기존 오류 기반 갭이 구멍보다 먼저 뽑히고, 합계가 maxGaps 를 넘지 않는다.
// ══════════════════════════════════════════════════════════════════════════
test('retryFailedGaps — 기존 오류 기반 갭이 구멍 후보보다 먼저 뽑히고, 총 재시도 수는 maxGaps 를 넘지 않는다 (Plan 119 단언 4)', async () => {
  const LB = 6;
  const yms = _recentYms(LB);
  const holeYms = yms.slice(3); // 3개 → 3지역 × 3개월 = 9 구멍 후보
  const gapLawd = '99999'; // LAWD_CODES(3개 스텁) 밖 코드 — 구멍 후보와 절대 겹치지 않는다
  const gapYm = holeYms[0];
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin([
    { id: 1, lawd_cd: gapLawd, deal_ym: gapYm, status: 'error' }, // 기존 오류 기반 갭 1건
  ]);
  const result = await _run(admin, dgk, { maxGaps: 5, lookbackMonths: LB });

  assert.equal(result.gaps, 1, '기존 오류 기반 갭이 1건으로 잡혀야 한다');
  assert.equal(result.holes, 9, '구멍 후보 총수(자르기 전)는 9여야 한다');
  assert.equal(result.retried, 5, 'maxGaps(5)를 넘지 않아야 한다');
  assert.equal(dgk.calls.length, 5);
  assert.deepEqual(dgk.calls[0], { lawdCd: gapLawd, dealYm: gapYm }, '기존 갭이 구멍보다 먼저 재시도되지 않았다');
  for (let i = 1; i < dgk.calls.length; i++) {
    assert.notEqual(dgk.calls[i].lawdCd, gapLawd, '갭 이후 자리에 같은 갭이 중복 재시도됐다');
  }
});


// ══════════════════════════════════════════════════════════════════════════
// 리뷰 정정(GAP-ALL-2026-09-27) — 오류 기반 갭이 maxGaps 보다 많을 때, maxGaps 로 잘려서
// 이번 회차에 못 뽑힌 나머지 error-only 쌍이 "기록이 아예 없는 구멍"으로 잘못 세어지면 안 된다.
// gapSet 을 gaps(자른 뒤)가 아니라 gapAll(자르기 전 전체)로 만들어야 하는 이유의 회귀 고정.
// ══════════════════════════════════════════════════════════════════════════
test('retryFailedGaps — 오류 기반 갭이 maxGaps 를 넘으면, 잘려서 못 뽑힌 나머지 error-only 쌍은 holes 에 세어지지 않는다 (Plan 119 리뷰 정정)', async () => {
  const LB = 6;
  const yms = _recentYms(LB);
  const [h0, h1, h2] = yms.slice(3); // 구멍-대상 3개월
  const A = STUB_LAWD_CODES['A동'], B = STUB_LAWD_CODES['B동'], C = STUB_LAWD_CODES['C동'];
  const dgk = _dgkStub();
  // A동의 3개월 전부 error 기록만 있다(ok/archived 없음) — "기록이 아예 없는 쌍"이 아니라
  // "이미 오류 기록이 있는 쌍"이다. maxGaps=2 라 이 중 1건(h2)은 이번 회차에 못 뽑힌다.
  const admin = _fakeIngestAdmin([
    { id: 1, lawd_cd: A, deal_ym: h0, status: 'error' },
    { id: 2, lawd_cd: A, deal_ym: h1, status: 'error' },
    { id: 3, lawd_cd: A, deal_ym: h2, status: 'error' },
  ]);
  const result = await _run(admin, dgk, { maxGaps: 2, lookbackMonths: LB });

  assert.equal(result.gaps, 2, 'maxGaps(2)로 잘린 오류 기반 갭 수가 2여야 한다');
  // 진짜 "기록이 아예 없는" 쌍은 B·C 동 3개월씩 = 6개뿐이다. A동 h2(잘려서 못 뽑힌 error-only
  // 쌍)까지 포함해 7이 나오면 GAP-ALL 정정 전 결함(gapSet 이 gaps 로만 만들어짐)이 재현된 것이다.
  assert.equal(result.holes, 6,
    `holes 에 error-only 쌍이 섞였다(결함 재현 시 7) — 실제 ${result.holes}`);
  const calledPairs = new Set(dgk.calls.map(c => `${c.lawdCd}|${c.dealYm}`));
  assert.equal(calledPairs.has(`${A}|${h2}`), false,
    'maxGaps 에 밀린 A동 h2 가 구멍 경로로 다시(중복) 재시도됐다');
});


// ══════════════════════════════════════════════════════════════════════════
// 단언 5 — 내부 구멍이 신설(앞쪽) 구멍보다 먼저, 같은 묶음에서는 최신 달이 먼저.
// ══════════════════════════════════════════════════════════════════════════
test('retryFailedGaps — 내부 구멍이 신설 구멍보다 먼저, 같은 묶음 안에서는 최신 달이 먼저 뽑힌다 (Plan 119 단언 5)', async () => {
  const LB = 6;
  const yms = _recentYms(LB);
  const [h0, h1, h2] = yms.slice(3); // 최신→과거 순 구멍-대상 3개월
  const A = STUB_LAWD_CODES['A동'], B = STUB_LAWD_CODES['B동'], C = STUB_LAWD_CODES['C동'];
  const dgk = _dgkStub();
  // A동은 h0·h2 가 ok(=covered) → 그 사이 h1 이 "내부 구멍". B·C 동은 covered 가 전혀 없어
  // h0/h1/h2 전부 "신설(늦은 편입) 구멍" — 계획서 §2-1 정렬 규칙의 두 버킷을 재현한다.
  const admin = _fakeIngestAdmin([
    { id: 1, lawd_cd: A, deal_ym: h0, status: 'ok' },
    { id: 2, lawd_cd: A, deal_ym: h2, status: 'ok' },
  ]);
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });

  assert.equal(result.gaps, 0);
  assert.equal(result.holes, 7, '내부 구멍 1(A·h1) + 신설 구멍 6(B·C × 3개월) = 7 이어야 한다');
  assert.equal(dgk.calls.length, 7);

  const expectedOrder = [
    { lawdCd: A, dealYm: h1 },                 // ① 내부 구멍 먼저
    { lawdCd: B, dealYm: h0 }, { lawdCd: C, dealYm: h0 }, // ② 신설 구멍 — 최신 달(h0) 먼저
    { lawdCd: B, dealYm: h1 }, { lawdCd: C, dealYm: h1 },
    { lawdCd: B, dealYm: h2 }, { lawdCd: C, dealYm: h2 },
  ];
  assert.deepEqual(dgk.calls, expectedOrder, `실제 재시도 순서: ${JSON.stringify(dgk.calls)}`);
});


// ══════════════════════════════════════════════════════════════════════════
// 단언 6 — covered 조회가 error 를 돌려주면 구멍 재시도 0, 기존 갭 처리는 그대로.
// ══════════════════════════════════════════════════════════════════════════
test('retryFailedGaps — 구멍 후보(covered) 조회가 실패하면 구멍 재시도는 0, 기존 갭 처리는 그대로 계속된다 (Plan 119 단언 6)', async () => {
  const LB = 6;
  const yms = _recentYms(LB);
  const holeYms = yms.slice(3);
  const gapLawd = '99999';
  const gapYm = holeYms[0];
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin([
    { id: 1, lawd_cd: gapLawd, deal_ym: gapYm, status: 'error' },
  ], { coveredShouldFail: true });
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });

  assert.equal(result.holes, 0, 'covered 조회 실패 시 구멍 후보는 0이어야 한다');
  assert.equal(result.gaps, 1, '기존 갭 처리는 covered 조회 실패와 무관하게 그대로여야 한다');
  assert.equal(result.retried, 1);
  assert.equal(result.filled, 1);
  assert.deepEqual(dgk.calls, [{ lawdCd: gapLawd, dealYm: gapYm }], '구멍 재시도가 실제로 0건이 아니다');
});


// ══════════════════════════════════════════════════════════════════════════
// 단언 7 — 반환값 holes 가 자르기 전 후보 총수다.
// ══════════════════════════════════════════════════════════════════════════
test('retryFailedGaps — 반환값 holes 는 maxGaps 로 자르기 전 구멍 후보 총수다 (Plan 119 단언 7)', async () => {
  const LB = 6;
  const yms = _recentYms(LB);
  const holeYms = yms.slice(3); // 3지역 × 3개월 = 9 후보
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin([]);
  const result = await _run(admin, dgk, { maxGaps: 3, lookbackMonths: LB });

  assert.equal(result.holes, 3 * holeYms.length, 'holes 가 maxGaps 로 잘린 값이 아니라 전체 후보 수여야 한다');
  assert.equal(result.retried, 3, 'maxGaps(3) 만큼만 실제로 재시도돼야 한다');
  assert.equal(dgk.calls.length, 3);
});


// ══════════════════════════════════════════════════════════════════════════
// 단언 8 — cron.js 에 gapHoles: 1회, cronStats.js NUM 에 'gapHoles' 1회.
// ══════════════════════════════════════════════════════════════════════════
test('cron.js·cronStats.js — gapHoles 가 recordCronRun 호출부와 NUM 화이트리스트에 정확히 1회씩 있다 (Plan 119 단언 8)', () => {
  const cronSrc = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  const cronStatsSrc = fs.readFileSync(path.join(__dirname, '../services/cronStats.js'), 'utf8');

  assert.equal((cronSrc.match(/gapHoles:/g) || []).length, 1,
    'cron.js 에 gapHoles: 가 정확히 1회 있어야 한다(recordCronRun 호출부)');
  assert.equal((cronStatsSrc.match(/'gapHoles'/g) || []).length, 1,
    "cronStats.js 에 'gapHoles' 가 정확히 1회(NUM 화이트리스트) 있어야 한다");

  const { _pick } = require('../services/cronStats');
  assert.deepEqual(_pick({ gapHoles: 5 }), { gapHoles: 5 }, '_pick 이 gapHoles 숫자를 통과시키지 않는다');
  assert.deepEqual(_pick({ gapHoles: 0 }), { gapHoles: 0 });
});


// ══════════════════════════════════════════════════════════════════════════
// LIVE-TAIL-2026-10-02 (Plan 130) — 표준 창보다 오래됐지만 아직 자르지 않은 원본 달의 구멍.
//   실사례: 202506 의 신설 코드 7곳이 채워지기 전에 2026-10-01 로 달이 넘어가 탐지 창(16개월) 밖으로
//   밀렸다 → gapHoles 0 인데 창 자르기 사전 점검 P5 = 7. 아래 테스트는 "꼬리 달" 판정을 고정한다.
//   공통 설정: LB=6 → 표준 구멍-대상 달 3개(yms[3..5]), 꼬리 후보는 그보다 오래된 달(tail[0] 이 가장 최신).
// ══════════════════════════════════════════════════════════════════════════
function _tailSetup(LB) {
  const { mod, restore } = _loadMolitIngest(() => Promise.resolve({ data: {} }));
  const maxTail = mod._LIVE_TAIL_MAX_MONTHS;
  restore();
  const all = _recentYms(LB + maxTail);
  return { holeYms: all.slice(3, LB), tail: all.slice(LB), maxTail };
}
/** 표준 창의 구멍-대상 달을 3지역 모두 ok 로 채운 기록(표준 창 구멍 0 — 꼬리 달만 보려는 것). */
function _coverStandard(holeYms, startId = 1) {
  const rows = [];
  let id = startId;
  for (const code of Object.values(STUB_LAWD_CODES)) for (const ym of holeYms) rows.push({ id: id++, lawd_cd: code, deal_ym: ym, status: 'ok' });
  return rows;
}

test('retryFailedGaps — 표준 창 밖이어도 아직 자르지 않은 달(ok 있음·archived 0)의 구멍은 재시도된다 (Plan 130)', async () => {
  const LB = 6;
  const { holeYms, tail } = _tailSetup(LB);
  const A = STUB_LAWD_CODES['A동'], B = STUB_LAWD_CODES['B동'], C = STUB_LAWD_CODES['C동'];
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin([
    ..._coverStandard(holeYms),
    { id: 101, lawd_cd: A, deal_ym: tail[0], status: 'ok' },
    { id: 102, lawd_cd: B, deal_ym: tail[0], status: 'ok' },
  ]);
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });

  assert.equal(result.holes, 1, `꼬리 달의 C동 1건만 구멍이어야 한다(실제 ${result.holes})`);
  assert.deepEqual(dgk.calls, [{ lawdCd: C, dealYm: tail[0] }], `실제 재시도: ${JSON.stringify(dgk.calls)}`);
  assert.equal(result.filled, 1);
});

test('retryFailedGaps — 이미 자른 달(archived 기록이 하나라도 있음)은 표준 창 밖에서 구멍 후보가 아니다 (Plan 130)', async () => {
  const LB = 6;
  const { holeYms, tail } = _tailSetup(LB);
  const A = STUB_LAWD_CODES['A동'], B = STUB_LAWD_CODES['B동'];
  for (const statuses of [['archived', 'archived'], ['ok', 'archived']]) {
    const dgk = _dgkStub();
    const admin = _fakeIngestAdmin([
      ..._coverStandard(holeYms),
      { id: 101, lawd_cd: A, deal_ym: tail[0], status: statuses[0] },
      { id: 102, lawd_cd: B, deal_ym: tail[0], status: statuses[1] },
    ]);
    const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });
    assert.equal(result.holes, 0, `자른 달(${statuses.join('+')})이 구멍 후보가 됐다 — 자른 달을 원본에 다시 적재하게 된다`);
    assert.equal(dgk.calls.length, 0);
  }
});

test('retryFailedGaps — 표준 창 밖에서 기록이 전혀 없는 달은 구멍 후보가 아니다 (Plan 130)', async () => {
  const LB = 6;
  const { holeYms } = _tailSetup(LB);
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin(_coverStandard(holeYms)); // 꼬리 달 기록 0
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });
  assert.equal(result.holes, 0, '한 번도 적재한 적 없는 과거 달까지 구멍으로 세면 원본 창 밖 과거를 끝없이 적재한다');
  assert.equal(dgk.calls.length, 0);
});

test('retryFailedGaps — 꼬리는 최신 쪽부터 이어지는 동안만: 자른 달보다 과거의 달은 ok 가 있어도 제외 (Plan 130)', async () => {
  const LB = 6;
  const { holeYms, tail } = _tailSetup(LB);
  const A = STUB_LAWD_CODES['A동'];
  const dgk = _dgkStub();
  const admin = _fakeIngestAdmin([
    ..._coverStandard(holeYms),
    { id: 101, lawd_cd: A, deal_ym: tail[0], status: 'archived' }, // 자른 달
    { id: 102, lawd_cd: A, deal_ym: tail[1], status: 'ok' },       // 그보다 과거 — 원본에 없다
  ]);
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });
  assert.equal(result.holes, 0);
  assert.equal(dgk.calls.length, 0);
});

test('retryFailedGaps — 자르기가 밀려 꼬리가 2개월이면 둘 다 탐지하고, 표준 창의 구멍이 꼬리보다 먼저 뽑힌다 (Plan 130)', async () => {
  const LB = 6;
  const { holeYms, tail } = _tailSetup(LB);
  const A = STUB_LAWD_CODES['A동'], B = STUB_LAWD_CODES['B동'], C = STUB_LAWD_CODES['C동'];
  const dgk = _dgkStub();
  // 표준 창: C동의 가장 오래된 달 1건만 비워 둔다(신설 구멍). 꼬리 2개월: A동만 ok → B·C 가 구멍.
  const standard = _coverStandard(holeYms).filter(r => !(r.lawd_cd === C && r.deal_ym === holeYms[holeYms.length - 1]));
  const admin = _fakeIngestAdmin([
    ...standard,
    { id: 101, lawd_cd: A, deal_ym: tail[0], status: 'ok' },
    { id: 102, lawd_cd: A, deal_ym: tail[1], status: 'ok' },
  ]);
  const result = await _run(admin, dgk, { maxGaps: 15, lookbackMonths: LB });
  assert.equal(result.holes, 5, `표준 창 1 + 꼬리 2개월 × 2지역 = 5 (실제 ${result.holes})`);
  // B동은 표준 창에 기록이 있고 꼬리 달은 그 범위 밖(더 과거)이라 신설 구멍, C동도 범위 밖 → 전부 같은 묶음, 최신 달 먼저.
  assert.deepEqual(dgk.calls, [
    { lawdCd: C, dealYm: holeYms[holeYms.length - 1] },
    { lawdCd: B, dealYm: tail[0] }, { lawdCd: C, dealYm: tail[0] },
    { lawdCd: B, dealYm: tail[1] }, { lawdCd: C, dealYm: tail[1] },
  ], `실제 재시도 순서: ${JSON.stringify(dgk.calls)}`);
});

test('pickLiveTailYms — 상한(LIVE_TAIL_MAX_MONTHS)과 판정 규칙 (Plan 130)', () => {
  const { mod, restore } = _loadMolitIngest(() => Promise.resolve({ data: {} }));
  try {
    const pick = mod._pickLiveTailYms;
    assert.equal(mod._LIVE_TAIL_MAX_MONTHS, 6);
    const ok = (ym) => ({ lawd_cd: '11111', deal_ym: ym, status: 'ok' });
    const ar = (ym) => ({ lawd_cd: '11111', deal_ym: ym, status: 'archived' });
    assert.deepEqual(pick(['202506', '202505'], [ok('202506'), ar('202505')]), ['202506']);
    assert.deepEqual(pick(['202506', '202505'], [ok('202506'), ok('202505')]), ['202506', '202505']);
    assert.deepEqual(pick(['202506', '202505'], [ar('202506'), ok('202505')]), []);
    assert.deepEqual(pick(['202506', '202505'], [ok('202505')]), []);
    assert.deepEqual(pick([], [ok('202506')]), []);
  } finally { restore(); }
});
