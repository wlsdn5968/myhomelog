/**
 * 공개 단지 페이지 — 학교·주소·구조 + desc 출처 문구 (Plan 069, 2026-09-06)
 *
 * 배경: Plan 063/065/068 이 공개 단지 페이지(backend/routes/aptPage.js)에 K-apt 단지정보
 *   카드를 붙였다. 이 계획은 그 위에 (1) desc 출처 문구를 "KAPT 사실 포함 여부"에 맞게
 *   정확화하고 (2) 구조·주소 행을 추가하고 (3) 이미 캐시된(비용 0) 학교 데이터로 "주변 학교"
 *   카드를 붙이고 (4) 캐시된 좌표가 있을 때만 "지도에서 보기" 딥링크를 단다.
 *
 * ⚠ 절대 제약(운영자 방침): 외부 API 호출 0. resolveSchools·kakaoSearchSchools·resolveCoord
 *   (캐시 미스 시 Kakao 재호출)는 이 파일이 테스트하는 소스에서 절대 참조되면 안 된다 —
 *   캐시 전용 함수(getCachedSchoolsBatch·resolveCoordFromCacheOnly)만 허용된다. 공개 페이지는
 *   봇 트래픽이 많아 이 경로로 유료 API 가 새면 비용이 무한정 늘어난다.
 *
 * 주의(운영자 지시): 이 저장소의 단일 테스트 파일(characterization.test.js)은 현재 분할
 *   작업 중이라 건드리지 않는다 — 이 신규 파일 안에서 독립적으로 완결한다(헬퍼도 import 하지
 *   않는다). require.cache 스텁 관례는 그 파일에서 이미 검증된 패턴을 이 파일 안에서 별도로
 *   재구현한 것이다(aptPage.js 의 라우트 핸들러가 db/client·transactionService·schoolService·
 *   geocodeCacheService 를 호출 시점에 그때그때 require() 하기 때문에 가능).
 *
 * 실행: cd backend && npm test   (node:test 내장 러너 — 의존성 0)
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// aptPage.js 의 loadAptFacts() 가 require('../services/priceRecordsService') 를 호출한다.
// 그 모듈은 top-level 에서 `Object.fromEntries(Object.entries(LAWD_CODES)...)` 로 transactionService
// 의 LAWD_CODES 를 즉시 소비하는데, 아래 _run() 이 transactionService 를 최소 stub 으로 치환한다
// (LAWD_CODES 없음). 이 파일을 단독 실행(node --test 이 파일만)하면 priceRecordsService 가 stub
// 이후 처음 로드돼 죽는다 — stub 을 걸기 전에 실제 모듈로 한 번 미리 로드해 require 캐시에
// "완성된 채로" 남긴다(이후 loadAptFacts 의 require 는 이 캐시를 그대로 재사용, top-level 재실행 없음).
require('../services/priceRecordsService');

// ── 최소 mock 인프라 (자기 완결형) ──────────────────────────────────────────────
function _mockTable(rows, error) {
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
function _mockAdmin(tables, errorTables) {
  return {
    from(t) {
      const rows = (tables && tables[t]) || [];
      const err = (errorTables && errorTables[t]) || null;
      return _mockTable(rows, err);
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
// idx(molit_apt_index) 가 정체성(aptName·lawdCd·umdNm·sigungu)을 준다.
function _idx(aptName) {
  return { apt_seq: '11680-9001', apt_name: aptName, lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1999, recent_deal_date: '2026-08-01', deal_count: 5 };
}
const _STAT = {
  dealCount: 5, avgPriceAuk: '12.3', medianPrice: 123000, minPrice: 110000, maxPrice: 135000,
  recentDeal: '2026-08-01', trimmedAvgPrice: 122000, pyeongStats: [], rawList: [], floorAdjustmentNote: '',
};

/**
 * 라우트 핸들러를 stub 된 db/client·transactionService·schoolService·geocodeCacheService 로 실행한다.
 * schoolsResult: getCachedSchoolsBatch([apt]) 가 돌려줄 apt 1건분 값 — undefined(캐시 미스)·
 *   []( 확인된 학교 없음)·[{name,type,distance_m}] 중 하나.
 * coordResult: resolveCoordFromCacheOnly(apt) 가 돌려줄 값 — null 또는 {lat,lng}.
 * schoolsThrow·coordThrow: true 면 해당 함수가 예외를 던진다(오류 주입).
 * calls: 각 캐시 전용 함수 호출 횟수·인자를 기록해 반환(왕복 수·키 조합 검증용).
 */
async function _run({
  aptMasterRows, aptMasterError, idxRow, statFixture,
  schoolsResult, schoolsThrow, coordResult, coordThrow,
}) {
  const dbPath = require.resolve('../db/client');
  const svcPath = require.resolve('../services/transactionService');
  const schoolPath = require.resolve('../services/schoolService');
  const geoPath = require.resolve('../services/geocodeCacheService');
  const saved = {
    db: require.cache[dbPath], svc: require.cache[svcPath],
    school: require.cache[schoolPath], geo: require.cache[geoPath],
  };
  const admin = _mockAdmin(
    { molit_apt_index: idxRow ? [idxRow] : [], apt_master: aptMasterRows || [] },
    aptMasterError ? { apt_master: aptMasterError } : null,
  );
  const calls = { schools: [], coord: [] };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => admin } };
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: {
    getTransactionsByAptSeq: async () => (statFixture ? [{ _fixture: true }] : []),
    analyzeTransactions: () => (statFixture ? [statFixture] : []),
  } };
  require.cache[schoolPath] = { id: schoolPath, filename: schoolPath, loaded: true, exports: {
    getCachedSchoolsBatch: async (apts) => {
      calls.schools.push(apts);
      if (schoolsThrow) throw new Error('APT-PAGE-ENRICH-TEST 학교 조회 주입 오류');
      return apts.map(() => schoolsResult);
    },
    // 참조되면 안 되는 함수 — 호출되면 "외부 API 호출 0" 위반이 눈에 띄도록 예외를 던진다.
    resolveSchools: async () => { throw new Error('APT-PAGE-ENRICH-TEST: resolveSchools 가 호출됐다 — Kakao 호출 경로'); },
    kakaoSearchSchools: async () => { throw new Error('APT-PAGE-ENRICH-TEST: kakaoSearchSchools 가 호출됐다 — Kakao 호출 경로'); },
  } };
  require.cache[geoPath] = { id: geoPath, filename: geoPath, loaded: true, exports: {
    resolveCoordFromCacheOnly: async (apt) => {
      calls.coord.push(apt);
      if (coordThrow) throw new Error('APT-PAGE-ENRICH-TEST 좌표 조회 주입 오류');
      return coordResult || null;
    },
    resolveCoord: async () => { throw new Error('APT-PAGE-ENRICH-TEST: resolveCoord 가 호출됐다 — Kakao 호출 경로'); },
  } };
  try {
    const router = require('../routes/aptPage');
    const layer = router.stack.find((l) => l.route && l.route.path === '/:aptSeq');
    const handle = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = _mockRes();
    await handle({ params: { aptSeq: '11680-9001' } }, res, () => {});
    return { res, calls };
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
    if (saved.school) require.cache[schoolPath] = saved.school; else delete require.cache[schoolPath];
    if (saved.geo) require.cache[geoPath] = saved.geo; else delete require.cache[geoPath];
  }
}

function _descOf(res) {
  const m = res.body.match(/<meta name="description" content="([^"]*)">/);
  assert.ok(m, 'description 메타가 없다');
  return m[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&middot;|·/g, '·');
}

// ── ① 학교 캐시 있음 → 카드 렌더, 초·중·고 순 ────────────────────────────────
test('APT-PAGE-ENRICH — 학교 캐시 있음: 주변 학교 카드가 초·중·고 순으로 렌더된다', async () => {
  const row = { kapt_code: 'E001', apt_name: '학교단지', molit_aliases: ['학교단지'], facility: { kaptdaCnt: '500' } };
  // 입력 순서를 일부러 초·고·중 으로 섞어 재정렬 로직을 실제로 검증한다.
  const schoolsResult = [
    { name: '대치고등학교', type: '고', distance_m: 900 },
    { name: '대치초등학교', type: '초', distance_m: 320 },
    { name: '대치중학교', type: '중', distance_m: 550 },
  ];
  const { res, calls } = await _run({
    aptMasterRows: [row], idxRow: _idx('학교단지'), statFixture: _STAT, schoolsResult,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('주변 학교'), '주변 학교 카드가 없다');
  assert.ok(res.body.includes('대치초등학교') && res.body.includes('320m'), '초등학교 이름·거리가 없다');
  assert.ok(res.body.includes('대치중학교') && res.body.includes('550m'), '중학교 이름·거리가 없다');
  assert.ok(res.body.includes('대치고등학교') && res.body.includes('900m'), '고등학교 이름·거리가 없다');
  const iElem = res.body.indexOf('대치초등학교');
  const iMid = res.body.indexOf('대치중학교');
  const iHigh = res.body.indexOf('대치고등학교');
  assert.ok(iElem < iMid && iMid < iHigh, `초·중·고 순서가 아니다 (초=${iElem}, 중=${iMid}, 고=${iHigh})`);
  // 캐시 전용 함수는 063 이 확정한 row(kapt_code/apt_name)로만 키를 만든다.
  assert.equal(calls.schools.length, 1, '학교 조회가 정확히 1회가 아니다(왕복 예산 위반)');
  assert.equal(calls.schools[0][0].kaptCode, 'E001');
  assert.equal(calls.schools[0][0].aptName, '학교단지');
});

// ── ② 캐시 없음 → 카드 없음 ─────────────────────────────────────────────────
test('APT-PAGE-ENRICH — 학교 캐시 미스(undefined): 주변 학교 카드가 없다("학교" 문자열 없음)', async () => {
  const row = { kapt_code: 'E002', apt_name: '캐시미스단지', molit_aliases: ['캐시미스단지'], facility: { kaptdaCnt: '500' } };
  const { res } = await _run({
    aptMasterRows: [row], idxRow: _idx('캐시미스단지'), statFixture: _STAT, schoolsResult: undefined,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('학교'), '캐시 미스인데 "학교" 문자열이 나왔다 — 없는 데이터로 카드를 만들었다');
});

test('APT-PAGE-ENRICH — 학교 캐시가 "확인된 없음"([]): 주변 학교 카드가 없다', async () => {
  // ⚠ 단지명 자체에 "학교"가 들어가면 !res.body.includes('학교') 단언이 자기충돌한다
  //   ([[test-marker-self-collision]]) — 무관한 이름을 쓴다.
  const row = { kapt_code: 'E003', apt_name: '무결과단지', molit_aliases: ['무결과단지'], facility: { kaptdaCnt: '500' } };
  const { res } = await _run({
    aptMasterRows: [row], idxRow: _idx('무결과단지'), statFixture: _STAT, schoolsResult: [],
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('학교'), '학교가 확인된 0건인데 카드가 나왔다');
});

// ── ③ 학교/좌표 조회 오류 → 긴 캐시 안 붙음 ──────────────────────────────────
test('APT-PAGE-ENRICH — 학교 조회가 오류로 실패하면 긴 캐시를 붙이지 않는다', async () => {
  const row = { kapt_code: 'E004', apt_name: '학교오류단지', molit_aliases: ['학교오류단지'], facility: { kaptdaCnt: '500' } };
  const { res } = await _run({
    aptMasterRows: [row], idxRow: _idx('학교오류단지'), statFixture: _STAT, schoolsThrow: true,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store', '학교 조회 오류인데 긴 캐시가 붙었다');
  assert.ok(!res.body.includes('주변 학교'), '조회가 실패했는데 학교 카드가 나왔다');
  // thin·noindex 판정은 거래 유무 그대로 — 캐시 판정과 섞이면 안 된다.
  assert.ok(res.body.includes('<meta name="robots" content="index, follow">'),
    '거래가 있는데(thin=false) noindex 로 바뀌었다 — 캐시 판정과 색인 판정이 섞였다');
});

test('APT-PAGE-ENRICH — 좌표 조회가 오류로 실패하면 긴 캐시를 붙이지 않는다', async () => {
  const row = { kapt_code: 'E005', apt_name: '좌표오류단지', molit_aliases: ['좌표오류단지'], facility: { kaptdaCnt: '500' } };
  const { res } = await _run({
    aptMasterRows: [row], idxRow: _idx('좌표오류단지'), statFixture: _STAT, coordThrow: true,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store', '좌표 조회 오류인데 긴 캐시가 붙었다');
  assert.ok(!res.body.includes('지도에서 보기'), '조회가 실패했는데 지도 링크가 나왔다');
});

// ── ④ 좌표 없음 → "지도에서 보기" 없음 (있음 → 링크 있음, 양성 대조) ─────────
test('APT-PAGE-ENRICH — 좌표 캐시 없음(null): "지도에서 보기" 링크가 없다', async () => {
  const row = { kapt_code: 'E006', apt_name: '좌표없는단지', molit_aliases: ['좌표없는단지'], facility: { kaptdaCnt: '500' } };
  const { res } = await _run({
    aptMasterRows: [row], idxRow: _idx('좌표없는단지'), statFixture: _STAT, coordResult: null,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('지도에서 보기'), '좌표가 없는데 지도 링크가 나왔다');
});

test('APT-PAGE-ENRICH — 좌표 캐시 있음: "지도에서 보기" 딥링크가 apt·area 규약으로 붙는다', async () => {
  const row = { kapt_code: 'E007', apt_name: '좌표있는단지', molit_aliases: ['좌표있는단지'], facility: { kaptdaCnt: '500' } };
  const { res, calls } = await _run({
    aptMasterRows: [row], idxRow: _idx('좌표있는단지'), statFixture: _STAT,
    coordResult: { lat: 37.5012, lng: 127.0396 },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('지도에서 보기'), '좌표가 있는데 지도 링크가 없다');
  // frontend/index.html:8800-8810 handleShareUrl() 이 읽는 ?apt=&area= 규약(같은 형식,
  // backend/routes/share.js:97 이 이미 이 형식으로 공유 링크를 만든다) — 딥링크 임베드 지도는 아니다.
  assert.match(res.body, /href="https:\/\/myhomelog\.vercel\.app\/\?apt=%EC%A2%8C%ED%91%9C%EC%9E%88%EB%8A%94%EB%8B%A8%EC%A7%80&amp;area=/,
    '지도 링크가 ?apt=&area= 규약을 따르지 않는다');
  assert.equal(calls.coord.length, 1, '좌표 조회가 정확히 1회가 아니다(왕복 예산 위반)');
  assert.equal(calls.coord[0].kaptCode, 'E007');
});

// ── row 가 없으면(매칭 불가) 학교·좌표 조회 자체를 하지 않는다 — 유사도 매칭 금지 원칙 ──
test('APT-PAGE-ENRICH — apt_master 매칭이 없으면 학교·좌표 캐시를 아예 조회하지 않는다', async () => {
  const { res, calls } = await _run({
    aptMasterRows: [], idxRow: _idx('매칭없는단지'), statFixture: _STAT,
    schoolsResult: [{ name: '엉뚱초등학교', type: '초', distance_m: 100 }], coordResult: { lat: 37.1, lng: 127.1 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.schools.length, 0, 'row 매칭이 없는데 학교 조회를 했다');
  assert.equal(calls.coord.length, 0, 'row 매칭이 없는데 좌표 조회를 했다');
  assert.ok(!res.body.includes('주변 학교') && !res.body.includes('지도에서 보기'));
});

// ── ⑤ structureType·address 값 없을 때 행 없음 (있을 때 행 있음, 양성 대조) ──
test('APT-PAGE-ENRICH — 구조·주소 값이 있으면 단지정보 카드에 행이 생긴다', async () => {
  const row = {
    kapt_code: 'E008', apt_name: '구조주소단지', molit_aliases: ['구조주소단지'],
    facility: { kaptdaCnt: '500', doroJuso: '서울 강남구 테스트로 1', _dtl: { codeStr: '철근콘크리트구조' } },
  };
  const { res } = await _run({ aptMasterRows: [row], idxRow: _idx('구조주소단지'), statFixture: _STAT });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('<span class="k">구조</span>') && res.body.includes('철근콘크리트구조'), '구조 행이 없다');
  assert.ok(res.body.includes('<span class="k">주소</span>') && res.body.includes('서울 강남구 테스트로 1'), '주소 행이 없다');
});

test('APT-PAGE-ENRICH — 구조·주소 값이 없으면 행 자체가 없다("미상" 금지, 미확인 원칙)', async () => {
  const row = {
    kapt_code: 'E009', apt_name: '구조주소없는단지', molit_aliases: ['구조주소없는단지'],
    facility: { kaptdaCnt: '500' }, // doroJuso/kaptAddr/_dtl 전부 없음
  };
  const { res } = await _run({ aptMasterRows: [row], idxRow: _idx('구조주소없는단지'), statFixture: _STAT });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('<span class="k">구조</span>'), '값이 없는데 구조 행이 생겼다');
  assert.ok(!res.body.includes('<span class="k">주소</span>'), '값이 없는데 주소 행이 생겼다');
  assert.ok(!res.body.includes('미상'));
});

// ── ⑥ desc 출처 문구 — 거래 있음 분기에서 KAPT fact 유무로 갈린다 ───────────
test('APT-PAGE-ENRICH-DESC — 거래 있음 + KAPT fact 있음: desc 출처에 K-apt 가 붙는다', async () => {
  const row = { kapt_code: 'E010', apt_name: '팩트있는단지', molit_aliases: ['팩트있는단지'], facility: { kaptdaCnt: '900' } };
  const { res } = await _run({ aptMasterRows: [row], idxRow: _idx('팩트있는단지'), statFixture: _STAT });
  assert.equal(res.statusCode, 200);
  const desc = _descOf(res);
  assert.ok(desc.includes('국토교통부 실거래·K-apt 단지정보 정리'), 'KAPT fact 가 있는데 출처 문구가 안 바뀌었다: ' + desc);
  assert.ok(desc.includes('900세대'), 'KAPT fact(세대수)가 desc 에서 사라졌다: ' + desc);
  assert.ok(desc.endsWith('매수 추천이 아닙니다.'), '절대 룰 문구가 사라졌다: ' + desc);
});

test('APT-PAGE-ENRICH-DESC — 거래 있음 + KAPT fact 없음: 기존 문구를 그대로 쓴다', async () => {
  // apt_master 매칭 자체가 없어 KAPT fact 가 전혀 없는 경우.
  const { res } = await _run({ aptMasterRows: [], idxRow: _idx('팩트없는단지'), statFixture: _STAT });
  assert.equal(res.statusCode, 200);
  const desc = _descOf(res);
  assert.ok(desc.includes('국토교통부 실거래 신고 자료 정리'), 'KAPT fact 가 없는데 기존 문구가 유지되지 않았다: ' + desc);
  assert.ok(!desc.includes('K-apt 단지정보 정리'), 'KAPT fact 가 없는데 K-apt 출처 문구가 붙었다: ' + desc);
  assert.ok(desc.endsWith('매수 추천이 아닙니다.'), '절대 룰 문구가 사라졌다: ' + desc);
});

test('APT-PAGE-ENRICH-DESC — 거래 0 분기(Plan 065)는 이 계획이 손대지 않는다(회귀 확인용)', async () => {
  const row = { kapt_code: 'E011', apt_name: '거래0단지', molit_aliases: ['거래0단지'], facility: { kaptdaCnt: '900', kaptUsedate: '20010101' } };
  const { res } = await _run({ aptMasterRows: [row], idxRow: _idx('거래0단지'), statFixture: null });
  assert.equal(res.statusCode, 200);
  const desc = _descOf(res);
  assert.ok(desc.includes('최근 24개월 거래 기록이 없습니다'), '거래 0 사실이 desc 에서 사라졌다: ' + desc);
  assert.ok(!desc.includes('국토교통부'), 'Plan 065 가 확정한 "KAPT 출처엔 국토교통부 안 붙임" 규칙이 깨졌다: ' + desc);
  assert.ok(desc.endsWith('매수 추천이 아닙니다.'));
});

// ── ⑦ 소스 계약 — Kakao 호출 함수가 이 파일에서 참조되지 않는다 ─────────────
test('APT-PAGE-ENRICH — 소스 계약: aptPage.js 는 Kakao 호출 함수를 참조하지 않고, 캐시 전용 함수만 쓴다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = fs.readFileSync(path.join(__dirname, '../routes/aptPage.js'), 'utf8');
  // 줄 주석 제거 후 검사 — 주석에 이름이 언급되는 것과 실제 호출을 구분한다.
  const src = raw.split('\n').map((l) => l.replace(/\/\/[^\r\n]*/, '')).join('\n');

  assert.doesNotMatch(src, /\bresolveSchools\(/, 'resolveSchools( 가 참조된다 — Kakao 호출 경로');
  assert.doesNotMatch(src, /\bkakaoSearchSchools\(/, 'kakaoSearchSchools( 가 참조된다 — Kakao 호출 경로');
  // \bresolveCoord\( 는 resolveCoordFromCacheOnly(/resolveCoordBatch( 와 다른 토큰이라 오탐 없다.
  assert.doesNotMatch(src, /\bresolveCoord\(/, 'resolveCoord( 가 참조된다 — Kakao 호출 경로(캐시 미스 시 재호출)');

  // 양성 계약 — 캐시 전용 함수는 실제로 배선돼 있어야 한다(부재로 우연히 통과하는 것 방지).
  assert.match(src, /getCachedSchoolsBatch\(/, 'getCachedSchoolsBatch 가 배선되지 않았다');
  assert.match(src, /resolveCoordFromCacheOnly\(/, 'resolveCoordFromCacheOnly 가 배선되지 않았다');
});
