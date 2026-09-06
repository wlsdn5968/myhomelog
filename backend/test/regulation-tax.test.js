/**
 * backend/test/regulation-tax.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { _reg, _regPairFns } = require('../testSupport/_helpers');

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
  // Plan 018(2026-08-16): _regLtvLabel 이 서울 판정에 스냅샷(window.__REG_KW)을 보게 되면서
  //   이 하네스도 window 를 넘겨야 한다. 여기서는 **미로드 상태**(undefined)를 준다 —
  //   그때도 서울은 보수적으로 40% 여야 한다는 것이 아래 두 단언의 뜻이다.
  //   (해제 시나리오는 별도 테스트 '서울 규제 해제 시나리오' 에서 실제 isRegFront 와 함께 본다.)
  //
  // ★★ 감사 #29 (2026-08-16): 예전엔 SEOUL_GU_KW 를 `['강서','중구']` 로 **손으로 축약**해 넘겼다.
  //   그런데 실제 목록은 '중구' 를 **의도적으로 뺐다**(지방 중구 오판 방지, index.html 주석).
  //   즉 없는 값을 넣은 탓에 "서울 중구가 40%" 인 이유가 lawd_cd 가드 때문인지 그 가짜 키워드
  //   때문인지 **구별되지 않았다** — 스텁이 정답을 만들어 준 셈이다.
  //   → 실제 배열을 소스에서 추출해 쓴다. 그래야 아래 중구 단언이 lawd_cd 경로를 증명한다.
  const kwM = html.match(/const SEOUL_GU_KW\s*=\s*\[[\s\S]*?\];/);
  assert.ok(kwM, 'frontend/index.html 에서 SEOUL_GU_KW 를 찾지 못했다');
  const SEOUL_GU_KW = new Function(`${kwM[0]}; return SEOUL_GU_KW;`)();
  assert.ok(SEOUL_GU_KW.includes('강서'),
    "SEOUL_GU_KW 에 '강서' 가 없다 — 부산 강서구 오판 케이스의 전제가 사라졌다(테스트도 갱신할 것)");
  assert.equal(SEOUL_GU_KW.includes('중구'), false,
    "SEOUL_GU_KW 에 '중구' 가 들어갔다 — 지방 중구를 서울로 오판한다(의도적으로 빼둔 값이다)");

  const _regLtvLabel = new Function('isRegFront', 'SEOUL_GU_KW', 'window',
    `${m[0]}; return _regLtvLabel;`)(() => true, SEOUL_GU_KW, { __REG_KW: undefined });

  assert.equal(_regLtvLabel('서울 강남구', '11680'), '40%');  // 서울 = 규제
  assert.equal(_regLtvLabel('서울 중구', '11140'), '40%');    // 서울 중구(동명) = 규제
  assert.equal(_regLtvLabel('강서구', '26440'), '70%');       // ★ 부산 강서구 — 이름은 걸려도 비규제
  assert.equal(_regLtvLabel('중구', '26110'), '70%');         // ★ 부산 중구 — 비규제
  assert.equal(_regLtvLabel('수원시팔달구', '41115'), '40%'); // 경기는 이름 매칭 대상
  assert.equal(_regLtvLabel('', ''), null);                   // 지역 미상 → 라벨 생략
});



// ── Plan 004: 규제지역 판정 — LTV 40↔70% 를 가르는 백엔드 판정의 경계 고정 ─────────────
//   로컬 테스트 환경(SUPABASE env 없음)에서는 getSnapshot 이 FALLBACK 경로로 결정적으로 동작한다.
test('isRegulatedRegion — 서울/규제 키워드/비규제/빈 문자열 경계', async () => {
  const { isRegulatedRegion } = require('../services/regulationsService');
  assert.equal(await isRegulatedRegion('서울'), true);
  assert.equal(await isRegulatedRegion('강남'), true);
  assert.equal(await isRegulatedRegion('송파구'), true);
  assert.equal(await isRegulatedRegion('분당'), true);
  assert.equal(await isRegulatedRegion(''), false);
  assert.equal(await isRegulatedRegion('일산'), false);
});



// ── Plan 008 (2026-08-16): 프론트 _pickTierRate ↔ 백엔드 취득세 경계 계약 ──────────
//   왜 추가하나: 같은 취득세 tier 판정이 프론트(index.html)·백엔드(analysisService) **두 사본**으로
//   존재하는데, 2026-07-25 경계 수정(엄격 미만 → 이하) 때 백엔드만 고쳐졌다. 당시 "프론트는 이미
//   맞다"고 본 근거가 프론트의 하드코딩 폴백이었고, 정상 운영(window.__TAX_CONFIG 로드)에서 상시
//   타는 _pickTierRate 경로는 검토에서 빠졌다 — 정확히 6억에서 1% 대신 2% 가 적용돼 사용자에게
//   600만원이 과다 표기됐다(지방세법 §11①8호 "6억원 이하 1%").
//   이 테스트는 두 파일을 **계약으로 묶는다**: 한쪽만 고치면 여기서 먼저 깨진다.
test('_pickTierRate(프론트) — 취득세 경계가 백엔드와 같은 값을 낸다 (6억 이하 1%)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const m = html.match(/function _pickTierRate\([\s\S]*?\n\}/);
  assert.ok(m, 'frontend/index.html 에서 _pickTierRate 를 찾지 못했다 (함수명 변경 시 이 테스트도 갱신할 것)');
  const _pickTierRate = new Function(`${m[0]}; return _pickTierRate;`)();

  // 실제 운영 스냅샷과 동일한 tier 구조 (위 pickTierRate 테스트와 같은 값)
  const cfg = { acquisitionTax: {
    noHouse: { tiers: [ { underAuk: 6, rate: 0.01 }, { underAuk: 9, rate: 0.02 }, { underAuk: 999, rate: 0.03 } ] },
    oneHouse: { tiers: [ { underAuk: 6, rate: 0.01 }, { underAuk: 9, rate: 0.02 }, { underAuk: 999, rate: 0.03 } ] },
    twoHousePlus: { rate: 0.08 },
  } };
  const tiers = cfg.acquisitionTax.noHouse.tiers;
  const frontRate = (price) => _pickTierRate(tiers, price, 0.03);

  assert.equal(frontRate(5), 0.01, '6억 미만 → 1%');
  assert.equal(frontRate(6), 0.01, '★ 정확히 6억 → 1% (이 경계가 2% 였던 것이 결함)');
  assert.equal(frontRate(9), 0.02, '9억 → 2% tier (백엔드는 여기에 누진 보정을 더해 3% 가 되므로 아래 대조에서 제외)');
  assert.equal(frontRate(10), 0.03, '9억 초과 → fallback 3%');

  // ★ 백엔드와 값 일치 — "한쪽만 고쳐지는" 재발을 여기서 잡는다.
  //   9억은 백엔드가 6~9억 누진 보정을 적용해 tier 평탄값(2%)과 달라지므로 대조 대상에서 뺀다.
  const { calcTotalCost } = require('../services/analysisService');
  const backRate = (price) => calcTotalCost(price, 1, '무주택', false, cfg).taxRate;
  for (const p of [5, 6, 10]) {
    assert.equal(Math.round(frontRate(p) * 100), backRate(p),
      `프론트·백엔드 취득세율 불일치: ${p}억 프론트=${frontRate(p) * 100}% 백엔드=${backRate(p)}%`);
  }
});



// ── 감사 #26 (2026-08-16): 취득세 **6억 초과 ~ 9억 이하 누진 구간**의 사본 3개 계약 ──────
//   [왜] 기존 프론트↔백엔드 대조는 5·6·10억만 본다. 그 사이 누진 구간은 대조에서 빠져 있었고,
//   그 구간의 계산식은 **세 곳에 복제**돼 있다:
//     ① frontend/index.html  calcTotalCostHTML  (비용 계산기)
//     ② frontend/index.html  매물 카드 acqTax1H (단지 카드)
//     ③ backend/services/analysisService.js     (보고서)
//   백엔드(③)는 이미 세율 단언 3건으로 고정돼 있지만 **프론트 2개는 단언이 하나도 없어**,
//   계수를 바꿔도(예: 2/3 → 1/2) 전 테스트가 초록이었다. 6억 초과 구간은 세액이 수백만원 단위로
//   갈리는 구간이라 사본이 갈리면 곧바로 화면의 돈이 틀린다.
//   근거: 지방세법 §11①8호 — 6억 초과 9억 이하 주택 취득세율 = (취득가액[억] × 2/3 − 3) %
test('취득세 누진 구간(6억 초과~9억 이하) — 프론트 2사본·백엔드가 모두 같은 법정식', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const feSrc = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const beSrc = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');

  // 공백만 제거해 정규화 — `2/3` 과 `2 / 3` 을 같은 식으로 본다
  const norm = (s) => s.replace(/\s+/g, '');
  // 세 사본에서 "(<변수>*2/3-3)/100" 형태를 뽑는다. 변수명은 사본마다 다르다(price/market).
  const RE = /\(\s*(\w+)\s*\*\s*2\s*\/\s*3\s*-\s*3\s*\)\s*\/\s*100/g;

  const feHits = [...feSrc.matchAll(RE)];
  const beHits = [...beSrc.matchAll(RE)];
  assert.equal(feHits.length, 2,
    `프론트의 누진식 사본이 2개가 아니다(${feHits.length}개) — 사본이 늘거나 식이 바뀌었다. `
    + '늘었다면 이 테스트도 함께 갱신할 것');
  assert.equal(beHits.length, 1, `백엔드 누진식이 1개가 아니다(${beHits.length}개)`);

  // 변수명을 통일해 비교 → 계수(2/3, -3, /100) 중 하나라도 다르면 여기서 걸린다
  const shape = (m) => norm(m[0]).replace(m[1], 'X');
  const shapes = [...feHits, ...beHits].map(shape);
  assert.deepEqual([...new Set(shapes)], ['(X*2/3-3)/100'],
    `누진식 사본이 서로 다르다: ${JSON.stringify(shapes)}`);

  // 구간 경계도 사본마다 같아야 한다 — 프론트 계산기·백엔드는 `price > 6 && price <= 9`
  const boundRe = /(\w+)\s*>\s*6\s*&&\s*\1\s*<=\s*9/g;
  assert.equal([...feSrc.matchAll(boundRe)].length + [...beSrc.matchAll(boundRe)].length, 2,
    '누진 구간 경계(> 6 && <= 9)가 프론트 계산기·백엔드 양쪽에 있지 않다');

  // 실제 값 대조 — 백엔드가 법정식과 같은 세율을 내는지 (프론트는 위에서 식 동일성으로 묶었다)
  //   ⚠ `taxRate` 는 원시 비율이 아니라 **표시용으로 소수 1자리 반올림**된 값이다
  //     (analysisService.js: `Math.round(rate * 1000) / 10`). 기대값도 같은 반올림을 거쳐야 한다.
  //     이걸 모르고 원시값과 비교했다가 6.5억에서 1.3 vs 1.3333 으로 어긋났다.
  const { calcTotalCost } = require('../services/analysisService');
  for (const p of [6.5, 7, 8, 9]) {
    const expected = Math.round((p * 2 / 3 - 3) * 10) / 10;   // % 단위, 표시 반올림 반영
    const got = calcTotalCost(p, 3, '무주택', false).taxRate;
    assert.equal(got, expected,
      `${p}억 취득세율이 법정식과 다르다: got=${got} expected=${expected} (지방세법 §11①8호)`);
  }
  // 경계 바로 밖은 누진이 아니라 평탄값이어야 한다 (구간이 새어나가지 않는지)
  assert.equal(calcTotalCost(6, 3, '무주택', false).taxRate, 1, '6억 이하는 1% 평탄이어야 한다');
  assert.equal(calcTotalCost(10, 3, '무주택', false).taxRate, 3, '9억 초과는 3% 평탄이어야 한다');
});



test('isRegFront ↔ _regLtvLabel — 같은 단지에서 규제 판정이 갈리지 않는다 (한 화면 모순 차단)', () => {
  // 현재 프로덕션 스냅샷 형태: { keywords, seoulRegulated } — regulationsService.js:232 실측.
  //   keywords 는 경기 규제 지역에서 파생된다(같은 파일 209-230). 구조상 지방 축이 없다.
  const REG = { keywords: ['과천시', '과천', '성남시 분당구', '분당', '광명시', '광명', '하남시', '하남'], seoulRegulated: true };
  const { isRegFront, _regLtvLabel } = _regPairFns(REG);

  // lawd_cd 는 전부 transactionService.LAWD_CODES 실값
  const cases = [
    ['강남구 대치동', '11680', true],   // 서울
    ['강서구 화곡동', '11500', true],   // 서울 강서구 — 여기는 규제가 맞다
    ['강서구 명지동', '26440', false],  // ★ 부산 강서구 — 실제로 갈렸던 유일한 조합
    ['해운대구 우동', '26350', false],
    ['수성구 범어동', '27260', false],
    ['연수구 송도동', '28185', false],
    ['분당구 정자동', '41135', true],   // 경기 규제
    ['과천시 별양동', '41290', true],
  ];

  for (const [area, code, wantReg] of cases) {
    const a = isRegFront(area, code);
    const b = _regLtvLabel(area, code);
    assert.equal(a, wantReg, `isRegFront('${area}', '${code}') 가 ${wantReg} 가 아니다`);
    assert.equal(b, wantReg ? '40%' : '70%', `_regLtvLabel('${area}', '${code}') 가 어긋났다`);
    // TAUTOLOGY-REMOVED-2026-08-16 (감사 #8): 여기 있던 `assert.equal(a, b === '40%')` 는
    //   위 두 단언이 통과하면 **반드시 참**이라 아무것도 검증하지 못했다("두 경로 교차검증"이라는
    //   이름이 실제보다 강한 보장을 주장하고 있었다). 두 함수가 서로 같은지는 기대값을 쓰지 않는
    //   **아래 '서울 25개 구 전수' 대조**가 담당한다 — 거기서만 a↔b 를 직접 비교한다.
  }

  // ★★ 서울 **25개 구 전수** — 손으로 고른 목록은 빠뜨린다(실제로 빠뜨렸다).
  //   [실사고 2026-08-16] 위 cases 는 사람이 고른 8개였고 거기에 **서울 중구가 없었다**.
  //   그래서 계약 테스트가 초록인 채로 프로덕션에서 중구 1곳만 갈려 있었다
  //   (SEOUL_GU_KW 가 24개이고 '중구' 를 의도적으로 제외하기 때문 — 라이브 전수 조회로 발각).
  //   → 목록을 손으로 쓰지 말고 **LAWD_CODES 에서 11 접두를 전부 뽑아** 돌린다.
  //     구가 추가/개편돼도 자동으로 포함된다.
  const { LAWD_CODES } = require('../services/transactionService');
  const seoulGus = Object.entries(LAWD_CODES).filter(([, c]) => String(c).startsWith('11'));
  assert.equal(seoulGus.length, 25, `서울 구 수가 25가 아니다(${seoulGus.length}) — LAWD_CODES 변경 시 이 테스트도 확인할 것`);
  for (const [gu, code] of seoulGus) {
    const area = `${gu} 테스트동`;
    const a = isRegFront(area, code);
    const b = _regLtvLabel(area, code);
    assert.equal(a, true, `서울 ${gu}(${code}) 를 isRegFront 가 비규제로 판정했다`);
    assert.equal(b, '40%', `서울 ${gu}(${code}) 의 _regLtvLabel 이 40% 가 아니다`);
    assert.equal(a, b === '40%', `서울 ${gu}(${code}) 에서 두 경로가 갈렸다: isRegFront=${a} vs ${b}`);
  }

  // lawd_cd 를 모르는 경로(사용자가 지역을 직접 타이핑하는 특약 탭·대출계산 탭)는
  // 기존 문자열 판정 그대로 — 회귀가 없어야 한다.
  assert.equal(isRegFront('서울 강남구'), true);
  assert.equal(isRegFront('강서구 명지동'), true);  // 코드가 없으면 여전히 구별 불가(알려진 한계)
  assert.equal(isRegFront('일산동구 마두동'), false);
});


const { LAWD_CODES: _RLC, LAWD_CODE_TO_NAME: _RN } = require('../services/transactionService');



test('규제 판정: 규제 목록의 모든 지역이 LAWD_CODES 로 해석된다 (미해석 0)', async () => {
  const { codes, seoulRegulated, unmatched } = await _reg.getRegulatedLawdCodes();
  assert.deepEqual(unmatched, [], `규제 목록에 LAWD_CODES 로 못 찾는 지역이 있다: ${unmatched.join(', ')}`);
  assert.equal(seoulRegulated, true, '스냅샷상 서울 전 지역 규제가 꺼져 있다');
  // 서울 25개 구가 전부 들어가야 한다 — 이름이 아니라 코드 접두로.
  const seoul = Object.values(_RLC).map(String).filter(c => c.startsWith('11'));
  for (const c of seoul) assert.ok(codes.has(c), `서울 ${c}(${_RN[c]}) 가 규제 집합에 없다`);
  assert.ok(codes.size > seoul.length, '경기 규제지역이 하나도 포함되지 않았다');
});



test('규제 판정: lawd_cd 판정과 키워드 판정이 전 122코드에서 일치한다', async () => {
  const { codes, seoulRegulated } = await _reg.getRegulatedLawdCodes();
  const { keywords } = await _reg.getRegulatedKeywords();
  const diffs = [];
  for (const code of [...new Set(Object.values(_RLC).map(String))]) {
    const byCode = codes.has(code);
    // 종전 동작 재현: 서울은 접두, 그 외는 표시명 부분일치
    const name = _RN[code] || '';
    const byKeyword = (seoulRegulated && code.startsWith('11'))
      || (keywords || []).some(kw => name.includes(kw));
    if (byCode !== byKeyword) diffs.push(`${code}(${name}) code=${byCode} keyword=${byKeyword}`);
  }
  assert.deepEqual(diffs, [], `두 규제 판정이 갈린다:\n  ${diffs.join('\n  ')}`);
});



test('규제 판정: 동명 구가 코드로 구별된다 (문자열로는 원리적으로 불가)', async () => {
  const { codes } = await _reg.getRegulatedLawdCodes();
  // '중구' 는 6곳인데 규제는 서울만이다. 표시명은 전부 '중구' 라 문자열로는 못 가른다.
  assert.equal(_RN['11140'], _RN['26110'], '전제 확인: 서울 중구와 부산 중구의 표시명이 같아야 한다');
  assert.ok(codes.has('11140'), '서울 중구가 규제지역이어야 한다');
  assert.equal(codes.has('26110'), false, '부산 중구가 규제지역으로 잘못 잡혔다');
  // '강서구' 도 서울/부산 두 곳
  assert.ok(codes.has('11500'), '서울 강서구가 규제지역이어야 한다');
  assert.equal(codes.has('26440'), false, '부산 강서구가 규제지역으로 잘못 잡혔다');
});



// ── ACQ-REG-CALC-2026-09-02 (감사 후속) → ACQ-UNKNOWN-COUNT-2026-09-06 (Plan 036, 되돌림) ──
//   [09-02 가 왜 있었나] 다주택 취득세 중과는 **조정대상지역** 기준인데(지방세법 §13-2), 실투자금
//     계산기는 2주택+ 를 지역과 무관하게 항상 8% 로 계산했다. 같은 단지 상세 화면의 세금 시뮬레이션
//     카드는 이미 지역을 보고 계산하고 있어서, 비조정지역 단지에서 **같은 화면에 서로 다른 취득세**가
//     떴다. 그래서 09-02 는 "비조정지역이 확인되면 기본세율" 로 풀었다.
//   [09-02 가 놓친 것] '2주택+' 칩은 2주택과 3주택 이상을 **구분하지 않는다**. 비조정지역은
//     2주택=기본세율 / 3주택=8% / 4주택+=12% 라(§13-2), 이 칩에 기본세율을 주면 3주택 이상에
//     과소 안내가 된다(9억 기준 7,200만원 → 2,700만원, 약 4,500만원 과소). 아래 첫 테스트가 그
//     09-02 케이스를 대체한다 — 파일 상단 방침대로 "의도한 정책 갱신이라 기대값을 함께 갱신".
//   [09-06 이 무엇을 고정하나] '2주택+' 는 isRegulated 값(true/false/undefined)과 무관하게
//     **항상** 보수적 중과(8%). 칩을 2주택/3주택+ 로 쪼개는 근본 해결은 범위 밖(plans/README.md).
test('취득세: 2주택+ 는 주택수 불확정 — 조정/비조정 무관 항상 보수적 중과(8%)', () => {
  const { calcTotalCost } = require('../services/analysisService');
  const rate = (price, isRegulated) => calcTotalCost(price, 3, '2주택+', false, undefined, isRegulated).taxRate;

  // ① 조정대상지역 확인 → 중과 8% (변화 없음)
  assert.equal(rate(7, true), 8, '조정대상지역 2주택+ 가 중과 8% 가 아니다');

  // ② 지역을 모름(undefined) → 종전대로 8% (과소 안내 금지, 변화 없음)
  assert.equal(rate(7, undefined), 8, '지역을 모르는데 중과를 풀었다 — 세금을 낮게 안내하면 안 된다');

  // ③★ 비조정지역이 확인돼도 8% 를 유지한다 — 이것이 09-02 를 되돌리는 핵심 케이스다.
  //    (09-02 당시엔 여기서 무주택 기본세율로 풀려 3주택 이상에 과소 안내를 냈다)
  for (const px of [5, 6, 6.5, 7, 9, 10]) {
    assert.equal(rate(px, false), 8,
      `비조정지역이 확인돼도 2주택+ 는 8% 를 유지해야 한다(${px}억 결과=${rate(px, false)})`);
  }

  // ④ 조정·비조정·미상 세 값이 모두 같다 — 지역 분기가 실제로 사라졌는지 확인(재발 시 여기서 갈린다).
  assert.equal(rate(7, true), rate(7, false), '조정·비조정 결과가 갈린다 — 지역 분기가 아직 남아있다');
  assert.equal(rate(7, undefined), rate(7, false), '미상·비조정 결과가 갈린다');
});



test('취득세: 프론트 계산기도 같은 시그니처를 쓰고(사본 드리프트 차단), 2주택+ 에 지역 분기가 없다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  const be = fs2.readFileSync(path2.join(__dirname, '../services/analysisService.js'), 'utf8');

  // 두 사본 모두 isRegulated 인자를 계속 받아야 한다(각주가 여전히 그 개념을 설명한다 — 시그니처는 유지)
  assert.ok(/function calcTotalCostHTML\([^)]*isRegulated/.test(fe),
    '프론트 계산기가 isRegulated 를 받지 않는다 — 각주(ACQ-UNKNOWN-COUNT-2026-09-06)가 인자를 잃는다');
  assert.ok(/function calcTotalCost\([^)]*isRegulated/.test(be),
    '백엔드 계산기가 isRegulated 를 받지 않는다');

  // ACQ-UNKNOWN-COUNT-2026-09-06: '2주택+' 는 더 이상 isRegulated === false 로 중과를 풀지
  //   않는다 — 이 패턴이 되돌아오면 3주택 이상에 과소 안내가 재발한다. 두 사본 모두 0이어야 한다.
  const feHits = (fe.match(/isRegulated\s*===\s*false/g) || []).length;
  const beHits = (be.match(/isRegulated\s*===\s*false/g) || []).length;
  assert.equal(feHits, 0, `프론트에 isRegulated === false 완화가 되살아났다(${feHits}건) — 3주택 이상 과소 안내 재발`);
  assert.equal(beHits, 0, `백엔드에 isRegulated === false 완화가 되살아났다(${beHits}건)`);

  // 단지 상세 호출부는 여전히 지역을 넘긴다(세금 시뮬레이션 카드 등 다른 용도에 계속 쓰인다)
  assert.ok(fe.indexOf('calcTotalCostHTML(pr,loanAmt,houseS,isF,_costIsReg)') >= 0,
    '단지 상세 계산기 호출부가 지역을 넘기지 않는다');
});



//   [왜] 취득세 생애최초 항목은 파일(구법 firstBuyerDiscount)과 프로덕션(현행 firstBuyerExempt)이
//     어긋나 있었다 — 운영자가 2026-06-27 DB 만 직접 고쳤기 때문. 그 사실을 저장소에 기록했다.
test('마이그레이션 기록: 생애최초 취득세 현행 필드가 사후 기록으로 남아 있다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const dir = path2.join(__dirname, '../../supabase/migrations');
  const files = fs2.readdirSync(dir).filter((f) => f.indexOf('acquisition_tax') >= 0);
  const joined = files.map((f) => fs2.readFileSync(path2.join(dir, f), 'utf8')).join('\n');
  assert.ok(joined.indexOf('firstBuyerExempt') >= 0,
    '마이그레이션 어디에도 firstBuyerExempt 가 없다 — 코드가 읽는 필드명이 저장소에 기록되지 않았다는 뜻');
  assert.ok(joined.indexOf('deductManwon') >= 0, '생애최초 공제액(200만) 기록이 없다');
});



// ── ACQ-CROSSCOPY-BEHAVIORAL-2026-09-02 (감사 후속: 테스트 행위화) ─────────────────────
//   [왜] 취득세는 프론트 계산기와 백엔드에 **각각 사본**이 있다. 2026-07-25 에 백엔드만 고쳐져
//     6억 매물에 600만원 과다 표기가 3주간 프로덕션에 남았다. 그때 있던 계약 테스트는
//     "두 사본의 **식 모양**이 같은가" 를 정규식으로 봤다 — 모양이 같아도 앞뒤 분기가 다르면
//     결과는 갈린다. 그래서 여기서는 **프론트 함수를 실제로 실행해** 백엔드와 값을 맞춘다.
//   [무엇을 고정하나] 세율 하나가 아니라 화면에 나가는 최종 금액 전체(취득세·교육세·농특세·
//     중개보수·등기비·갭)를 매수가 × 보유주택 × 생애최초 × 조정지역 × 대출 조합으로 대조한다.
//     스냅샷 경로와 폴백 경로를 **둘 다** 돈다 — "폴백이 맞으니 주 경로도 맞다" 는 판단이
//     이 저장소에서 이미 틀렸기 때문. (2026-09-02 실측: 792 조합 불일치 0)
test('취득세 사본 — 프론트 계산기를 실제로 실행해 백엔드와 전 조합 대조 (모양이 아니라 값)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  const grab = (name) => {
    const m = html.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    assert.ok(m, `frontend/index.html 에서 ${name} 을 찾지 못했다 — 함수명이 바뀌었다면 이 테스트도 갱신할 것`);
    return m[0];
  };
  const src = [grab('_pickTierRate'), grab('_pickTierRateUnder'), grab('calcTotalCostHTML')].join('\n');

  // 프로덕션 regulations_snapshot 실측 형태 (2026-08-16 DB)
  const TIERS = [{ underAuk: 6, rate: 0.01 }, { underAuk: 9, rate: 0.02 }, { underAuk: 999, rate: 0.03 }];
  const CFG = {
    acquisitionTax: {
      noHouse: { tiers: TIERS, firstBuyerExempt: { deductManwon: 200, eligibleUnderAuk: 12 } },
      oneHouse: { tiers: TIERS },
      twoHousePlus: { rate: 0.08 },
    },
    commission: [
      { rate: 0.006, underAuk: 0.5 }, { rate: 0.005, underAuk: 2 }, { rate: 0.004, underAuk: 9 },
      { rate: 0.005, underAuk: 12 }, { rate: 0.006, underAuk: 15 }, { rate: 0.007, underAuk: 999 },
    ],
    eduTaxRate: 0.1, spclTaxRate: 0.002, spclTaxThreshold: 0.01,
    regFee: { rate: 0.0015, baseManwon: 20 },
  };

  const { calcTotalCost } = require('../services/analysisService');
  // 경계를 낀 매수가 — 6·9(취득세 구간), 12(생애최초 한도), 0.5~15(중개보수 구간)
  const PRICES = [0.4, 0.5, 3, 5, 6, 6.5, 7, 8, 9, 9.01, 11, 12, 12.01, 15, 20];
  const STATUS = ['무주택', '1주택', '2주택+'];
  const REG = [true, false, undefined];   // undefined = 지역 모름 → 보수적 중과 유지

  let checked = 0;
  const bad = [];
  for (const useCfg of [true, false]) {   // 스냅샷 경로 · 폴백 경로 둘 다
    const fn = new Function('window', `${src}; return calcTotalCostHTML;`)(
      { __TAX_CONFIG: useCfg ? CFG : undefined });
    for (const price of PRICES) for (const hs of STATUS) for (const fb of [false, true]) {
      for (const reg of REG) for (const loan of [0, 1, 3]) {
        const out = fn(price, loan, hs, fb, reg);
        const be = calcTotalCost(price, loan, hs, fb, useCfg ? CFG : undefined, reg);
        checked++;
        const label = `cfg=${useCfg} ${price}억 ${hs} 생애최초=${fb} 조정=${reg} 대출=${loan}`;
        const mRate = out.match(/취득세 \(([\d.]+)%\)/);
        const mTot = out.match(/약 (-?[\d.]+)~(-?[\d.]+)억/);
        if (!mRate || !mTot) { bad.push(label + ` → 화면 문자열을 파싱할 수 없다`); continue; }
        if (Number(mRate[1]) !== be.taxRate) bad.push(label + ` 세율 프론트=${mRate[1]} 백엔드=${be.taxRate}`);
        if (Number(mTot[1]) !== be.totalLow) bad.push(label + ` 필요현금 하한 프론트=${mTot[1]} 백엔드=${be.totalLow}`);
        if (Number(mTot[2]) !== be.totalHigh) bad.push(label + ` 필요현금 상한 프론트=${mTot[2]} 백엔드=${be.totalHigh}`);
        // ⚠ 백엔드의 firstBuyerDeduct 는 **억 단위 2자리 반올림된 표시값**이다(0.4억 매물의 40만원 공제는 0.00 이 된다).
        //   그래서 "공제가 있었나" 를 불리언으로 보면 거짓 불일치가 난다 — 프론트가 찍은 금액과 같은 단위로 맞춘다.
        const mFb = out.match(/생애최초 감면[\s\S]*?>-([\d.]+)억</);
        const feFbVal = mFb ? Number(mFb[1]) : 0;
        if (feFbVal !== be.firstBuyerDeduct) bad.push(label + ` 생애최초 감면 프론트=${feFbVal} 백엔드=${be.firstBuyerDeduct}`);
      }
    }
  }
  assert.ok(checked >= 700, `대조 조합이 너무 적다(${checked}) — 그리드가 축소됐는지 확인할 것`);
  assert.deepEqual(bad.slice(0, 8), [], `프론트 계산기와 백엔드가 갈렸다(${bad.length}/${checked}건):\n  ` + bad.slice(0, 8).join('\n  '));
});


// ── ACQ-UNKNOWN-COUNT-2026-09-06 (Plan 036: 3주택 이상 4,500만원 과소 안내 되돌림) ──────
//   [왜 추가하나] ACQ-REG-CALC-2026-09-02 는 '2주택+' 가 확인된 비조정지역이면 무주택
//     기본세율(1~3%)을 쓰게 했다. 그런데 '2주택+' 칩은 2주택과 3주택 이상을 **구분하지 않는다**
//     (지방세법 §13-2 상 비조정지역은 2주택=기본세율/3주택=8%/4주택+=12%). 그래서 09-02 는
//     비조정지역 3주택 이상에게 8% 대신 1~3% 를 안내해 9억 매수 기준 약 4,500만원을
//     **과소 안내**했다(정답 7,200만원 → 표기 2,700만원). 금전 도구에서 과소 안내는 실제 피해다.
//   [무엇을 고정하나] '2주택+' 는 isRegulated 값(true/false/undefined)과 무관하게 항상 보수적
//     중과(8%, 또는 taxConfig.twoHousePlus.rate)를 쓰고, 무주택·1주택의 6~9억 누진은 영향받지
//     않는다. 프론트(calcTotalCostHTML)와 백엔드(calcTotalCost)를 **실제로 실행해** 값을 맞춘다
//     ("소스가 이렇게 생겼다" 는 정규식 검사는 분기 반전을 못 잡는다는 것이 이 저장소에서
//     실측됐다 — 468/1,620 조합이 갈렸는데 그런 검사는 전부 초록이었다).
test('취득세: 2주택+ 는 주택수 불확정 — 프론트·백엔드 실행값이 조정/비조정 무관 8%로 일치(Plan 036)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  const { calcTotalCost } = require('../services/analysisService');

  const grab = (name) => {
    const m = html.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    assert.ok(m, `frontend/index.html 에서 ${name} 을 찾지 못했다 — 함수명이 바뀌었다면 이 테스트도 갱신할 것`);
    return m[0];
  };
  const src = [grab('_pickTierRate'), grab('_pickTierRateUnder'), grab('calcTotalCostHTML')].join('\n');

  const TIERS = [{ underAuk: 6, rate: 0.01 }, { underAuk: 9, rate: 0.02 }, { underAuk: 999, rate: 0.03 }];
  const CFG = {
    acquisitionTax: { noHouse: { tiers: TIERS }, oneHouse: { tiers: TIERS }, twoHousePlus: { rate: 0.08 } },
  };
  // 무주택 6~9억 누진 기대값 — 지방세법 §11①8호, 기존 특성화 테스트(:44)의 7억 taxRate:1.7 과 동일 공식.
  const expectedProgRate = Math.round(((7 * 2 / 3 - 3) / 100) * 1000) / 10;

  for (const useCfg of [true, false]) {   // snapshot 경로 · 폴백 경로 둘 다(어느 한쪽만 고치는 재발 차단)
    const tag = useCfg ? 'snapshot' : 'fallback';
    const fn = new Function('window', `${src}; return calcTotalCostHTML;`)({ __TAX_CONFIG: useCfg ? CFG : undefined });

    // calcTotalCostHTML 은 HTML 문자열을 반환하므로 "취득세 (N%)" 라벨을 파싱한다 — 프론트·백엔드
    // 둘 다 Math.round(rate*1000)/10 로 반올림해 taxRate 와 같은 단위로 비교할 수 있다.
    const frontRate = (price, houseStatus, isRegulated) => {
      const out = fn(price, 0, houseStatus, false, isRegulated);
      const m = out.match(/취득세 \(([\d.]+)%\)/);
      assert.ok(m, `[${tag}] 프론트 출력에서 취득세율을 파싱하지 못했다: ${out.slice(0, 200)}`);
      return Number(m[1]);
    };
    const backRate = (price, houseStatus, isRegulated) =>
      calcTotalCost(price, 0, houseStatus, false, useCfg ? CFG : undefined, isRegulated).taxRate;

    // ①★ 비조정(isRegulated===false) + 2주택+ + 9억 → 8% — 이번 결함의 핵심 케이스.
    assert.equal(frontRate(9, '2주택+', false), 8, `[${tag}] 프론트: 비조정 2주택+ 9억이 8%가 아니다`);
    assert.equal(backRate(9, '2주택+', false), 8, `[${tag}] 백엔드: 비조정 2주택+ 9억이 8%가 아니다`);

    // ② 조정(isRegulated===true) + 2주택+ + 9억 → 8% (변화 없음)
    assert.equal(frontRate(9, '2주택+', true), 8, `[${tag}] 프론트: 조정 2주택+ 9억이 8%가 아니다`);
    assert.equal(backRate(9, '2주택+', true), 8, `[${tag}] 백엔드: 조정 2주택+ 9억이 8%가 아니다`);

    // ③ isRegulated 미지정(undefined) + 2주택+ → 8% (종전 동작 유지)
    assert.equal(frontRate(9, '2주택+', undefined), 8, `[${tag}] 프론트: 미상 2주택+ 9억이 8%가 아니다`);
    assert.equal(backRate(9, '2주택+', undefined), 8, `[${tag}] 백엔드: 미상 2주택+ 9억이 8%가 아니다`);

    // ④ 무주택·1주택의 6~9억 누진은 이 변경과 무관하게 그대로다: 7억 무주택 → (7*2/3-3)/100
    assert.equal(frontRate(7, '무주택', false), expectedProgRate, `[${tag}] 프론트: 무주택 7억 누진이 달라졌다`);
    assert.equal(backRate(7, '무주택', false), expectedProgRate, `[${tag}] 백엔드: 무주택 7억 누진이 달라졌다`);

    // ⑤ 프론트·백엔드가 위 네 케이스 전부 같은 값을 낸다(한쪽만 고치는 재발을 여기서 잡는다)
    for (const [price, hs, reg] of [[9, '2주택+', false], [9, '2주택+', true], [9, '2주택+', undefined], [7, '무주택', false]]) {
      assert.equal(frontRate(price, hs, reg), backRate(price, hs, reg),
        `[${tag}] 프론트·백엔드 불일치: ${price}억 ${hs} 조정=${reg}`);
    }
  }
});
