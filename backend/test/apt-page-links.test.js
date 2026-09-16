/**
 * 공개 단지 페이지 — "같은 동 다른 단지" 내부 링크 카드 (Plan 084, 2026-09-16)
 *
 * 배경: `/apt/:aptSeq` 페이지 하단은 지역 허브(/region/…)·지도 딥링크뿐이라 16k개 단지
 *   페이지끼리 서로를 가리키지 않는다. molit_apt_index(이미 쓰고 있는 MV)를 같은
 *   lawd_cd·umd_nm 로 한 번 더 읽어 "같은 동 다른 단지" 카드를 붙인다 — 외부 API 호출 0.
 *
 * ⚠ 절대 제약(운영자 방침): 외부 API 호출 0. schoolService/geocodeCacheService 는 이 카드와
 *   무관하지만 라우트 핸들러가 여전히 require() 하므로 apt-page-enrich.test.js 와 동일하게
 *   캐시 전용 stub 을 채워 넣는다(Kakao 재호출 경로가 실수로 열리면 즉시 예외로 드러나게 한다).
 *
 * 주의(운영자 지시): 이 저장소의 단일 테스트 파일(characterization.test.js)은 건드리지 않는다.
 *   apt-page-enrich.test.js 의 require.cache 스텁 관례를 이 파일 안에서 독립적으로 재구현한다
 *   (헬퍼 import 없음 — aptPage.js 라우트 핸들러가 db/client 등을 호출 시점에 require() 하기
 *   때문에 가능한 패턴).
 *
 * 실행: cd backend && npm test   (node:test 내장 러너 — 의존성 0)
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// apt-page-enrich.test.js 와 동일한 이유로 필요하다: aptPage.js 의 loadAptFacts() 가
// require('../services/priceRecordsService') 를 호출하는데, 그 모듈이 top-level 에서
// transactionService.LAWD_CODES 를 즉시 소비한다. 아래에서 transactionService 를 stub 으로
// 치환하기 전에 실제 모듈을 한 번 로드해 require 캐시에 "완성된 채로" 남긴다.
require('../services/priceRecordsService');

// ── 최소 mock 인프라 (자기 완결형) ──────────────────────────────────────────────
// apt_master 등 일반 테이블 — select/eq/limit 체인만 있으면 충분(같은 동 조회와는 무관).
function _mockPlainTable(rows, error) {
  const s = {
    select() { return s; },
    eq() { return s; },
    is() { return s; },
    limit() { return s; },
    then(resolve) {
      if (error) return resolve({ data: null, error });
      resolve({ data: rows, error: null });
    },
  };
  return s;
}

// molit_apt_index 는 이 라우트 안에서 두 가지 다른 조회에 쓰인다:
//   ① loadIndexRow: select(...).eq('apt_seq', seq).limit(1) — order() 없음
//   ② sameDongApts(신규, Plan 084): select(...).eq('lawd_cd',…).eq('umd_nm',…).order(…).limit(…)
// order() 호출 여부로 두 조회를 구분해 서로 다른 fixture 를 돌려준다. order() 호출 횟수를
// callTracker 에 남겨 "조회 자체를 안 함" 케이스(테스트 3)를 검증한다.
function _mockIndexTable(idxRow, sameDong, callTracker) {
  let isSameDong = false;
  const s = {
    select() { return s; },
    eq() { return s; },
    order() { isSameDong = true; callTracker.sameDongQueries += 1; return s; },
    limit() { return s; },
    then(resolve) {
      if (isSameDong) {
        const err = (sameDong && sameDong.error) || null;
        if (err) return resolve({ data: null, error: err });
        return resolve({ data: (sameDong && sameDong.rows) || [], error: null });
      }
      return resolve({ data: idxRow ? [idxRow] : [], error: null });
    },
  };
  return s;
}

function _mockAdmin({ idxRow, sameDong, aptMasterRows, aptMasterError }, callTracker) {
  return {
    from(t) {
      if (t === 'molit_apt_index') return _mockIndexTable(idxRow, sameDong, callTracker);
      if (t === 'apt_master') return _mockPlainTable(aptMasterRows || [], aptMasterError || null);
      return _mockPlainTable([], null);
    },
  };
}

function _mockRes() {
  const r = { headers: {}, statusCode: 200, body: null };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.type = () => r;
  r.send = (b) => { r.body = b; return r; };
  return r;
}

const _STAT = {
  dealCount: 5, avgPriceAuk: '12.3', medianPrice: 123000, minPrice: 110000, maxPrice: 135000,
  recentDeal: '2026-08-01', trimmedAvgPrice: 122000, pyeongStats: [], rawList: [], floorAdjustmentNote: '',
};

/**
 * 라우트 핸들러를 stub 된 db/client·transactionService·schoolService·geocodeCacheService 로 실행한다.
 * idxRow: molit_apt_index 의 정체성 행(loadIndexRow 가 돌려줄 값) — apt_seq 는 요청 파라미터로도 쓴다.
 * sameDong: { rows, error } — sameDongApts 의 molit_apt_index 조회가 돌려줄 값(order() 호출 시에만).
 * statFixture: 있으면 거래 있음(thin=false), 없으면 거래 없음(thin=true).
 */
async function _run({ idxRow, sameDong, aptMasterRows, aptMasterError, statFixture }) {
  const dbPath = require.resolve('../db/client');
  const svcPath = require.resolve('../services/transactionService');
  const schoolPath = require.resolve('../services/schoolService');
  const geoPath = require.resolve('../services/geocodeCacheService');
  const saved = {
    db: require.cache[dbPath], svc: require.cache[svcPath],
    school: require.cache[schoolPath], geo: require.cache[geoPath],
  };
  const callTracker = { sameDongQueries: 0 };
  const admin = _mockAdmin({ idxRow, sameDong, aptMasterRows, aptMasterError }, callTracker);
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => admin } };
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: {
    getTransactionsByAptSeq: async () => (statFixture ? [{ _fixture: true }] : []),
    analyzeTransactions: () => (statFixture ? [statFixture] : []),
  } };
  require.cache[schoolPath] = { id: schoolPath, filename: schoolPath, loaded: true, exports: {
    getCachedSchoolsBatch: async (apts) => apts.map(() => undefined),
    resolveSchools: async () => { throw new Error('APT-PAGE-LINKS-TEST: resolveSchools 가 호출됐다 — Kakao 호출 경로'); },
    kakaoSearchSchools: async () => { throw new Error('APT-PAGE-LINKS-TEST: kakaoSearchSchools 가 호출됐다 — Kakao 호출 경로'); },
  } };
  require.cache[geoPath] = { id: geoPath, filename: geoPath, loaded: true, exports: {
    resolveCoordFromCacheOnly: async () => null,
    resolveCoord: async () => { throw new Error('APT-PAGE-LINKS-TEST: resolveCoord 가 호출됐다 — Kakao 호출 경로'); },
  } };
  try {
    const router = require('../routes/aptPage');
    const layer = router.stack.find((l) => l.route && l.route.path === '/:aptSeq');
    const handle = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = _mockRes();
    await handle({ params: { aptSeq: (idxRow && idxRow.apt_seq) || '11680-9001' } }, res, () => {});
    return { res, callTracker };
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
    if (saved.school) require.cache[schoolPath] = saved.school; else delete require.cache[schoolPath];
    if (saved.geo) require.cache[geoPath] = saved.geo; else delete require.cache[geoPath];
  }
}

function _aptLinkCount(html) {
  return (html.match(/href="\/apt\//g) || []).length;
}

// 자기 자신(11680-9001) + 형식 불량(bad-seq) 을 섞은 10행 — 필터 후 정확히 8개가 남아야 한다.
const _TEN_ROWS = [
  { apt_seq: '11680-9001', apt_name: '자기자신아파트', umd_nm: '대치동', deal_count: 50 },
  { apt_seq: 'bad-seq', apt_name: '형식불량아파트', umd_nm: '대치동', deal_count: 45 },
  { apt_seq: '11680-1001', apt_name: '동네1차', umd_nm: '대치동', deal_count: 40 },
  { apt_seq: '11680-1002', apt_name: '동네2차', umd_nm: '대치동', deal_count: 35 },
  { apt_seq: '11680-1003', apt_name: '동네3차', umd_nm: '대치동', deal_count: 30 },
  { apt_seq: '11680-1004', apt_name: '동네4차', umd_nm: '대치동', deal_count: 25 },
  { apt_seq: '11680-1005', apt_name: '동네5차', umd_nm: '대치동', deal_count: 20 },
  { apt_seq: '11680-1006', apt_name: '동네6차', umd_nm: '대치동', deal_count: 15 },
  { apt_seq: '11680-1007', apt_name: '동네7차', umd_nm: '대치동', deal_count: 10 },
  { apt_seq: '11680-1008', apt_name: '동네8차', umd_nm: '대치동', deal_count: 5 },
];

// ── ① 정상 조회: 카드 렌더 + 링크 정확히 8개 + 자기/불량 seq 제외 + s-maxage 캐시 ──────
test('APT-PAGE-LINKS — 같은 동 조회 정상: 카드에 /apt/ 링크가 정확히 8개, 자기·형식불량 seq 는 제외되고 캐시는 s-maxage', async () => {
  const idxRow = { apt_seq: '11680-9001', apt_name: '대치동단지', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1999, recent_deal_date: '2026-08-01', deal_count: 5 };
  const { res, callTracker } = await _run({
    idxRow, sameDong: { rows: _TEN_ROWS }, aptMasterRows: [], statFixture: _STAT,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('같은 동 다른 단지'), '같은 동 다른 단지 카드가 없다');
  assert.equal(_aptLinkCount(res.body), 8, '/apt/ 링크 개수가 정확히 8개가 아니다');
  assert.ok(!res.body.includes('href="/apt/11680-9001"'), '자기 자신 seq 로의 링크가 있으면 안 된다');
  assert.ok(!res.body.includes('href="/apt/bad-seq"'), '형식 불량 seq 로의 링크가 있으면 안 된다');
  assert.ok(callTracker.sameDongQueries >= 1, '같은 동 조회가 실제로 실행돼야 한다');
  assert.match(res.headers['Cache-Control'], /s-maxage/, '정상 조회면 s-maxage 캐시가 붙어야 한다');
});

// ── ② 조회 오류: 카드 없음 + no-store (Step 2 의 `|| sameDongErrored` 회귀 감지용) ──────
test('APT-PAGE-LINKS — 같은 동 조회가 오류를 돌려주면: 카드가 없고 Cache-Control 은 no-store', async () => {
  const idxRow = { apt_seq: '11680-9001', apt_name: '대치동단지', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1999, recent_deal_date: '2026-08-01', deal_count: 5 };
  const { res } = await _run({
    idxRow, sameDong: { error: { message: 'molit_apt_index 조회 실패(주입)' } }, aptMasterRows: [], statFixture: _STAT,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('같은 동 다른 단지'), '조회 오류인데 카드가 렌더됐다');
  assert.equal(res.headers['Cache-Control'], 'no-store', '조회 오류면 no-store 여야 한다(긴 캐시 금지)');
});

// ── ③ umd 없음: 조회 자체를 하지 않는다(호출 카운트 0) + 카드 없음 ──────────────────
test('APT-PAGE-LINKS — umd(umd_nm) 가 없으면 같은 동 조회를 아예 하지 않고 카드도 없다', async () => {
  const idxRow = { apt_seq: '11680-9001', apt_name: '동정보없음단지', lawd_cd: '11680', sigungu: '강남구', umd_nm: '', build_year: 1999, recent_deal_date: '2026-08-01', deal_count: 5 };
  const { res, callTracker } = await _run({
    idxRow, sameDong: { rows: _TEN_ROWS }, aptMasterRows: [], statFixture: _STAT,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(callTracker.sameDongQueries, 0, 'umd 가 없으면 molit_apt_index 조회(order 체인)가 0회여야 한다');
  assert.ok(!res.body.includes('같은 동 다른 단지'), 'umd 없이도 카드가 렌더되면 안 된다');
});
