/**
 * buildFacility.structureType 계약 테스트 — Plan 068 (2026-09-06)
 *
 * 배경: apt_master.facility->'_dtl'->>'codeStr' 에 진짜 건물 구조(철근콘크리트구조 등)가
 *   14,196행 있는데 buildFacility 가 노출하지 않았다(hallType=복도유형만 있었다).
 *   codeStr 은 info(BasisInfo)가 아니라 detail(_dtl, DtlInfo)에 있다 — 실제 위치는
 *   backend/utils/buildFacility.js 를 직접 읽어 확인했다(추측 아님).
 *
 * buildFacility 소비자는 여럿이다(2026-09-06 grep -rn "buildFacility(" backend/ 실측):
 *   - backend/services/analysisService.js:751
 *   - backend/routes/aptPage.js:195
 *   - backend/services/propertyService.js:837, 911, 1126, 1181
 *   - backend/routes/search.js:1090
 *   기존 필드는 한 글자도 바꾸지 않았다 — structureType 은 순수 추가 필드다. 이 파일은 그 사실을
 *   "반환 키 집합" 으로 실행 고정한다(주장이 아니라 증거).
 *
 * 주의(운영자 지시): 이 저장소의 단일 테스트 파일(characterization.test.js)은 현재 분할 작업
 *   중이라 건드리지 않는다 — 이 신규 파일 안에서 독립적으로 완결한다(헬퍼도 import 하지 않음).
 *
 * 실행: cd backend && npm test   (node:test 내장 러너 — 의존성 0)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildFacility } = require('../utils/buildFacility');

// Plan 068 실행 시점(HEAD 943caa9 기준 작업)의 buildFacility 기존 키 33개 + structureType 1개 = 34개.
// 이 배열이 깨지면(키가 늘거나 준다) buildFacility 의 계약이 바뀐 것이다 — 위 소비자 7곳에
// 영향이 갈 수 있으니, structureType 추가 외의 변경이 섞이지 않았는지 반드시 확인할 것.
const EXPECTED_KEYS = [
  'kaptCode', 'totalHouseholds', 'householdsSource', 'dongCount', 'parkingTotal',
  'parkingRatio', 'householdsConflict', 'saleType', 'builtDate', 'heatType', 'mgrType',
  'address', 'aptType', 'hallType', 'structureType', 'floorAreaRatio', 'topFloor',
  'bottomFloor', 'builder', 'developer', 'elevatorCount', 'cctvCount', 'subwayLine',
  'subwayStation', 'walkBusMin', 'walkSubwayMin', 'convenientFacility', 'welfareFacility',
  'educationFacility', 'evChargerTotal', 'mgrCompany', 'areaDistribution', 'rawKapt', 'rawDetail',
].sort();

// 실 KAPT 응답 형태를 흉내낸 최소 샘플 — info(BasisInfo) + detail(DtlInfo, _dtl).
const SAMPLE_INFO = {
  kaptdaCnt: '1000', hoCnt: '1000', kaptDongCnt: '10',
  codeSaleNm: '분양', kaptUsedate: '20100101', codeHeatNm: '개별난방', codeMgrNm: '위탁관리',
  doroJuso: '서울 강남구 테헤란로 1', kaptAddr: '서울 강남구 역삼동 1',
  codeAptNm: '아파트', codeHallNm: '계단식',
  kaptTarea: '50000', kaptTopFloor: '20', kaptBaseFloor: '2',
  kaptBcompany: '대한건설', kaptAcompany: '대한개발', kaptdEcntp: '5',
};
const SAMPLE_DETAIL = {
  kaptdPcnt: '300', kaptdPcntu: '700', kaptdEcnt: '5', kaptdCccnt: '50',
  codeStr: '철근콘크리트구조',
};

test('buildFacility 키 집합 계약 — 기존 키 전부 + structureType (Plan 068)', () => {
  const result = buildFacility(SAMPLE_INFO, 'A0001', SAMPLE_DETAIL);
  assert.deepEqual(
    Object.keys(result).sort(),
    EXPECTED_KEYS,
    'buildFacility 반환 키 집합이 바뀌었다 — analysisService/aptPage/propertyService/search.js 소비자 영향 확인 필요'
  );
});

test('structureType — detail.codeStr 값을 그대로 노출한다', () => {
  const result = buildFacility(SAMPLE_INFO, 'A0001', SAMPLE_DETAIL);
  assert.equal(result.structureType, '철근콘크리트구조');
});

test('structureType — detail 이 없으면 null (미상 문자열 생성 금지)', () => {
  const result = buildFacility(SAMPLE_INFO, 'A0001', null);
  assert.equal(result.structureType, null);
  assert.notEqual(result.structureType, '미상');
});

test('structureType — detail 은 있으나 codeStr 필드가 없으면 null', () => {
  const result = buildFacility(SAMPLE_INFO, 'A0001', { kaptdPcnt: '100' });
  assert.equal(result.structureType, null);
});

test('structureType 추가가 기존 필드 계산에 영향을 주지 않는다', () => {
  const withDetail = buildFacility(SAMPLE_INFO, 'A0001', SAMPLE_DETAIL);
  const withoutDetail = buildFacility(SAMPLE_INFO, 'A0001', null);
  // hallType(복도유형)은 structureType(구조)과 다른 필드 — 서로 간섭하지 않아야 한다.
  assert.equal(withDetail.hallType, '계단식');
  assert.equal(withoutDetail.hallType, '계단식');
  assert.equal(withDetail.totalHouseholds, 1000);
  assert.equal(withoutDetail.totalHouseholds, 1000);
  assert.equal(withDetail.parkingTotal, 1000); // detail 의 주차 필드는 그대로 반영
  assert.equal(withoutDetail.parkingTotal, 0); // detail 없으면 기존 규칙대로 0
});

test('KAPT info 자체가 없는 부분 facility(_partial) 경로는 원래도 structureType 을 포함하지 않는다', () => {
  // buildFacility(null, kaptCode, detail) 은 hallType/aptType 등 다수 필드를 이미 생략하는
  // 별도 축소 스키마다(_partial:true) — Plan 068 은 이 분기를 건드리지 않는다(범위 밖).
  const result = buildFacility(null, 'A0001', SAMPLE_DETAIL);
  assert.equal(result._partial, true);
  assert.equal('structureType' in result, false);
});
