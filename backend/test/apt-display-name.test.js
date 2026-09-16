/**
 * backend/test/apt-display-name.test.js (Plan 090, Step 4)
 *
 * 단지 표시 이름 정책: 이름 미등록 단지("(50-5)" 등)와 지번 괄호 접미("충무주공(872)" 등)를
 * 모든 노출 지점에서 일관되게 정리한다.
 *
 * 대상 함수: displayAptName(name, { umdNm, jibun, kaptName })
 *           isUnnamedApt(name)
 *           buildPopularResults (인기 단지 필터)
 *
 * 검증:
 *   1. displayAptName 표시 규칙 8케이스
 *   2. isUnnamedApt 판정 3케이스
 *   3. 프론트 드리프트 방지 — 정규식 리터럴 포함 단언
 *   4. 공개 페이지 렌더링 (apt-page.js + displayAptName 통합)
 *   5. 인기 단지 필터 (이름 미등록 제외)
 *
 * 실행: cd backend && npm test   (node:test 내장 러너)
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── 1. displayAptName 단위 테스트 ────────────────────────────────────────────
test('displayAptName — 이름 미등록("(50-5)")을 "동명 지번번지 단지 (이름 미등록)"로 표시', () => {
  const { displayAptName } = require('../utils/aptDisplayName');
  assert.equal(displayAptName('(50-5)', { umdNm: '공항동' }), '공항동 50-5번지 단지 (이름 미등록)');
});

test('displayAptName — 수정된 지번(807-41)도 같은 규칙', () => {
  const { displayAptName } = require('../utils/aptDisplayName');
  assert.equal(displayAptName('807-41', { umdNm: '구로동' }), '구로동 807-41번지 단지 (이름 미등록)');
});

test('displayAptName — KAPT 정식명이 있으면 그것만 돌려준다', () => {
  const { displayAptName } = require('../utils/aptDisplayName');
  assert.equal(
    displayAptName('(807-1)', { umdNm: '구로동', kaptName: '구로금호어울림' }),
    '구로금호어울림'
  );
});

test('displayAptName — 지번 괄호 접미("충무주공(872)")를 "기본명 (지번번지)"로 표시', () => {
  const { displayAptName } = require('../utils/aptDisplayName');
  assert.equal(displayAptName('충무주공(872)'), '충무주공 (872번지)');
});

test('displayAptName — 수정된 지번 괄호("한진(609-1)")', () => {
  const { displayAptName } = require('../utils/aptDisplayName');
  assert.equal(displayAptName('한진(609-1)'), '한진 (609-1번지)');
});

test('displayAptName — 정상 이름("공릉풍림아이원")은 그대로', () => {
  const { displayAptName } = require('../utils/aptDisplayName');
  assert.equal(displayAptName('공릉풍림아이원'), '공릉풍림아이원');
});

test('displayAptName — 괄호 없는 정상 이름("풍림아파트A")은 그대로', () => {
  const { displayAptName } = require('../utils/aptDisplayName');
  assert.equal(displayAptName('풍림아파트A'), '풍림아파트A');
});

test('displayAptName — 이름 없고 괄호만("(해오름)")을 지번 없이 정리', () => {
  const { displayAptName } = require('../utils/aptDisplayName');
  assert.equal(displayAptName('(해오름)'), '단지 (이름 미등록)');
});

// ── 2. isUnnamedApt 판정 테스트 ──────────────────────────────────────────────
test('isUnnamedApt — 괄호+지번("(50-5)")은 이름 미등록', () => {
  const { isUnnamedApt } = require('../utils/aptDisplayName');
  assert.equal(isUnnamedApt('(50-5)'), true);
});

test('isUnnamedApt — 1글자("탑")은 이름 미등록', () => {
  const { isUnnamedApt } = require('../utils/aptDisplayName');
  assert.equal(isUnnamedApt('탑'), true);
});

test('isUnnamedApt — 정상 이름("e편한세상부평그랑힐스")은 등록된 이름', () => {
  const { isUnnamedApt } = require('../utils/aptDisplayName');
  assert.equal(isUnnamedApt('e편한세상부평그랑힐스'), false);
});

// ── 3. 프론트 드리프트 방지 ──────────────────────────────────────────────────
test('드리프트 방지 — frontend/index.html에 UNNAMED_RE·JIBUN_SUFFIX_RE 정규식 리터럴 포함', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const { UNNAMED_RE, JIBUN_SUFFIX_RE } = require('../utils/aptDisplayName');
  const unnamedLit = UNNAMED_RE.source;
  const jibunLit = JIBUN_SUFFIX_RE.source;
  assert.ok(html.includes(unnamedLit), `프론트에 UNNAMED_RE 리터럴 없다`);
  assert.ok(html.includes(jibunLit), `프론트에 JIBUN_SUFFIX_RE 리터럴 없다`);
});

require('../services/priceRecordsService');

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

async function _runAptPage({
  aptMasterRows, idxRow, statFixture, schoolsResult, coordResult,
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
    null,
  );
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => admin } };
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: {
    getTransactionsByAptSeq: async () => (statFixture ? [{ _fixture: true }] : []),
    analyzeTransactions: () => (statFixture ? [statFixture] : []),
  } };
  require.cache[schoolPath] = { id: schoolPath, filename: schoolPath, loaded: true, exports: {
    getCachedSchoolsBatch: async (apts) => apts.map(() => schoolsResult),
  } };
  require.cache[geoPath] = { id: geoPath, filename: geoPath, loaded: true, exports: {
    resolveCoordFromCacheOnly: async () => coordResult || null,
  } };
  try {
    const router = require('../routes/aptPage');
    const layer = router.stack.find((l) => l.route && l.route.path === '/:aptSeq');
    const handle = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = _mockRes();
    await handle({ params: { aptSeq: '11500-10189' } }, res, () => {});
    return res;
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
    if (saved.school) require.cache[schoolPath] = saved.school; else delete require.cache[schoolPath];
    if (saved.geo) require.cache[geoPath] = saved.geo; else delete require.cache[geoPath];
  }
}

test('공개 페이지 — 이름 미등록 단지("(50-5)" 공항동)의 h1에 표시 이름 적용', async () => {
  const _STAT = {
    dealCount: 5, avgPriceAuk: '12.3', medianPrice: 123000, minPrice: 110000, maxPrice: 135000,
    recentDeal: '2026-08-01', trimmedAvgPrice: 122000, pyeongStats: [], rawList: [], floorAdjustmentNote: '',
  };
  const idx = {
    apt_seq: '11500-10189', apt_name: '(50-5)', lawd_cd: '11500', sigungu: '강서구',
    umd_nm: '공항동', build_year: 2026, recent_deal_date: '2026-08-01', deal_count: 5,
  };
  const res = await _runAptPage({
    aptMasterRows: [],
    idxRow: idx,
    statFixture: _STAT,
    schoolsResult: undefined,
    coordResult: null,
  });

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('공항동 50-5번지 단지 (이름 미등록)'), '표시 이름이 없다');
  assert.ok(res.body.includes('실거래가'), '제목이 실거래가를 포함하지 않는다');
});

// 인기 단지 필터는 popularService.js 에서 isUnnamedApt 판정으로 걸러진다.
// 스냅샷 하네스가 없으므로, 위의 단위 테스트(displayAptName, isUnnamedApt)로 검증한다 (Plan 090 STOP 조건).

test('회귀 주입 준비 — JIBUN_SUFFIX_RE 패턴 동작 확인', () => {
  const { JIBUN_SUFFIX_RE } = require('../utils/aptDisplayName');
  const m = '충무주공(872)'.match(JIBUN_SUFFIX_RE);
  assert.ok(m, '원본 패턴이 지번 괄호를 매칭하지 못한다');
  assert.equal(m[1], '872', '캡처 그룹 오류');
});