/**
 * 특성화(characterization) 테스트 — Sprint XXXXX (2026-07-17)
 *
 * 목적: 돈 계산 순수 함수 2종(computeLTV·calcTotalCost)의 "현재 동작"을 고정 —
 *   향후 리팩터(LTV/DSR 3중 구현 통합 등)나 정책 수치 수정 시 의도치 않은 드리프트를 잡는다.
 *   (과거 실사고: 규제지역 정규식 누락 → LTV 70% 오표기 → 은행에서 40%만 나오는 손실 시나리오)
 *
 * 기대값 출처: 2026-07-17 HEAD 에서 함수를 실제 실행해 얻은 출력(계산·추측 아님).
 *   법령 정합성은 Sprint NNNN(2026-07-11) 전수 재검증에서 확인됨 — 규제 무주택 40%·생애최초 70%·
 *   비규제 70/80%·한도 15억↓6/25억↓4/25억↑2·취득세 6~9억 누진(§11①8호)·생애최초 12억↓ 200만 공제(§36의3)·
 *   2주택+ 8% 중과. 이 테스트가 깨지면 "동작이 변한 것" — 의도한 정책 갱신이면 기대값을 함께 갱신할 것.
 *
 * 실행: cd backend && npm test   (node:test 내장 러너 — 의존성 0)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeLTV } = require('../services/propertyService');
const { calcTotalCost } = require('../services/analysisService');

test('computeLTV — 무주택 규제/비규제/생애최초', () => {
  assert.deepEqual(computeLTV(7, true, false, '무주택'), { ltv: '40% (규제)', maxLoan: '2.80억' });
  assert.deepEqual(computeLTV(7, false, false, '무주택'), { ltv: '70% (비규제)', maxLoan: '4.90억' });
  assert.deepEqual(computeLTV(7, true, true, '무주택'), { ltv: '70% (규제)', maxLoan: '4.90억' });
  assert.deepEqual(computeLTV(7, false, true, '무주택'), { ltv: '80% (비규제)', maxLoan: '5.60억' });
});

test('computeLTV — 1주택/처분조건부/2주택+', () => {
  assert.deepEqual(computeLTV(7, true, false, '1주택'), { ltv: '0% (1주택 규제지역)', maxLoan: '처분조건부 chip 선택 시 무주택 한도' });
  assert.deepEqual(computeLTV(7, false, false, '1주택'), { ltv: '70% (비규제)', maxLoan: '4.90억' });
  assert.deepEqual(computeLTV(7, true, false, '1주택 (처분조건부)'), { ltv: '70% (규제) · 처분조건부', maxLoan: '4.90억' });
  assert.deepEqual(computeLTV(7, true, false, '2주택+'), { ltv: '0% (규제)', maxLoan: '0억' });
});

test('computeLTV — 규제지역 대출 상한(15억↓6억 / 15~25억 4억 / 25억↑2억) 경계', () => {
  assert.deepEqual(computeLTV(15, true, true, '무주택'), { ltv: '70% (규제)', maxLoan: '6.00억' });
  assert.deepEqual(computeLTV(16, true, false, '무주택'), { ltv: '40% (규제)', maxLoan: '4.00억' });
  assert.deepEqual(computeLTV(26, true, true, '무주택'), { ltv: '70% (규제)', maxLoan: '2.00억' });
});

test('calcTotalCost — 취득세 구간(6억↓ 1% / 6~9억 누진 / 9억↑ 3%) 경계', () => {
  assert.deepEqual(calcTotalCost(5, 2, '무주택', false), { gap: 3, acqTax: 0.05, firstBuyerDeduct: 0, eduTax: 0.01, spclTax: 0, commission: 0.02, regFee: 0.01, total: 3.08, totalLow: 2.93, totalHigh: 3.23, taxRate: 1, source: 'fallback' });
  assert.deepEqual(calcTotalCost(6, 2, '무주택', false), { gap: 4, acqTax: 0.06, firstBuyerDeduct: 0, eduTax: 0.01, spclTax: 0, commission: 0.02, regFee: 0.01, total: 4.1, totalLow: 3.95, totalHigh: 4.25, taxRate: 1, source: 'fallback' });
  assert.deepEqual(calcTotalCost(7, 3, '무주택', false), { gap: 4, acqTax: 0.12, firstBuyerDeduct: 0, eduTax: 0.01, spclTax: 0.01, commission: 0.03, regFee: 0.01, total: 4.18, totalLow: 4.03, totalHigh: 4.33, taxRate: 1.7, source: 'fallback' });
  assert.deepEqual(calcTotalCost(9, 4, '무주택', false), { gap: 5, acqTax: 0.27, firstBuyerDeduct: 0, eduTax: 0.03, spclTax: 0.02, commission: 0.04, regFee: 0.02, total: 5.38, totalLow: 5.23, totalHigh: 5.53, taxRate: 3, source: 'fallback' });
  assert.deepEqual(calcTotalCost(10, 4, '무주택', false), { gap: 6, acqTax: 0.3, firstBuyerDeduct: 0, eduTax: 0.03, spclTax: 0.02, commission: 0.05, regFee: 0.02, total: 6.42, totalLow: 6.27, totalHigh: 6.57, taxRate: 3, source: 'fallback' });
});

test('calcTotalCost — 생애최초 200만 공제(12억↓)와 12억 초과 배제', () => {
  assert.deepEqual(calcTotalCost(7, 3, '무주택', true), { gap: 4, acqTax: 0.1, firstBuyerDeduct: 0.02, eduTax: 0.01, spclTax: 0.01, commission: 0.03, regFee: 0.01, total: 4.16, totalLow: 4.01, totalHigh: 4.31, taxRate: 1.7, source: 'fallback' });
  assert.deepEqual(calcTotalCost(12, 5, '무주택', true), { gap: 7, acqTax: 0.34, firstBuyerDeduct: 0.02, eduTax: 0.03, spclTax: 0.02, commission: 0.07, regFee: 0.02, total: 7.49, totalLow: 7.34, totalHigh: 7.64, taxRate: 3, source: 'fallback' });
  assert.deepEqual(calcTotalCost(13, 5, '무주택', true), { gap: 8, acqTax: 0.39, firstBuyerDeduct: 0, eduTax: 0.04, spclTax: 0.03, commission: 0.08, regFee: 0.02, total: 8.55, totalLow: 8.4, totalHigh: 8.7, taxRate: 3, source: 'fallback' });
});

test('calcTotalCost — 2주택+ 취득세 8% 중과', () => {
  assert.deepEqual(calcTotalCost(7, 3, '2주택+', false), { gap: 4, acqTax: 0.56, firstBuyerDeduct: 0, eduTax: 0.06, spclTax: 0.01, commission: 0.03, regFee: 0.01, total: 4.67, totalLow: 4.52, totalHigh: 4.82, taxRate: 8, source: 'fallback' });
});

// ── Sprint QQQQQQ (2026-07-25): snapshot(운영 기본) 경로 취득세 경계 ──────────
//   왜 추가하나: 위 테스트들은 전부 source:'fallback'(taxConfig 미주입) 경로만 고정하고 있어,
//   운영에서 실제로 쓰이는 snapshot 경로(pickTierRate)의 경계 버그를 잡지 못했다.
//   실제 결함: pickTierRate 가 엄격 미만(`<`)이라 **정확히 6억**에서 1% 가 아닌 2% 적용
//   (지방세법 §11①8호 "6억원 이하 1%" 위반, 6억 기준 600만→1,200만 과다).
//   프론트(index.html:7250 `price<=6?.01`)·fallback(analysisService:354)과도 어긋나 있었다.
test('pickTierRate — snapshot 경로 취득세 경계 (6억 이하 1% / 6 초과 누진 / 9 초과 3%)', () => {
  const { calcTotalCost } = require('../services/analysisService');
  // 실제 운영 스냅샷과 동일한 tier 구조 (regulationsService FALLBACK_SNAPSHOT 과 일치)
  const cfg = { acquisitionTax: {
    noHouse: { tiers: [ { underAuk: 6, rate: 0.01 }, { underAuk: 9, rate: 0.02 }, { underAuk: 999, rate: 0.03 } ] },
    oneHouse: { tiers: [ { underAuk: 6, rate: 0.01 }, { underAuk: 9, rate: 0.02 }, { underAuk: 999, rate: 0.03 } ] },
    twoHousePlus: { rate: 0.08 },
  } };
  const rateOf = (price) => calcTotalCost(price, 1, '무주택', false, cfg).taxRate;
  assert.equal(rateOf(5), 1);   // 6억 미만 → 1%
  assert.equal(rateOf(6), 1);   // ★ 정확히 6억 → 1% (이 경계가 2% 였던 것이 결함)
  assert.equal(rateOf(9), 3);   // 누진 상단 = 3%
  assert.equal(rateOf(10), 3);  // 9억 초과 → 3%
  // snapshot 경로임을 확인 (fallback 으로 새지 않았는지)
  assert.equal(calcTotalCost(6, 1, '무주택', false, cfg).source, 'snapshot');
});

// ── Sprint UUUUUU (2026-07-25): 프론트 규제지역 분류 ↔ 백엔드 computeLTV 계약 ──────────
//   왜 추가하나: 프론트가 마커 색·카드 색·규제/비규제 필터를 `ltv.includes('40')` 로 판정했는데,
//   40% 는 **무주택 + 생애최초 아니오** 조합에서만 나오는 값이다. 기본 칩이 무주택+생애최초'예'라
//   아무 설정도 안 한 사용자에게 규제지역 단지가 상시 '비규제'로 표시됐다(프로덕션 실측 확인).
//   이 테스트는 두 파일을 **계약으로 묶는다** — computeLTV 가 새 라벨을 만들면 여기서 먼저 깨진다.
test('_isRegProp(프론트) — computeLTV 전 조합에서 규제/비규제 분류가 어긋나지 않는다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const m = html.match(/function _isRegProp\(p\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'frontend/index.html 에서 _isRegProp 를 찾지 못했다 (함수명 변경 시 이 테스트도 갱신할 것)');
  // 폴백 분기용 스텁 — 이 테스트는 "라벨 → 규제 여부" 승계만 검증한다(위치 판정은 별도 관심사).
  const _isRegProp = new Function('_regLtvLabel', `${m[0]}; return _isRegProp;`)(() => null);

  const HOUSE = ['무주택', '1주택', '1주택 (처분조건부)', '2주택+'];
  for (const house of HOUSE) {
    for (const first of [true, false]) {
      const reg = computeLTV(7, true, first, house);
      const non = computeLTV(7, false, first, house);
      assert.equal(_isRegProp({ ltv: reg.ltv }), true,
        `규제지역인데 비규제로 분류됨: house=${house} 생애최초=${first} ltv="${reg.ltv}"`);
      assert.equal(_isRegProp({ ltv: non.ltv }), false,
        `비규제인데 규제로 분류됨: house=${house} 생애최초=${first} ltv="${non.ltv}"`);
    }
  }
  // ltv 미제공(지도 in-bounds·공유 링크 경로) → 위치 폴백으로 위임. 스텁이 null 이므로 비규제.
  assert.equal(_isRegProp({ area: '서울 강남구', lawdCd: '11680' }), false);
});

// ── Sprint UUUUUU: 위치 기반 폴백(_regLtvLabel)의 시도 스코프 가드 ──────────
//   왜 추가하나: 폴백은 이름 부분일치(isRegFront)에 의존하는데, 서울 키워드 '강서' 가
//   '부산 강서구' 에 부분일치해 지방을 규제로 오판정할 수 있었다. 스냅샷이 표현 가능한 축이
//   서울(11)·경기(41) 뿐이라는 사실을 코드가 강제하는지 고정한다.
test('_regLtvLabel(프론트) — lawd_cd 스코프 가드로 지방 동명 구 오판정 차단', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const m = html.match(/function _regLtvLabel\(area, lawdCd\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'frontend/index.html 에서 _regLtvLabel 를 찾지 못했다');
  // isRegFront 는 "이름이 규제 키워드에 걸리면 true" — 최악 조건으로 **항상 true** 스텁을 주고,
  // 그래도 지방이 규제로 새지 않는지(= 가드가 이름보다 먼저 동작하는지) 검증한다.
  const _regLtvLabel = new Function('isRegFront', 'SEOUL_GU_KW',
    `${m[0]}; return _regLtvLabel;`)(() => true, ['강서', '중구']);

  assert.equal(_regLtvLabel('서울 강남구', '11680'), '40%');  // 서울 = 규제
  assert.equal(_regLtvLabel('서울 중구', '11140'), '40%');    // 서울 중구(동명) = 규제
  assert.equal(_regLtvLabel('강서구', '26440'), '70%');       // ★ 부산 강서구 — 이름은 걸려도 비규제
  assert.equal(_regLtvLabel('중구', '26110'), '70%');         // ★ 부산 중구 — 비규제
  assert.equal(_regLtvLabel('수원시팔달구', '41115'), '40%'); // 경기는 이름 매칭 대상
  assert.equal(_regLtvLabel('', ''), null);                   // 지역 미상 → 라벨 생략
});
