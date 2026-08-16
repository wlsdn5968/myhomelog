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
  const _regLtvLabel = new Function('isRegFront', 'SEOUL_GU_KW', 'window',
    `${m[0]}; return _regLtvLabel;`)(() => true, ['강서', '중구'], { __REG_KW: undefined });

  assert.equal(_regLtvLabel('서울 강남구', '11680'), '40%');  // 서울 = 규제
  assert.equal(_regLtvLabel('서울 중구', '11140'), '40%');    // 서울 중구(동명) = 규제
  assert.equal(_regLtvLabel('강서구', '26440'), '70%');       // ★ 부산 강서구 — 이름은 걸려도 비규제
  assert.equal(_regLtvLabel('중구', '26110'), '70%');         // ★ 부산 중구 — 비규제
  assert.equal(_regLtvLabel('수원시팔달구', '41115'), '40%'); // 경기는 이름 매칭 대상
  assert.equal(_regLtvLabel('', ''), null);                   // 지역 미상 → 라벨 생략
});

// ── Sprint XXXXXX: cron 관측 기록이 /api/health 로 새면 안 되는 값을 거르는지 ──────────
//   cronStats 는 job summary 를 Redis 에 담고 그 최근 1회가 **공개 health 응답**에 실린다.
//   job 이 나중에 새 필드(키·경로·사용자 식별자 등)를 요약에 추가해도 자동으로 노출되지 않도록
//   숫자 화이트리스트만 통과시키는데, 그 성질을 여기서 고정한다.
test('cronStats._pick — 숫자 화이트리스트만 통과, 그 외 필드는 유출되지 않는다', () => {
  const { _pick } = require('../services/cronStats');
  const out = _pick({
    inserted: 142, processed: 400, failed: 258, elapsedMs: 251000, poolSize: 3800,
    // 아래는 전부 빠져야 한다
    apiKey: 'secret-value', token: 'abc', userEmail: 'a@b.c', rows: [{ aptName: '홍길동아파트' }],
    kakao: { key: 'k' }, nested: { deep: { x: 1 } },
  });
  assert.deepEqual(out, { processed: 400, inserted: 142, failed: 258, poolSize: 3800, elapsedMs: 251000 });
  for (const k of ['apiKey','token','userEmail','rows','kakao','nested']) {
    assert.equal(k in out, false, `${k} 가 화이트리스트를 통과했다 — health 로 유출된다`);
  }
  // 실패 표기는 남긴다(진단 목적) — 단 문자열은 길이 제한
  const err = _pick({ ok: false, error: 'x'.repeat(500) });
  assert.equal(err.ok, false);
  assert.equal(err.error.length, 120);
  // 숫자가 아닌 값이 숫자 필드에 와도 통과시키지 않는다
  assert.deepEqual(_pick({ inserted: 'NaN아님', processed: null }), {});
  assert.deepEqual(_pick(null), {});
  // Sprint AAAAAAA: molit-ingest 카운터(ok·err·skipped)는 숫자일 때 통과, boolean 실패 표기와 공존
  assert.deepEqual(_pick({ ok: 0, err: 9, skipped: 108 }), { ok: 0, err: 9, skipped: 108 });
});

// ── Sprint AAAAAAA: MOLIT HTTP 에러 사유 추출 — 본문 통짜 저장 금지(키 에코 차단) ──────
//   실사고(2026-08-02~08): 전 지역 실패가 "Request failed with status code 400" 로만 남아
//   키 만료인지 게이트웨이 변경인지 6일간 확정 불가였다. 사유 필드는 남기되, 모르는 필드
//   (serviceKey 에코 등)는 절대 통과시키지 않는 성질을 고정한다.
test('molitErrReason — 알려진 사유 필드만 추출, 임의 본문은 유출되지 않는다', () => {
  const { molitErrReason } = require('../jobs/molitIngest');
  // data.go.kr 게이트웨이 JSON (실측 형태: 2026-08-08 브라우저 실호출)
  const gw = molitErrReason({ response: { status: 403, data: {
    OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', returnAuthMsg: '등록되지 않은 서비스키', returnReasonCode: '30' } },
  } } });
  assert.match(gw, /HTTP 403/);
  assert.match(gw, /SERVICE_KEY_IS_NOT_REGISTERED_ERROR/);
  assert.match(gw, /code=30/);
  // XML 문자열 응답에서도 errMsg 만 뽑는다
  const xml = molitErrReason({ response: { status: 400, data: '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>DEADLINE_HAS_EXPIRED_ERROR</errMsg></cmmMsgHeader></OpenAPI_ServiceResponse>' } });
  assert.match(xml, /HTTP 400/);
  assert.match(xml, /DEADLINE_HAS_EXPIRED_ERROR/);
  // 모르는 필드에 키가 에코돼도 결과에 실리지 않는다 — HTTP 상태까지만
  const echo = molitErrReason({ response: { status: 400, data: { requestedKey: 'SECRET-KEY-VALUE', anything: 'x' } } });
  assert.equal(echo, 'HTTP 400');
  assert.equal(echo.includes('SECRET'), false);
  // 응답 자체가 없으면(네트워크 단계) code/message 로
  assert.equal(molitErrReason({ code: 'ECONNABORTED', message: 'timeout' }), 'ECONNABORTED');
});

// ── Sprint BBBBBBB: 릴레이 클라이언트 — 폴백 판정·URL 조립·화이트리스트 계약 ─────────
//   08-02 실사고 시그니처(민짜400·code=10·RST)에만 릴레이하고, 정상 4xx(키오류 403/30 등)는
//   그대로 throw 해야 한다(릴레이 낭비·오진 방지). 화이트리스트는 Edge Function 쪽과 일치.
test('dataGoKrClient — IP-거부 패턴 판정과 정상 4xx 구분, URL 조립 인코딩', () => {
  const { _isBlockedPattern, _buildFullUrl, ALLOWED_HOSTS } = require('../services/dataGoKrClient');
  // 실측 시그니처들 → 릴레이 대상
  assert.equal(_isBlockedPattern({ code: 'ECONNRESET' }), true);
  assert.equal(_isBlockedPattern({ code: 'ECONNABORTED' }), true);
  assert.equal(_isBlockedPattern({ response: { status: 400, data: {} } }), true); // 민짜 400
  assert.equal(_isBlockedPattern({ response: { status: 400, data: { OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: '10' } } } } }), true);
  // 정상 게이트웨이 동작 → 릴레이 금지(그대로 throw)
  assert.equal(_isBlockedPattern({ response: { status: 403, data: { OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: '30' } } } } }), false);
  assert.equal(_isBlockedPattern({ response: { status: 500, data: {} } }), false);
  assert.equal(_isBlockedPattern(null), false);
  // URL 조립 — serviceKey 의 +,/,= 가 인코딩되고 기존 쿼리(ECOS 경로형)는 보존
  const u = _buildFullUrl('https://apis.data.go.kr/1613000/x/y', { serviceKey: 'a+b/c==', LAWD_CD: '11680' });
  assert.match(u, /serviceKey=a%2Bb%2Fc%3D%3D/);
  assert.match(u, /LAWD_CD=11680/);
  assert.equal(_buildFullUrl('https://ecos.bok.or.kr/api/K/key123/json/kr/1/100'), 'https://ecos.bok.or.kr/api/K/key123/json/kr/1/100');
  // 화이트리스트 — Edge Function(supabase/functions/datagokr-proxy)과 동일해야 한다
  assert.deepEqual([...ALLOWED_HOSTS].sort(), ['api.odcloud.kr', 'apis.data.go.kr', 'ecos.bok.or.kr']);
});

// ── Plan 002: geocode 전역 캡 판정 — Redis 미설정(null) 은 허용(fail-open), 초과만 차단 ──────
test('geocode _geocodeCapExceeded — 경계·fail-open', () => {
  const { _geocodeCapExceeded } = require('../routes/geocode');
  assert.equal(_geocodeCapExceeded(7999, 8000), false); // 상한 미만 — 허용
  assert.equal(_geocodeCapExceeded(8000, 8000), false); // 정확히 상한(이번 호출이 8000번째) — 허용
  assert.equal(_geocodeCapExceeded(8001, 8000), true);  // 초과 — 차단
  assert.equal(_geocodeCapExceeded(null, 8000), false); // Redis 미설정 — fail-open
  assert.equal(_geocodeCapExceeded(undefined, 8000), false);
});

// ── Plan 004: 결제 기간 이월 — P0(2026-05-04) "만료 전 재결제 시 잔여일 손실" 재발 방지 고정 ──
//   confirm/webhook 이 공유하는 단일 소스 computePeriodEnd 의 경계 4케이스를 고정한다.
test('computePeriodEnd — 잔여기간 이월 경계(미보유/과거/미래/정확히 현재)', () => {
  const { computePeriodEnd } = require('../services/planService');
  const now = new Date('2026-08-09T00:00:00Z');
  const D30 = 30 * 24 * 60 * 60 * 1000;
  // 미보유 → now+30일
  assert.equal(computePeriodEnd(null, now).getTime(), now.getTime() + D30);
  assert.equal(computePeriodEnd(undefined, now).getTime(), now.getTime() + D30);
  // 과거 만료 → now+30일 (이월 없음)
  assert.equal(computePeriodEnd('2026-08-08T00:00:00Z', now).getTime(), now.getTime() + D30);
  // 미래 만료(+5일) → 그 시점+30일 (잔여 5일 보존 — P0 의 핵심)
  assert.equal(computePeriodEnd('2026-08-14T00:00:00Z', now).getTime(),
    new Date('2026-08-14T00:00:00Z').getTime() + D30);
  // 정확히 현재 → now+30일 (`>` 비교 — 현재 동작 고정)
  assert.equal(computePeriodEnd('2026-08-09T00:00:00Z', now).getTime(), now.getTime() + D30);
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

// ── Plan 006 (2026-08-09): MOLIT 공통 파싱 헬퍼 — 5곳 복붙 통합의 동작 고정 ────────
//   parseAmountManwon 의 숫자 입력 케이스는 88e9303 실장애(monthlyRent=390 숫자 → TypeError)의
//   회귀 고정 — 깨지면 "문자열 전제 파싱" 이 되돌아온 것.
test('molitParse.parseAmountManwon — 콤마 문자열/숫자/빈값 전 케이스', () => {
  const { parseAmountManwon } = require('../utils/molitParse');
  assert.equal(parseAmountManwon('82,500'), 82500);
  assert.equal(parseAmountManwon('1,234'), 1234);
  assert.equal(parseAmountManwon(390), 390);       // 숫자 타입 (88e9303 회귀)
  assert.equal(parseAmountManwon('0'), 0);
  assert.equal(parseAmountManwon(0), 0);
  assert.equal(parseAmountManwon(null), 0);
  assert.equal(parseAmountManwon(undefined), 0);
  assert.equal(parseAmountManwon(''), 0);
});

test('molitParse.itemArray — 배열/단일 객체/undefined 정규화', () => {
  const { itemArray } = require('../utils/molitParse');
  const a = [{ x: 1 }, { x: 2 }];
  assert.equal(itemArray(a), a);                    // 배열은 그대로 (복사 없음 — 기존 동작)
  assert.deepEqual(itemArray({ x: 1 }), [{ x: 1 }]); // 단일 item 이 객체로 오는 MOLIT 특성
  assert.deepEqual(itemArray(undefined), []);
  assert.deepEqual(itemArray(null), []);
});

// ── Plan 007 (2026-08-09): Supabase 클라이언트 SSOT — 공개 읽기 키 체인 순서 고정 ──────
//   publishable 우선(defense in depth)·service_role 은 최후 폴백. 순서가 바뀌면 "공개 읽기"
//   경로가 의도보다 넓은 권한(RLS 우회)으로 먼저 붙는 회귀 — 반드시 이 순서 유지.
test('db/client._pickReadonlyKey — publishable > anon > service_role > service_role(소문자)', () => {
  const { _pickReadonlyKey } = require('../db/client');
  assert.equal(_pickReadonlyKey({ SUPABASE_PUBLISHABLE_KEY: 'p', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' }), 'p');
  assert.equal(_pickReadonlyKey({ SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' }), 'a');
  assert.equal(_pickReadonlyKey({ SUPABASE_SERVICE_ROLE_KEY: 's' }), 's');
  assert.equal(_pickReadonlyKey({ service_role: 'sr' }), 'sr');
  assert.equal(_pickReadonlyKey({}), null);
});

test('molitParse.isCanceled — cdealType 유/무/공백 판정', () => {
  const { isCanceled } = require('../utils/molitParse');
  assert.equal(isCanceled({ cdealType: 'O' }), true);
  assert.equal(isCanceled({ cdealType: 1 }), true);   // 숫자로 와도 해제로 판정
  assert.equal(isCanceled({ cdealType: '' }), false);
  assert.equal(isCanceled({ cdealType: '  ' }), false);
  assert.equal(isCanceled({}), false);
  assert.equal(isCanceled(null), false);
});

// ── IDENTITY-GATE (2026-08-10, Sprint KKKKKKK): KAPT 단지정보 오매칭 차단 ─────────────
//   운영자 발견 사고: 도봉구 방학동 "신동아아파트1"(1986년·3,169세대 방학신동아1단지)에
//   "신동아 타워 아파트"(1997년·104세대)가 붙어 단지정보 탭이 통째로 남의 단지였다.
//   원인은 ratio 게이트가 **이름이 짧은 후보를 편애**한 것(정답 0.429 차단 / 오답 0.600 통과).
// SIDO-SCOPE (2026-08-10): 동명 시군구 환각 — DB 실측으로 '중구'는 6개 시도(서울·부산·대구·인천·
//   대전·울산, 11,243건), '서구'는 4개 시도(17,350건)에 **같은 문자열**로 저장돼 있다
//   (molit_transactions.sigungu 에는 광역 접두가 없다). REGION_KEYWORDS 가 '중구'→서울(11140)로
//   고정돼 있어 "부산 중구"를 넣어도 **서울 중구 아파트**가 추천됐다. 광역 접두로 먼저 좁혀야 한다.
test('pickRegions — 광역 접두로 동명 구를 정확히 구분한다', () => {
  const { pickRegions } = require('../services/propertyService');
  const first = (r) => { const x = pickRegions(r, 10); return x && x[0] ? x[0].lawdCd : null; };

  // 같은 '중구'라도 광역에 따라 다른 코드여야 한다 (예전엔 전부 11140 서울이었다)
  assert.equal(first('서울 중구'), '11140');
  assert.equal(first('인천 중구'), '28110');
  assert.equal(first('부산 중구'), '26110');
  assert.equal(first('대구 중구'), '27110');
  assert.equal(first('대전 중구'), '30140');
  assert.equal(first('울산 중구'), '31110');

  // '서구'도 마찬가지
  assert.equal(first('인천 서구'), '28260');
  assert.equal(first('부산 서구'), '26140');
  assert.equal(first('대전 서구'), '30170');

  // '강서구' — 서울(11500) vs 부산(26440)
  assert.equal(first('서울 강서구'), '11500');
  assert.equal(first('부산 강서구'), '26440');

  // 부분문자열 함정: '남동구' 안에 '동구'가 들어 있다 → 더 긴 이름을 택해야 한다
  assert.equal(first('인천 남동구'), '28200');
  assert.equal(first('인천 동구'), '28140');

  // 기존 동작 회귀 확인: 서울 고유 구·경기 별칭·지방 세부는 그대로여야 한다
  assert.equal(first('서울 강남구'), '11680');
  assert.equal(first('경기 분당'), '41135');
  assert.equal(first('지방 해운대'), '26350');
  assert.equal(first('지방 청주'), '43111');
});

// LAWD-FIRST (2026-08-10): 시도교육청을 **구 이름으로 추정**하면 남의 지역 학교 정보가 붙는다.
//   기존 구현은 "…구로 끝나면 서울"이라 해운대구·수성구·유성구·청주시상당구가 전부 B10(서울)이었고,
//   NEIS 는 (시도교육청 + 학교명)으로 조회하므로 동명 학교가 서울에 있으면 **서울 학교의 학생수**가
//   그 단지 정보로 붙었다. 행정구역 판정은 lawd_cd 로 한다(반복 확인된 원칙).
test('schoolNeis.inferAtptCode — lawd_cd 우선, 모호한 구 이름은 판정 포기', () => {
  const { inferAtptCode } = require('../services/schoolNeisService');
  // lawd_cd 가 있으면 그것으로 확정 — 이름이 무엇이든 정확하다
  assert.equal(inferAtptCode('청주시상당구', '43111'), 'M10'); // 충북
  assert.equal(inferAtptCode('해운대구', '26350'), 'C10');     // 부산 (예전엔 서울로 오판)
  assert.equal(inferAtptCode('수성구', '27260'), 'D10');       // 대구
  assert.equal(inferAtptCode('유성구', '30200'), 'G10');       // 대전
  assert.equal(inferAtptCode('강남구', '11680'), 'B10');       // 서울
  assert.equal(inferAtptCode('수원시영통구', '41117'), 'J10'); // 경기

  // lawd_cd 가 없을 때: 서울 고유 자치구만 인정
  assert.equal(inferAtptCode('강남구'), 'B10');
  assert.equal(inferAtptCode('수원시영통구'), 'J10'); // 시+구 합성어는 모호하지 않다
  // 여러 시도에 함께 있는 이름은 **null** — 서울로 단정하면 환각이 된다
  assert.equal(inferAtptCode('중구'), null);
  assert.equal(inferAtptCode('서구'), null);
  assert.equal(inferAtptCode('해운대구'), null); // 예전엔 B10 을 반환했다
  assert.equal(inferAtptCode(''), null);
  assert.equal(inferAtptCode(null), null);
});

// JIBUN-MISMATCH (2026-08-10): 좌표가 **남의 단지**에 찍혔는지는 지번 본번으로 판정한다.
//   운영자 발견 실사고: '신동아아파트3'(신고 지번 방학동 530)의 저장 좌표가 272("신동아1단지 3동")로,
//   같은 동이라 거리(300m) 기준만으로는 '검증 통과'로 박제될 수 있었다. 본번 비교가 그걸 잡는다.
test('geocacheBackfill.addrBonbun — 주소 끝 지번의 본번만 추출(부번 무시)', () => {
  const { addrBonbun } = require('../jobs/geocacheBackfill');
  assert.equal(addrBonbun('서울 도봉구 방학동 271-4'), '271'); // 대단지 다필지 → 본번만
  assert.equal(addrBonbun('서울 도봉구 방학동 272'), '272');
  assert.equal(addrBonbun('서울 도봉구 방학동 530'), '530');
  assert.equal(addrBonbun('경기 안양시 동안구 호계동 946-13'), '946');
  assert.equal(addrBonbun('경기 평택시 동삭동'), null);        // 번지 없는 주소 → 판정 불가
  assert.equal(addrBonbun(''), null);
  assert.equal(addrBonbun(null), null);

  // 실사고 재현: 신고 지번(530)과 저장 좌표 주소(272)의 본번이 다르면 '다른 단지'로 판정돼야 한다
  const 저장 = addrBonbun('서울 도봉구 방학동 272');
  const 신고 = addrBonbun('서울 도봉구 방학동 530');
  assert.ok(저장 && 신고 && 저장 !== 신고, '신동아아파트3 은 지번 불일치로 강제 교정 대상이어야 한다');

  // 정상 케이스: 신고 271-1 vs 저장 271-4 → 본번 271 로 같으므로 교정하지 않는다(오탐 방지)
  assert.equal(addrBonbun('서울 도봉구 방학동 271-1'), addrBonbun('서울 도봉구 방학동 271-4'));
});

// ZERO-FETCH-WATCH (2026-08-10): 광주 5개 구가 44일간 rows_fetched=0 인데 status='ok' 라
//   기존 지표(ok/err)로 전혀 안 보였다. 관측 필드를 열되 화이트리스트의 보안 성질은 유지해야 한다.
test('cronStats._pick — 지역 정체 감시 필드는 통과, 임의 필드는 여전히 차단', () => {
  const { _pick } = require('../services/cronStats');
  const out = _pick({
    zeroFetchRegions: 5, zeroFetchLawds: '29110,29140,29155', slot: 2, regionsCount: 39,
    verifyFixed: 12, rehealHealed: 3,
    serviceKey: 'SECRET', apiKey: 'SECRET', results: [{ lawdCd: '29110' }],
  });
  assert.equal(out.zeroFetchRegions, 5);
  assert.equal(out.zeroFetchLawds, '29110,29140,29155'); // 법정동 코드 = 공개 정보
  assert.equal(out.slot, 2);
  assert.equal(out.verifyFixed, 12);
  assert.equal(out.rehealHealed, 3);
  // 화이트리스트 밖은 무조건 배제 (민감값 유출 방지 — 이 성질이 깨지면 안 된다)
  assert.equal(out.serviceKey, undefined);
  assert.equal(out.apiKey, undefined);
  assert.equal(out.results, undefined);
  // 빈 문자열은 "보고되지 않음"이므로 키 자체가 없어야 한다
  assert.equal(_pick({ zeroFetchLawds: '' }).zeroFetchLawds, undefined);
});

test('aptFacility.jibunFromKaptAddr — KAPT 지번주소에서 지번만 추출', () => {
  const { jibunFromKaptAddr } = require('../services/aptFacilityService');
  assert.equal(jibunFromKaptAddr('서울특별시 도봉구 방학동 271-1 방학신동아1단지'), '271-1');
  assert.equal(jibunFromKaptAddr('서울특별시 도봉구 방학동 736 신동아 타워 아파트'), '736');
  // 단지명에 숫자가 있어도 동 뒤 첫 지번만 — 단지명 숫자를 지번으로 오인하면 안 된다
  assert.equal(jibunFromKaptAddr('서울특별시 도봉구 방학동 738 방학신동아5단지'), '738');
  assert.equal(jibunFromKaptAddr(''), null);
  assert.equal(jibunFromKaptAddr(null), null);
});

test('aptFacility.bonbun — 부번 제거(대단지 다필지 흡수)', () => {
  const { bonbun } = require('../services/aptFacilityService');
  assert.equal(bonbun('271-1'), '271');
  assert.equal(bonbun('271'), '271');
  assert.equal(bonbun(' 530 '), '530');
  assert.equal(bonbun(''), null);
  assert.equal(bonbun(null), null);
});

test('aptFacility.verifyCandidate — 준공연도 불일치는 거부, 지번 일치는 채택', () => {
  const { verifyCandidate } = require('../services/aptFacilityService');
  const 신동아1 = { buildYear: 1986, jibunBon: '271' };

  // 실제 사고: 1986년 단지에 1997년 KAPT(11년 차이) → 반드시 거부
  const 타워 = verifyCandidate('19970825', '서울특별시 도봉구 방학동 736 신동아 타워 아파트', 신동아1, 'token');
  assert.equal(타워.ok, false);

  // 정답: 지번(271-1 → 271) 일치 → 이름이 달라도 채택
  const 정답 = verifyCandidate('19861231', '서울특별시 도봉구 방학동 271-1 방학신동아1단지', 신동아1, 'token');
  assert.equal(정답.ok, true);
  assert.equal(정답.reason, 'jibun-match');

  // 지번 **불일치는 거부 근거가 아니다** — 이름 완전일치(확실한 정답) 2,426쌍 중 10.47%가
  //   본번 불일치(대단지 다필지)라, 거부하면 정상 매칭 10%를 날린다. 연도가 맞으면 통과해야 한다.
  const 다른필지 = verifyCandidate('19861231', '서울특별시 도봉구 방학동 999 다른필지등록', 신동아1, 'token');
  assert.equal(다른필지.ok, true);

  // 약한 매칭(토큰)은 ±1년, 이름 완전일치는 ±3년까지 허용
  assert.equal(verifyCandidate('19880101', '주소없음', { buildYear: 1986 }, 'token').ok, false);
  assert.equal(verifyCandidate('19880101', '주소없음', { buildYear: 1986 }, 'exact').ok, true);

  // 신원 정보가 없으면 기존 동작 유지(통과) — 검증 불가를 거부로 바꾸면 회귀
  assert.equal(verifyCandidate('19970825', '아무주소', null, 'token').ok, true);
});

test('geocacheBackfill.canFastVerify — Kakao 호출 없이 통과시켜도 되는 조건 (Sprint KKKKKKK-10)', () => {
  const { canFastVerify } = require('../jobs/geocacheBackfill');

  // 통과: 신고 지번(271-1)과 저장 주소(271-4)의 **본번이 같다** = 같은 필지.
  //   부번 차이는 대단지 다필지라 정상이고, 여기서 끝내면 Kakao 왕복 1회가 통째로 사라진다.
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '서울 도봉구 방학동 271-4',
    officialAddress: '도봉구 방학동 271-1', placeName: '신동아1단지아파트 노인정',
  }), true);

  // 거부: 본번이 다르다(신고 530 vs 저장 272) — 실사고 재현. 남의 단지에 찍힌 좌표이므로
  //   반드시 지오코딩 경로로 내려가 교정돼야 한다.
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '서울 도봉구 방학동 272',
    officialAddress: '도봉구 방학동 530', placeName: '신동아1단지아파트 3동',
  }), false);

  // 거부: 주소가 MOLIT 신고 지번이 아니라 KAPT 폴백 — kaptCode 자체가 이름 매칭 산물이라
  //   오염 가능(IDENTITY-GATE). 본번이 같아 보여도 무호출 통과시키지 않는다.
  assert.equal(canFastVerify({
    addrFromMolit: false, storedAddress: '서울 도봉구 방학동 736',
    officialAddress: '서울특별시 도봉구 방학동 736', placeName: null,
  }), false);

  // 거부: 비주거 상호 — 본번이 같아도 NONRES 강제 교정 대상이라 종전 판정을 유지해야 한다.
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '서울 노원구 월계동 100-1',
    officialAddress: '노원구 월계동 100', placeName: '동신손세차',
  }), false);

  // 거부: 본번을 뽑을 수 없으면 판정 불가 → 종전 경로(거리 검증)로.
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '경기 평택시 동삭동',
    officialAddress: '평택시 동삭동 500', placeName: null,
  }), false);
});

test('chatDataRouter.classifyIntent — 의도 분류 고정 (Sprint KKKKKKK-16, 비용 0 라우터)', () => {
  const { classifyIntent } = require('../services/chatDataRouter');
  const c = (m) => classifyIntent(m);

  // 시세: 단지명 추출 + 끝의 '아파트' 접미사만 제거 (search.js SEARCH-SUFFIX 와 동일 비대칭 해소)
  assert.deepEqual(c('은마 시세'), { intent: 'market', query: '은마' });
  assert.deepEqual(c('은마아파트 시세 알려줘'), { intent: 'market', query: '은마' });
  assert.equal(c('헬리오시티').intent, 'market');            // 단지명 단독 입력
  assert.equal(c('신동아아파트1 실거래').query, '신동아아파트1'); // 이름 중간 '아파트' 훼손 금지
  assert.equal(c('시세 알려줘').query, null);                 // 단지명 없음 → 되묻기 대상

  // 구체 의도가 광범위 의도(시세)보다 우선
  assert.equal(c('오늘 금리 알려줘').intent, 'rates');
  assert.equal(c('동탄 규제 맞아?').intent, 'regulation');
  assert.equal(c('5억이면 대출 얼마까지 돼?').intent, 'loanLimit');
  assert.equal(c('디딤돌 대출 조건').intent, 'policyLoan');   // '대출' 있어도 정책자금 우선
  assert.equal(c('요즘 인기 단지 알려줘').intent, 'popular');
  assert.equal(c('전세가율이 뭐야').intent, 'jeonse');
  assert.equal(c('특약 어떻게 써?').intent, 'clause');
  assert.equal(c('안녕하세요').intent, 'greeting');
  assert.equal(c('사용법 알려줘').intent, 'howto');

  // 분류 불가는 fallback (아는 척 금지 — 환각 차단)
  assert.equal(c('오늘 저녁 뭐 먹지?').intent, 'fallback');
  assert.equal(c('').intent, 'fallback');
});

test('chatDataRouter.route — DB 무관 인텐트는 항상 성립 + 추천 표현 부재 (절대 룰 ①)', async () => {
  const { route } = require('../services/chatDataRouter');
  // env/DB 없이도 성립해야 하는 경로들 (라우터는 데이터 실패를 개별 삼킴)
  for (const msg of ['안녕하세요', '특약 알려줘', '5억 대출 한도', '사용법', '이해 안 가는 질문 xyz?']) {
    const { reply } = await route(msg, null);
    assert.equal(typeof reply, 'string');
    assert.ok(reply.length > 20, `응답이 비었음: ${msg}`);
    // 절대 룰 ①: 매수·매도 추천 단언 표현 금지
    assert.ok(!/사세요|파세요|매수하세요|추천드려요|오를 겁니다|떨어질 겁니다/.test(reply), `금지 표현 감지: ${msg}`);
  }
  // 시세 인텐트 + 단지명 없음 + 컨텍스트 없음 → 되묻기(친절)
  const { reply: ask } = await route('시세 알려줘', null);
  assert.ok(/단지명/.test(ask));
});

test('chatDataRouter — 추천 요청 전용 응답 + 동사어미 문장 단지명 오인 방지 (KKKKKKK-16d)', async () => {
  const { classifyIntent, route } = require('../services/chatDataRouter');
  // 라이브 실채팅에서 발각: "오늘 저녁 메뉴 추천해줘"가 단지명으로 오인됐다
  assert.equal(classifyIntent('오늘 저녁 메뉴 추천해줘').intent, 'recommendAsk');
  assert.equal(classifyIntent('단지 추천해줘').intent, 'recommendAsk');
  assert.equal(classifyIntent('그냥 아무말이나 해볼게요').intent, 'fallback');
  // 어미 검사(끝 위치만)가 실제 단지명을 훼손하지 않아야 함
  assert.equal(classifyIntent('해모로').intent, 'market');
  // 구체 의도(인기)는 '추천'보다 우선
  assert.equal(classifyIntent('인기 단지 추천해줘').intent, 'popular');
  // 추천 응답은 절대 룰 ① 준수 + 대안 제시
  const { reply } = await route('추천해줘', null);
  assert.ok(/추천은 정책상 하지 않아요/.test(reply) && /내 상황/.test(reply));
});

test('chatDataRouter — 지역 스코프 인기 단지 추출 (KKKKKKK-17, 운영자 "공덕 인기단지 되게")', async () => {
  const { classifyIntent, route } = require('../services/chatDataRouter');
  // 지역 토큰 추출 — 판정은 데이터(sigungu/umd 매칭)가 하고, 여기선 추출만 고정
  assert.deepEqual(classifyIntent('공덕 인기단지'), { intent: 'popular', query: '공덕' });
  assert.deepEqual(classifyIntent('노원구 인기단지'), { intent: 'popular', query: '노원구' });
  assert.deepEqual(classifyIntent('서울 중구 인기단지 알려줘'), { intent: 'popular', query: '서울 중구' });
  assert.deepEqual(classifyIntent('요즘 인기 단지 알려줘'), { intent: 'popular', query: null });
  // env/DB 없이도 안전: 지역 해석 실패 → 정직 폴백 문구 + 전국 안내로 성립
  const { reply } = await route('공덕 인기단지', null);
  assert.equal(typeof reply, 'string');
  assert.ok(reply.length > 20);
});

test('chatDataRouter — 지역 시세 요약 확장, env 무관 성립 (KKKKKKK-18)', async () => {
  const { route } = require('../services/chatDataRouter');
  // env/DB 없이: 지역 해석기 null → 기존 단지 경로 안내로 자연 폴백 (throw 없이 성립)
  for (const msg of ['공덕 시세', '노원구 시세', '시세 알려줘']) {
    const { reply } = await route(msg, null);
    assert.equal(typeof reply, 'string');
    assert.ok(reply.length > 20, `빈 응답: ${msg}`);
  }
});

test('chatDataRouter — 모든 인텐트가 후속 질문(suggestions)을 동봉 (KKKKKKK-19)', async () => {
  const { route, classifyIntent } = require('../services/chatDataRouter');
  // 정적 인텐트 전수: suggestions 는 항상 1개 이상, 전부 실제로 라우팅되는 질문(죽은 예시 금지)
  for (const msg of ['안녕하세요', '특약 알려줘', '5억 대출 한도', '사용법', '추천해줘', '전세가율이 뭐야', '모르는말xyz?']) {
    const { reply, suggestions } = await route(msg, null);
    assert.equal(typeof reply, 'string');
    assert.ok(Array.isArray(suggestions) && suggestions.length >= 1, `suggestions 비어있음: ${msg}`);
    assert.ok(suggestions.length <= 3);
    for (const s of suggestions) {
      if (typeof s === 'string') {
        assert.ok(classifyIntent(s).intent !== 'fallback', `죽은 예시(라우팅 불가): "${s}" ← ${msg}`);
      } else {
        // KKKKKKK-20: 이동형 칩 — label + 화이트리스트 view 만 허용
        assert.ok(typeof s.label === 'string' && s.label.length >= 2, `이동 칩 label 불량 ← ${msg}`);
        assert.ok(['report', 'calc', 'clause', 'map', 'list'].includes(s.view), `이동 칩 view 불량: ${s.view} ← ${msg}`);
      }
    }
  }
});

test('chatDataRouter — 관심단지(watch) 인텐트 + 보고서 퍼널 이동 칩 (KKKKKKK-20)', async () => {
  const { classifyIntent, route } = require('../services/chatDataRouter');
  assert.equal(classifyIntent('관심단지 소식 알려줘').intent, 'watch');
  assert.equal(classifyIntent('찜한 단지 어때?').intent, 'watch');
  // 북마크가 없으면 담는 방법 안내(정직) — env/DB 무관 성립
  const { reply: empty } = await route('관심단지 소식', { session: { bookmarks: [] } });
  assert.ok(/담아둔 관심단지가 없어요/.test(empty));
  // 한도 질문 응답에는 보고서 이동 칩이 동봉된다 (퍼널 연결 고정)
  const { suggestions } = await route('5억 대출 한도', null);
  assert.ok(suggestions.some(s => s && typeof s === 'object' && s.view === 'report'), '보고서 이동 칩 부재');
});

test('규제 감시 — 룰베이스 대조는 SQL·confidence 를 만들지 않는다 (REG-ZERO-COST, Sentry NODE-7)', async () => {
  const { analyzeRegulations } = require('../jobs/regulationsAiCheck');
  // 스냅샷 key 리터럴을 `key:` 자리에 직접 두지 않는다 — gitleaks generic-api-key 가
  //   "key: '<고엔트로피 문자열>'" 을 자격증명으로 오탐해 CI 가 실제로 막혔다(run 31917863984).
  //   (.gitleaks.toml allowlist 로도 막아뒀다. 여기 상수명에도 key/token/secret 을 쓰지 말 것.)
  const TAX_SNAP = 'acquisition_tax_2025';
  const LOAN_SNAP = 'housing_loan_2025';
  const snap = [
    { key: TAX_SNAP, note: '취득세 스냅샷' },
    { key: LOAN_SNAP, note: '주담대 스냅샷' },
  ];
  const src = (name, matched) => ({ name, matched });

  // ① 매칭 항목 0건 → 확인 필요 0, topAlert 없음
  const none = await analyzeRegulations([src('국세청', [])], snap);
  assert.equal(none.reviewNeededCount, 0);
  assert.equal(none.topAlert, null);

  // ② 취득세 보도자료는 취득세 key 에만 붙는다 (주제 키워드 분리 — 전 key 무차별 매칭 회귀 차단)
  const tax = await analyzeRegulations([src('국세청', [
    { title: '2026년 취득세 중과 개편 방안', link: 'https://korea.kr/x', pubDate: new Date('2026-08-14'), hits: ['취득세', '중과'] },
  ])], snap);
  const byKey = Object.fromEntries(tax.analysis.map(a => [a.key, a]));
  assert.equal(byKey[TAX_SNAP].evidenceCount, 1);
  assert.equal(byKey[LOAN_SNAP].evidenceCount, 0, '취득세 기사가 주담대 스냅샷에도 붙음');
  assert.equal(byKey[TAX_SNAP].reviewNeeded, true);

  // ③ 환각 차단 계약: 어떤 경우에도 proposedSQL·confidence 를 지어내지 않고, '변경'을 단정하지 않는다.
  //    (종전 AI 판정은 confidence≥90 이면 UPDATE 문까지 생성했다 — 되살리면 이 테스트가 깨진다.)
  for (const a of tax.analysis) {
    assert.equal(a.proposedSQL, null, `proposedSQL 자동 생성 부활: ${a.key}`);
    assert.equal(a.confidence, null, `confidence 점수 조작 부활: ${a.key}`);
    assert.equal(a.changeDetected, false, `룰베이스가 변경을 단정: ${a.key}`);
  }
  assert.ok(/변경 확정 아님/.test(tax.topAlert), 'topAlert 가 변경을 단정하는 문구로 회귀');
});

test('규제 감시 — 주제 키워드 미정의 key 는 누락이 아니라 과보고로 실패한다 (REG-ZERO-COST)', async () => {
  const { analyzeRegulations } = require('../jobs/regulationsAiCheck');
  const FUTURE_SNAP = 'future_policy_2027'; // 상수명에 key/token/secret 금지 (gitleaks 오탐)
  const r = await analyzeRegulations([{ name: '금융위원회', matched: [
    { title: '주택담보대출 LTV 규제 조정', link: 'https://fsc.go.kr/y', pubDate: new Date('2026-08-15'), hits: ['LTV'] },
  ] }], [{ key: FUTURE_SNAP, note: '미정의 키' }]);
  assert.equal(r.analysis[0].evidenceCount, 1, '미정의 key 가 조용히 0건으로 떨어짐');
  assert.ok(/미정의 key/.test(r.analysis[0].reasoning));
});

// SNAPROLE-2026-08-16 (Sprint MMMMMMM) — NODE-9 순환의 마지막 고리를 고정한다.
//   실측: pg_db_role_setting 의 anon.statement_timeout = 3s, service_role 은 항목 없음.
//   집계 RPC 를 2회 연속 EXPLAIN ANALYZE 한 결과 **콜드 5,672ms → 웜 198ms**(정렬이 work_mem 을
//   넘겨 temp 481/483 디스크로 흐름). cron 은 하루 1회라 항상 콜드에 가까워 3s 를 확실히 초과 →
//   08-14·08-15 cron 연속 실패, 스냅샷 54h 노화(신선도 36h 미달) → 사용자가 라이브 집계 직격.
//   service_role 로 바꾸면 최소한 3s 컷은 벗어난다(정확한 실효 상한은 미검증 — popularService
//   주석의 [미검증] 항목 참조. 8s 라면 여유 2.3s 뿐이라 거래량 증가 시 재점검 필요).
//   이 테스트가 깨지면 "cron 이 다시 공개키로 집계한다"는 뜻 — 스냅샷 생산이 또 멈춘다.
test('popularService — cron 스냅샷 집계는 service_role 로 조회한다 (anon 3s 컷 회피)', async () => {
  const clientPath = require.resolve('../db/client');
  const geoPath = require.resolve('../services/geocodeCacheService');
  const svcPath = require.resolve('../services/popularService');
  const saved = { c: require.cache[clientPath], g: require.cache[geoPath], s: require.cache[svcPath] };

  const today = new Date().toISOString().slice(0, 10);
  const rows = Array.from({ length: 12 }, (_, i) => ({
    aptName: `단지${i}`, sigungu: `시군구${i}`, umdNm: `동${i}`, lawdCd: `1111${i}`,
    buildYear: 2000, recentDealDate: today, dealCount60d: 50 - i, avgDealAmount: 100000,
  }));
  const used = [];   // 어떤 키로 무엇을 호출했는지 기록 — 주입이 실제로 먹었는지의 유일한 증거
  const makeClient = (tag) => ({
    rpc(name) {
      used.push(`${tag}:rpc:${name}`);
      return { abortSignal: () => Promise.resolve({ data: rows, error: null }) };
    },
    from(table) {
      used.push(`${tag}:from:${table}`);
      if (table === 'apt_geocache') {
        const coords = rows.map(r => ({ apt_name: r.aptName, sigungu: r.sigungu, umd_nm: r.umdNm, lat: 37.5, lng: 127.0 }));
        return { select: () => ({ in: () => Promise.resolve({ data: coords, error: null }) }) };
      }
      return { upsert: () => Promise.resolve({ error: null }) };
    },
  });
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
    getSupabaseReadonly: () => makeClient('anon'), getSupabaseAdmin: () => makeClient('service_role') } };
  require.cache[geoPath] = { id: geoPath, filename: geoPath, loaded: true, exports: {
    resolveCoordBatch: async () => { used.push('resolveCoordBatch'); return []; } } };
  delete require.cache[svcPath];
  try {
    const r = await require('../services/popularService').computeAndStoreSnapshot();
    assert.equal(r.stored, true, `스냅샷 저장 실패: ${JSON.stringify(r)}`);
    assert.equal(r.usedFallback, false, 'RPC 성공인데 fallback 으로 빠짐');
    assert.ok(used.includes('service_role:rpc:search_popular_apts'), `집계 RPC 가 service_role 로 가지 않았다: ${used.join(' ')}`);
    assert.ok(!used.some(u => u.startsWith('anon:')), `cron 경로가 공개키(anon)를 썼다 — 3s 컷 재유입: ${used.join(' ')}`);
  } finally {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.g) require.cache[geoPath] = saved.g; else delete require.cache[geoPath];
    if (saved.s) require.cache[svcPath] = saved.s; else delete require.cache[svcPath];
  }
});

// ── Sprint NNNNNNN (2026-08-16, 코드리뷰 HIGH 지적) — 검색 강등 판정 ──────────
//   왜 추가하나: apt_master 조회는 **이름·동명 2개** 쿼리인데, 종전 판정은 *둘 다* 실패할 때만
//   error 를 세웠다. 한쪽만 실패하면 masterRes 가 `{data}` 라 `.error` 가 undefined → degraded=false
//   → **결과 일부가 빠진 응답이 '정상'으로 서버 10분 + CDN s-maxage 600(+SWR 1h) 에 굳었다.**
//   경고 로그도 관측 카운터도 없어 사후 추적조차 불가했다. 게다가 umd_nm 쿼리는 접미 정규화 전
//   원본 q 로 더 넓게 스캔해 timeout 확률이 apt_name 쪽보다 높다 — 실제로 걸리는 쪽이다.
//   이 테스트는 "반쪽 응답은 캐시하지 않는다"는 계약을 판정 함수 수준에서 고정한다.
test('computeDegrade — apt_master "한쪽만" 실패도 강등으로 잡는다 (반쪽 응답 캐시 금지 계약)', () => {
  const { computeDegrade } = require('../routes/search');
  const E = { code: '57014', message: 'canceling statement due to statement timeout' };

  // 전부 정상 → 캐시해도 되는 완전한 응답
  assert.deepEqual(computeDegrade(null, null, null),
    { masterAllFailed: false, masterPartial: false, degraded: false, fatal: false });

  // ★ 핵심 회귀: 이름 쿼리만 실패 / 동명 쿼리만 실패 — 둘 다 부분실패이자 강등이어야 한다
  for (const [nameErr, umdErr, label] of [[E, null, 'apt_name 만 실패'], [null, E, 'umd_nm 만 실패']]) {
    const r = computeDegrade(null, nameErr, umdErr);
    assert.equal(r.masterPartial, true, `${label}: 부분실패로 인식 못함`);
    assert.equal(r.degraded, true, `${label}: degraded=false → 반쪽 응답이 캐시/CDN 에 굳는다`);
    assert.equal(r.fatal, false, `${label}: 한쪽은 살아있는데 500 을 낸다`);
  }

  // apt_master 양쪽 실패 + molit 정상 → molit-only 로 살아남음(500 아님)
  assert.deepEqual(computeDegrade(null, E, E),
    { masterAllFailed: true, masterPartial: false, degraded: true, fatal: false });

  // 두 출처가 **동시에** 전멸할 때만 500 — 빈 배열로 위장 금지
  assert.equal(computeDegrade(E, E, E).fatal, true, '전멸인데 빈 결과를 정상으로 반환');

  // molit 이 죽어도 apt_master 한쪽이 살아있으면 강등 서비스(500 아님)
  const mixed = computeDegrade(E, null, E);
  assert.equal(mixed.fatal, false, 'master 한쪽 생존인데 500');
  assert.equal(mixed.degraded, true, '강등 응답인데 캐시 대상으로 분류');
});

// ── Sprint OOOOOOO (2026-08-16) — 한도 리셋 경계는 KST 자정 ──────────
//   왜 추가하나: 종전 todayKey/secondsUntilMidnight 는 `new Date()` 의 **로컬** 시각을 썼는데
//   Vercel 서버리스 런타임은 UTC 라(레포 전역 TZ 설정 0건), 한도 리셋이 실제로는 KST 09:00 에
//   일어났다. 프로덕션 실증: POST /api/report(비로그인 한도 0 → 즉시 429) 의 resetIn = 77,582초로
//   같은 순간 UTC 자정까지(77,640s)와 일치, KST 자정까지(45,240s)와는 3만초 어긋남.
//   그런데 프론트는 10곳 넘게 "매일 자정(KST) 리셋"이라 안내한다 → 밤에 소진한 사용자가 자정 넘어
//   재시도하면 여전히 막히고 9시간을 더 기다린다. 코드를 의도(KST)에 맞췄고, 이 테스트로 고정한다.
//   ⚠ 핵심: 서버 타임존이 UTC 든 KST 든 **같은 결과**가 나와야 한다(getUTC* 만 사용).
test('dailyLimit — 하루 경계가 KST 자정이다 (서버 타임존 무관)', () => {
  const { todayKey, secondsUntilMidnight } = require('../middleware/dailyLimit');
  const origNow = Date.now;
  try {
    // UTC 08-16 14:30 = KST 08-16 23:30 → 아직 16일, 자정까지 30분
    Date.now = () => Date.UTC(2026, 7, 16, 14, 30, 0);
    assert.equal(todayKey(), '20260816', 'KST 23:30 인데 날짜 키가 어긋남');
    assert.equal(secondsUntilMidnight(), 1800, 'KST 자정까지 30분이어야 함');

    // UTC 08-16 15:30 = KST 08-17 00:30 → 날짜가 17일로 넘어가야 한다(= 여기서 한도 리셋)
    Date.now = () => Date.UTC(2026, 7, 16, 15, 30, 0);
    assert.equal(todayKey(), '20260817', 'KST 자정을 넘겼는데 날짜 키가 안 바뀜 = 리셋 안 됨');
    assert.equal(secondsUntilMidnight(), 23.5 * 3600, 'KST 00:30 → 다음 자정까지 23.5시간');

    // UTC 자정 직후(= KST 09:00). 종전 버그면 여기서 리셋됐다 — 이제는 날짜가 안 바뀌어야 한다.
    Date.now = () => Date.UTC(2026, 7, 17, 0, 1, 0);
    assert.equal(todayKey(), '20260817', 'UTC 자정에 리셋되는 종전 동작으로 회귀');

    // 하한 가드: KST 자정 1초 전이어도 최소 60초 TTL
    Date.now = () => Date.UTC(2026, 7, 16, 14, 59, 59);
    assert.equal(secondsUntilMidnight(), 60, 'TTL 하한 60초 가드가 사라짐');
  } finally { Date.now = origNow; }
});

// ── Sprint RRRRRRR (2026-08-16) — 검색 molit 조회 상한(abort) 계약 ──────────
//   왜 추가하나: 라이브 실측에서 자동완성이 최대 7.4s 를 쓰고(래미 7,401ms·주공 7,304ms) 그중
//   일부는 500(은마 4,485ms)까지 났다. 원인은 435,613행 CPU 바운드 ILIKE Seq Scan 으로 확정됐고
//   (EXPLAIN: 스캔 2,467ms·buffers 전부 shared hit / Sort 는 0.015ms / GIN 강제는 더 느림),
//   인덱스로는 줄일 수 없어 **2.5s 에 먼저 끊는** 상한을 넣었다.
//   이 테스트가 지키는 것은 두 가지 퇴행이다:
//     (a) abort 가 error 로 정규화되지 않으면 Promise.all 이 reject → 강등(200)이 **500 으로 퇴행**
//     (b) abort 판정이 새면 우리가 의도적으로 끊은 요청이 'molit-error' 로 분류돼 **Sentry 이슈 양산**
test('_softQuery — reject 를 error 로 정규화해 Promise.all 이 통째로 터지지 않는다', async () => {
  const { _softQuery } = require('../routes/search');

  // 정상 결과는 그대로 통과해야 한다(래핑이 응답을 바꾸면 안 됨)
  const ok = await _softQuery(Promise.resolve({ data: [{ apt_name: '은마' }], error: null }));
  assert.deepEqual(ok, { data: [{ apt_name: '은마' }], error: null });

  // AbortSignal.timeout() 이 던지는 것은 TimeoutError 다 — AbortError 만 보면 놓친다
  const te = new Error('The operation was aborted due to timeout'); te.name = 'TimeoutError';
  const r1 = await _softQuery(Promise.reject(te));
  assert.equal(r1.data, null);
  assert.equal(r1.error.aborted, true, 'TimeoutError 를 abort 로 인식하지 못함');

  // ★ 핵심 회귀: 한 쿼리가 reject 해도 나머지 결과는 살아야 한다(강등의 전제)
  const [a, b] = await Promise.all([
    _softQuery(Promise.reject(te)),
    _softQuery(Promise.resolve({ data: [{ apt_name: '헬리오시티' }], error: null })),
  ]);
  assert.ok(a.error, 'reject 가 error 로 오지 않음');
  assert.equal(b.data.length, 1, '다른 쿼리 결과가 유실됨 → 강등 대신 500 이 된다');
});

test('_isAbortErr — 우리가 끊은 요청만 abort 로 보고, 진짜 오류는 Sentry 로 보낸다', () => {
  const { _isAbortErr } = require('../routes/search');

  // postgrest-js 가 실제로 만드는 형태: message = `${name}: ${msg}`, code = '' (dist/index.cjs 확인)
  assert.equal(_isAbortErr({ message: 'TimeoutError: The operation was aborted due to timeout', code: '', hint: '' }),
    true, 'TimeoutError 형태를 못 잡으면 Sentry 이슈가 매번 생긴다');
  assert.equal(_isAbortErr({ message: 'AbortError: This operation was aborted', code: '',
    hint: 'Request was aborted (timeout or manual cancellation)' }), true);
  assert.equal(_isAbortErr({ aborted: true }), true, 'reject 경로(_softQuery)가 붙인 표식');

  // ★ DB 측 statement timeout 은 abort 가 아니다 — 둘을 구분해야 대응이 갈린다
  //   (abort 증가 = 상한이 동작 / timeout 증가 = 2.5s 안에도 못 끝냄)
  assert.equal(_isAbortErr({ code: '57014', message: 'canceling statement due to statement timeout' }),
    false, 'DB timeout 을 abort 로 오분류하면 상한 효과를 측정할 수 없다');

  // ★ 진짜 오류는 반드시 false — 조용히 삼켜지면 권한·스키마 드리프트를 못 본다
  assert.equal(_isAbortErr({ code: '42501', message: 'permission denied for table molit_transactions' }), false);
  assert.equal(_isAbortErr({ code: 'PGRST204', message: 'column does not exist' }), false);
  assert.equal(_isAbortErr(null), false);
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

// ── Plan 012 (2026-08-16): 결제 confirm 계약 — 금전 상태 전이 고정 ──────────
//   왜 추가하나: billing.js 566줄 전체가 라우트 핸들러이고 테스트가 **0** 이었다. 지금은
//   TOSS_SECRET_KEY 미설정이라 잠들어 있지만, **결제를 켜는 순간 전량 미검증 코드가 실결제를
//   처리**한다. 여기서 나는 회귀는 이중 승인·금액 위조 통과 같은 직접적 금전 사고다.
//   ⚠ 프로덕션 코드는 **한 줄도 바꾸지 않는다** — express 라우터 스택에서 핸들러만 꺼내
//   req/res 목으로 호출한다(결제 로직을 테스트 편의로 리팩터링하는 것이 더 위험하다).
//   의존성(db/client)은 이 파일에 이미 있는 require.cache 스텁 패턴을 그대로 쓴다.
function _billingHandler(path) {
  const router = require('../routes/billing');
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  assert.ok(layer, `billing 라우터에서 ${path} 를 찾지 못했다 (경로 변경 시 이 테스트도 갱신할 것)`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function _mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set() { return this; },
  };
}
// supabase 체인 목 — payments 조회 1건 + update 결과를 주입한다.
//   update 는 두 형태로 쓰인다: `update().eq()` 를 await(금액불일치 경로) / `update().eq().eq().select()`(CAS 경로).
//   둘 다 지원하려면 체인이 thenable 이면서 eq/select 를 가져야 한다.
function _mockAdmin({ payRow, casRows }) {
  const seen = { updates: [] };
  const upChain = (patch) => {
    const c = {
      eq: () => c,
      select: async () => ({ data: casRows, error: null }),
      then: (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej),
    };
    seen.updates.push(patch);
    return c;
  };
  const sel = {
    select: () => sel,
    eq: () => sel,
    maybeSingle: async () => ({ data: payRow, error: null }),
    update: upChain,
  };
  return { client: { from: () => sel }, seen };
}
async function _withBillingStub({ payRow, casRows, tossKey }, fn) {
  const clientPath = require.resolve('../db/client');
  const billPath = require.resolve('../routes/billing');
  const saved = { c: require.cache[clientPath], b: require.cache[billPath] };
  const savedKey = process.env.TOSS_SECRET_KEY;
  const { client, seen } = _mockAdmin({ payRow, casRows });
  if (tossKey === undefined) delete process.env.TOSS_SECRET_KEY;
  else process.env.TOSS_SECRET_KEY = tossKey;
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
    getSupabaseAdmin: () => client, getSupabaseReadonly: () => client,
    getUserScopedClient: () => client } };
  delete require.cache[billPath];   // TOSS_SECRET_KEY 는 모듈 로드 시 상수라 반드시 재로드
  try {
    return await fn(seen);
  } finally {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.b) require.cache[billPath] = saved.b; else delete require.cache[billPath];
    if (savedKey === undefined) delete process.env.TOSS_SECRET_KEY;
    else process.env.TOSS_SECRET_KEY = savedKey;
  }
}

test('billing/confirm — 결제 키 미설정이면 501 로 막고 결제를 진행하지 않는다', async () => {
  await _withBillingStub({ payRow: null, casRows: [], tossKey: undefined }, async () => {
    const h = _billingHandler('/confirm');
    const res = _mockRes();
    await h({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    assert.equal(res.statusCode, 501, '키가 없는데 결제 흐름이 진행됐다');
  });
});

test('billing/confirm — DB 금액과 다르면 400 + 해당 주문을 failed 로 막는다 (위조 차단)', async () => {
  // 저장된 주문은 9,900원인데 클라이언트가 100원을 주장하는 상황
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' };
  await _withBillingStub({ payRow, casRows: [], tossKey: 'test' }, async (seen) => {
    const h = _billingHandler('/confirm');
    const res = _mockRes();
    await h({ body: { paymentKey: 'pk', orderId: 'o1', amount: 100 }, user: { id: 'u1' } }, res, () => {});
    assert.equal(res.statusCode, 400, '금액 불일치인데 400 이 아니다');
    // ★ 같은 orderId 재사용을 막기 위해 failed 로 전이해야 한다
    const failed = seen.updates.find((u) => u && u.status === 'failed');
    assert.ok(failed, '금액 불일치인데 주문을 failed 로 막지 않았다 — 동일 orderId 재시도가 가능해진다');
    assert.equal(failed.failure_reason, 'amount_mismatch');
    // PIPA 최소수집: 실패 사유에 정확한 금액을 남기지 않는다
    assert.ok(!/9900|100/.test(JSON.stringify(failed)), '실패 기록에 결제 금액이 남았다(PIPA 최소수집 위반)');
  });
});

test('billing/confirm — 이미 captured 면 Toss 재호출 없이 멱등 응답', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'captured', plan: 'pro' };
  await _withBillingStub({ payRow, casRows: [], tossKey: 'test' }, async (seen) => {
    const h = _billingHandler('/confirm');
    const res = _mockRes();
    await h({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'captured');
    // ★ 이미 처리된 주문에 update 를 또 날리면 안 된다(승인 상태를 덮어쓸 위험)
    assert.equal(seen.updates.length, 0, '이미 captured 인데 추가 update 가 발생했다');
  });
});

// ── Plan 012-2 (2026-08-16): webhook 상태 분기 + 환불 7일 창 ──────────
//   Plan 012 는 confirm 경로만 덮었다. 결제를 켜기 전 나머지 두 축을 고정한다.
//   webhook 은 Toss 재조회(axios)가 **사실상 서명 검증 역할**이라 axios 스텁이 필요하고,
//   환불 7일 경계는 payRow 의 approved_at 을 조작하면 **타이머 제어 없이** 검증된다.
//   여기서도 프로덕션 코드는 바꾸지 않는다 — 라우터 스택에서 핸들러만 꺼내 쓴다.
async function _withBillingStub2({ payRow, casRows, tossKey, webhookSecret, axiosImpl }, fn) {
  const clientPath = require.resolve('../db/client');
  const billPath = require.resolve('../routes/billing');
  const axiosPath = require.resolve('axios');
  const saved = { c: require.cache[clientPath], b: require.cache[billPath], a: require.cache[axiosPath] };
  const savedEnv = { k: process.env.TOSS_SECRET_KEY, w: process.env.TOSS_WEBHOOK_SECRET };
  const { client, seen } = _mockAdmin({ payRow, casRows });
  if (tossKey === undefined) delete process.env.TOSS_SECRET_KEY; else process.env.TOSS_SECRET_KEY = tossKey;
  if (webhookSecret === undefined) delete process.env.TOSS_WEBHOOK_SECRET; else process.env.TOSS_WEBHOOK_SECRET = webhookSecret;
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
    getSupabaseAdmin: () => client, getSupabaseReadonly: () => client, getUserScopedClient: () => client } };
  if (axiosImpl) {
    require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: axiosImpl };
  }
  delete require.cache[billPath];   // env·axios 는 모듈 로드 시 바인딩되므로 반드시 재로드
  try { return await fn(seen); } finally {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.b) require.cache[billPath] = saved.b; else delete require.cache[billPath];
    if (saved.a) require.cache[axiosPath] = saved.a; else delete require.cache[axiosPath];
    if (savedEnv.k === undefined) delete process.env.TOSS_SECRET_KEY; else process.env.TOSS_SECRET_KEY = savedEnv.k;
    if (savedEnv.w === undefined) delete process.env.TOSS_WEBHOOK_SECRET; else process.env.TOSS_WEBHOOK_SECRET = savedEnv.w;
  }
}
const _req = (o) => ({ body: {}, user: { id: 'u1' }, params: {}, get: () => undefined, ip: '127.0.0.1', ...o });

test('billing/webhook — Toss 재조회 orderId 가 body 와 다르면 400 (위조 차단)', async () => {
  const axiosImpl = { get: async () => ({ data: { orderId: 'ATTACKER-ORDER', status: 'DONE', totalAmount: 9900 } }) };
  await _withBillingStub2({ payRow: null, casRows: [], tossKey: 'test', axiosImpl }, async () => {
    const h = _billingHandler('/webhook');
    const res = _mockRes();
    await h(_req({ body: { paymentKey: 'pk', orderId: 'o1' } }), res, () => {});
    assert.equal(res.statusCode, 400, 'orderId 불일치인데 통과했다 — 재조회 검증이 무력화됐다');
    assert.match(String(res.body && res.body.error), /mismatch/i);
  });
});

test('billing/webhook — 정적 시크릿이 설정돼 있는데 헤더가 틀리면 401', async () => {
  await _withBillingStub2({ payRow: null, casRows: [], tossKey: 'test', webhookSecret: 'expected-value' }, async () => {
    const h = _billingHandler('/webhook');
    const res = _mockRes();
    await h(_req({ body: { paymentKey: 'pk', orderId: 'o1' }, get: () => 'wrong-value' }), res, () => {});
    assert.equal(res.statusCode, 401, '시크릿 불일치인데 처리로 넘어갔다');
  });
});

test('billing/webhook — 금액 불일치라도 terminal 상태(captured)는 failed 로 덮지 않는다', async () => {
  // Toss 는 100원이라 하고 DB 는 9,900원 → 불일치. 단 이 주문은 이미 captured(terminal).
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'captured', plan: 'pro' };
  const axiosImpl = { get: async () => ({ data: { orderId: 'o1', status: 'CANCELED', totalAmount: 100 } }) };
  // CAS(.eq('status','requested'))가 0행을 돌려주는 상황 = terminal 보호가 작동한 경우
  await _withBillingStub2({ payRow, casRows: [], tossKey: 'test', axiosImpl }, async () => {
    const h = _billingHandler('/webhook');
    const res = _mockRes();
    await h(_req({ body: { paymentKey: 'pk', orderId: 'o1' } }), res, () => {});
    // 200 으로 응답해 Toss 재시도를 멈추되, 상태는 덮지 않는다
    assert.equal(res.statusCode, 200, 'terminal 보호 경로는 200 이어야 Toss 가 재시도를 멈춘다');
    assert.ok(/ignored|terminal/i.test(JSON.stringify(res.body)), `terminal 보호 응답이 아니다: ${JSON.stringify(res.body)}`);
  });
});

test('billing/refund — 7일 청약철회 창을 넘으면 400 으로 막는다 (경계 양쪽 확인)', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const mk = (daysAgo) => ({ id: 'p1', user_id: 'u1', order_id: 'o1', toss_payment_key: 'tk',
    amount: 9900, status: 'captured', plan: 'pro',
    approved_at: new Date(Date.now() - daysAgo * DAY).toISOString() });

  // (a) 8일 전 결제 → 창 만료. axios 가 호출되면 안 된다(그 전에 차단되어야 함).
  let tossCalled = false;
  const axiosImpl = { post: async () => { tossCalled = true; return { data: {} }; }, get: async () => ({ data: {} }) };
  await _withBillingStub2({ payRow: mk(8), casRows: [], tossKey: 'test', axiosImpl }, async () => {
    const h = _billingHandler('/payments/:id/refund');
    const res = _mockRes();
    await h(_req({ params: { id: 'p1' } }), res, () => {});
    assert.equal(res.statusCode, 400, '7일 초과인데 환불이 진행됐다');
    assert.equal(res.body.code, 'refund_window_expired');
    assert.equal(tossCalled, false, '창이 만료됐는데 Toss 취소 API 를 호출했다');
  });

  // (b) 6일 전 결제 → 창 안. 여기서는 Toss 호출까지 도달해야 한다(경계가 과하게 좁지 않은지).
  tossCalled = false;
  const axiosOk = { post: async () => { tossCalled = true; return { data: { status: 'CANCELED' } }; }, get: async () => ({ data: {} }) };
  await _withBillingStub2({ payRow: mk(6), casRows: [{}], tossKey: 'test', axiosImpl: axiosOk }, async () => {
    const h = _billingHandler('/payments/:id/refund');
    const res = _mockRes();
    await h(_req({ params: { id: 'p1' } }), res, () => {});
    assert.equal(tossCalled, true, '6일차(창 안)인데 환불이 차단됐다 — 경계가 잘못 좁혀졌다');
  });
});

test('billing/refund — captured 가 아니면 409, 이미 refunded 면 멱등 200', async () => {
  const base = { id: 'p1', user_id: 'u1', order_id: 'o1', toss_payment_key: 'tk', amount: 9900,
    plan: 'pro', approved_at: new Date().toISOString() };
  await _withBillingStub2({ payRow: { ...base, status: 'requested' }, casRows: [], tossKey: 'test' }, async () => {
    const res = _mockRes();
    await _billingHandler('/payments/:id/refund')(_req({ params: { id: 'p1' } }), res, () => {});
    assert.equal(res.statusCode, 409, '미승인(requested) 결제를 환불 가능으로 취급했다');
    assert.equal(res.body.code, 'not_refundable');
  });
  await _withBillingStub2({ payRow: { ...base, status: 'refunded' }, casRows: [], tossKey: 'test' }, async () => {
    const res = _mockRes();
    await _billingHandler('/payments/:id/refund')(_req({ params: { id: 'p1' } }), res, () => {});
    assert.equal(res.statusCode, 200, '이미 환불된 건은 멱등 200 이어야 한다');
    assert.equal(res.body.status, 'refunded');
  });
});

// PIPA-PARITY (Plan 012-2): confirm 과 webhook 이 **같은 개인정보 정책**을 갖는지 고정한다.
//   confirm 은 P2-5(2026-05-04)로 실패 기록에서 정확한 결제 금액을 뺐는데 webhook 만 그대로였다
//   — 같은 방어선의 "한쪽만 고침". 이 테스트가 두 경로를 묶는다.
test('billing/webhook — 금액 불일치 기록에 정확한 결제 금액을 남기지 않는다 (PIPA 최소수집)', async () => {
  // requested 상태여야 failed 전이 경로(CAS 성공)를 탄다
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' };
  const axiosImpl = { get: async () => ({ data: { orderId: 'o1', status: 'DONE', totalAmount: 100 } }) };
  await _withBillingStub2({ payRow, casRows: [{ order_id: 'o1' }], tossKey: 'test', axiosImpl }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/webhook')(_req({ body: { paymentKey: 'pk', orderId: 'o1' } }), res, () => {});
    assert.equal(res.statusCode, 400, '금액 불일치인데 400 이 아니다');
    const failed = seen.updates.find((u) => u && u.status === 'failed');
    assert.ok(failed, '금액 불일치인데 requested 주문을 failed 로 막지 않았다');
    assert.ok(!/9900|100/.test(JSON.stringify(failed)),
      `실패 기록에 결제 금액이 남았다(PIPA 최소수집 위반, confirm 경로와 불일치): ${JSON.stringify(failed)}`);
  });
});

// ── Plan 013 (2026-08-16): auth 미들웨어 순수 로직 — JWT 만료 우회 차단 + 삭제 유예 화이트리스트 ──
//   왜 추가하나: `backend/middleware/auth.js` 는 테스트가 **0** 이었다. 그중 `_jwtExpMs` 는
//   주석 자체가 "cache TTL 이 JWT 만료 후로 연장되는 우회 차단"(P0-1, 2026-05-04)이라고 밝힌
//   **보안 수정**이다. verifyToken 은 `expiresAt = jwtExp ? min(jwtExp, now+5s) : now+5s` 로 쓰므로,
//   `_jwtExpMs` 가 실패해 null 을 돌려주면 **만료된 JWT 가 최대 5초 더 통과**한다.
//   ⚠ 실제 JWT payload 는 **base64url**(`-`·`_`)이고 **패딩이 제거**돼 있다 — 그 처리가 깨지면
//   정상 토큰에서도 null 이 나와 방어가 통째로 죽는데, 그때 겉으로는 아무 에러도 안 난다.
//   프로덕션 코드는 바꾸지 않는다 — 파일에서 함수를 정규식으로 추출해 되살린다
//   (이 저장소의 `_isRegProp`·`_pickTierRate` 테스트와 같은 패턴).
function _authFn(name, injectArgNames = [], injectValues = []) {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../middleware/auth.js'), 'utf8');
  // ⚠ 템플릿 리터럴 안에서는 `\s`·`\n` 이 이스케이프 시퀀스로 먼저 소비돼 정규식이 깨진다.
  //   문자열 연결 + 명시적 이중 이스케이프로 쓴다.
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}');
  const m = src.match(re);
  assert.ok(m, `auth.js 에서 ${name} 을 찾지 못했다 (함수명·형태 변경 시 이 테스트도 갱신할 것)`);
  return new Function(...injectArgNames, `${m[0]}; return ${name};`)(...injectValues);
}
// 실제 JWT 와 동일한 인코딩: base64url + 패딩 제거
function _mkJwtPayload(obj) {
  const b64 = Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `hdr.${b64}.sig`;
}

test('_jwtExpMs — 실제 JWT 인코딩(base64url·무패딩)에서 exp 를 읽어야 만료 우회가 막힌다', () => {
  const _jwtExpMs = _authFn('_jwtExpMs');
  const expSec = 1893456000; // 고정값 (2030-01-01 근처) — 현재 시각에 의존하지 않는다

  // 길이(패딩) 변주 — 기본 동작 확인
  for (const pad of ['a', 'ab', 'abc', 'abcd']) {
    const t = _mkJwtPayload({ exp: expSec, sub: pad, iss: 'https://example.supabase.co/auth/v1' });
    assert.equal(_jwtExpMs(t), expSec * 1000, `디코드 실패(길이 케이스 '${pad}')`);
  }

  // base64url 특수문자(-, _)가 실제로 들어간 토큰에서도 exp 를 읽는지 확인한다.
  let urlSafeToken = null;
  for (let i = 0; i < 500 && !urlSafeToken; i++) {
    const t = _mkJwtPayload({ exp: expSec, sub: 'u' + i, n: 'ÿþ~?' + i });
    if (/[-_]/.test(t.split('.')[1])) urlSafeToken = t;
  }
  assert.ok(urlSafeToken, 'base64url 특수문자(-,_)가 포함된 payload 를 만들지 못했다');
  assert.equal(_jwtExpMs(urlSafeToken), expSec * 1000, 'base64url 토큰에서 exp 를 읽지 못했다');

  // ⚠ 정직한 한계 (2026-08-16 실측): `_jwtExpMs` 안의 base64url 복원 두 줄
  //   — `.replace(/-/g,'+').replace(/_/g,'/')` 와 `.padEnd(..., '=')` — 은
  //   **Node 에서 no-op** 이다. `Buffer.from(s,'base64')` 가 base64url 도, 무패딩도 그대로 디코드한다.
  //   실제로 두 줄을 각각 제거해도 이 테스트는 전부 통과했다(회귀 주입 확인).
  //   즉 **어떤 테스트로도 그 두 줄은 고정할 수 없다** — 다른 런타임(예: 브라우저 atob) 대비
  //   방어 코드로 보고 남겨 두되, "테스트가 지켜준다"고 오해하지 말 것.
  //   이 테스트가 실제로 고정하는 것은 아래 셋이다:
  //     (a) 정상 JWT 에서 exp*1000 을 돌려준다   (b) exp 없음/숫자 아님 → null (NaN 오염 차단)
  //     (c) 손상 입력에 예외를 던지지 않는다(던지면 인증 요청이 500 으로 죽는다)

  // exp 없음 → null (verifyToken 이 micro-cache TTL 로 폴백하는 기존 동작)
  assert.equal(_jwtExpMs(_mkJwtPayload({ sub: 'u1' })), null);
  // exp 가 숫자가 아니면 null — 문자열 exp 를 곱해 NaN/이상값이 되는 것을 막는다
  assert.equal(_jwtExpMs(_mkJwtPayload({ exp: '1893456000' })), null);
  // 손상 입력 — 전부 null 이어야 하고 예외를 던지면 안 된다(요청이 500 으로 죽는다)
  assert.equal(_jwtExpMs('not-a-jwt'), null);
  assert.equal(_jwtExpMs('hdr..sig'), null);
  assert.equal(_jwtExpMs('hdr.###.sig'), null);
  assert.equal(_jwtExpMs(''), null);
});

test('isDeletionAllowed — 삭제 유예 중 허용 경로는 화이트리스트로만 열린다', () => {
  // DELETION_ALLOWED_PATHS 는 모듈 스코프 상수라 주입한다(값은 auth.js 정의와 동일).
  const PATHS = new Set(['/api/account/restore', '/api/account/deletion-status']);
  const isDeletionAllowed = _authFn('isDeletionAllowed', ['DELETION_ALLOWED_PATHS'], [PATHS]);

  assert.equal(isDeletionAllowed({ originalUrl: '/api/account/restore' }), true);
  assert.equal(isDeletionAllowed({ originalUrl: '/api/account/deletion-status' }), true);
  // 쿼리스트링이 붙어도 판정은 경로 기준
  assert.equal(isDeletionAllowed({ originalUrl: '/api/account/restore?from=email' }), true);
  // ★ 화이트리스트 밖은 전부 차단 — 삭제 유예 중 일반 API 가 열리면 안 된다
  assert.equal(isDeletionAllowed({ originalUrl: '/api/report/generate' }), false);
  assert.equal(isDeletionAllowed({ originalUrl: '/api/billing/checkout' }), false);
  // 접두만 같은 경로도 차단(Set 정확일치)
  assert.equal(isDeletionAllowed({ originalUrl: '/api/account/restore/all' }), false);
  // originalUrl 이 없으면 url 로 폴백, 둘 다 없으면 차단
  assert.equal(isDeletionAllowed({ url: '/api/account/restore' }), true);
  assert.equal(isDeletionAllowed({}), false);
});

// ══════════════════════════════════════════════════════════════════════════════
// Plan 014 (2026-08-16): 추천 점수 엔진(report.js) — 실사고 2건의 재발 차단
//
// 왜 추가하나: `backend/routes/report.js` 의 점수 엔진은 **테스트가 0** 이었다.
//   이 엔진의 출력(`objectiveFacts`)은 그대로 사용자 화면에 문장으로 찍힌다
//   (frontend/index.html:4171 · :4304 — "행정구 등급 <b>…</b> · 규제 <b>…</b>").
//   즉 여기서 틀린 값이 나오면 **서비스가 사실이 아닌 문장을 사용자에게 단정**하게 된다(절대룰 ②).
//
// 이 파일이 고정하는 실사고 2건 (둘 다 코드 주석에 근본원인이 남아 있다):
//   ① REGION-LABEL-FIX-2026-07-25 (report.js:654-659, :733-735)
//      "이름이 4자 이하 '구'" 라는 **문자열 규칙**으로 서울을 판정해, MOLIT sigungu 에 광역 접두가
//      없다는 성질(transactionService._stripCityPrefix) 과 겹치면서 부산 해운대구·대구 수성구·
//      인천 연수구가 전부 "서울 외곽구"·"조정대상지역" 으로 표기됐다.
//      → 사용자는 LTV 40%·취득세 중과·실거주 의무를 잘못 전제하게 된다(금전 오판).
//   ② TAG-AGE-FIX-2026-07-11 (report.js:757-759)
//      신축/재건축 판정이 **절대 연도 하드코딩**(≥2018/≤1995 …)이라 시간이 지나면 조용히 어긋났다.
//      → 상대 나이로 통일됐고, 이 테스트는 **현재 연도를 기준으로 계산**해 절대연도 복귀를 잡는다.
//
// 프로덕션 코드는 바꾸지 않는다 — 파일에서 함수를 정규식으로 추출해 되살린다
// (`_isRegProp`·`_pickTierRate`·`_authFn` 와 같은, 이 저장소에 이미 확립된 패턴).
//
// ⚠ 기대값의 성격: 이것은 **characterization(현재 동작 고정) 테스트**다. 규제 수치·등급 배점의
//   정책 정합성을 판정하지 않는다(그건 Sprint NNNN 법령 전수 재검증의 영역). 정책이 실제로
//   바뀌어서 값을 고치는 경우라면 기대값도 같이 고치는 게 맞다 — 이 테스트가 잡으려는 것은
//   **의도하지 않은 드리프트**, 특히 위 ①②로 되돌아가는 변경이다.
// ══════════════════════════════════════════════════════════════════════════════
function _reportFn(name, injectArgNames = [], injectValues = []) {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');
  // ⚠ 템플릿 리터럴 안에서는 `\s`·`\n` 이 이스케이프 시퀀스로 먼저 소비돼 정규식이 깨진다.
  //   문자열 연결 + 명시적 이중 이스케이프로 쓴다(_authFn 과 동일).
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}');
  const m = src.match(re);
  assert.ok(m, `report.js 에서 ${name} 을 찾지 못했다 (함수명·형태 변경 시 이 테스트도 갱신할 것)`);
  return new Function(...injectArgNames, `${m[0]}; return ${name};`)(...injectValues);
}

// lawd_cd 는 전부 이 저장소의 `transactionService.LAWD_CODES` 실값이다(임의 생성 금지).
//   서울 11 · 부산 26 · 대구 27 · 인천 28 · 경기 41 접두는 report.js:963-964 SIDO_PFX 와 동일.
const LAWD = {
  강남구: '11680', 마포구: '11440', 양천구: '11470', 노원구: '11350', 서울중구: '11140',
  부산중구: '26110', 부산서구: '26140', 해운대구: '26350', 수성구: '27260',
  연수구: '28185', 인천서구: '28260', 과천시: '41290',
};

test('getDistrictTier — 행정구 위계는 lawd_cd 로만 판정한다 (동명 구 오표기 실사고)', () => {
  const getDistrictTier = _reportFn('getDistrictTier');

  // 서울(lawd_cd 11 접두) — 등급이 실제로 붙는다
  assert.deepEqual(getDistrictTier('강남구', LAWD.강남구), { tier: '강남3구', bonus: 60 });
  assert.deepEqual(getDistrictTier('마포구', LAWD.마포구), { tier: '마용성광', bonus: 50 });
  assert.deepEqual(getDistrictTier('양천구', LAWD.양천구), { tier: '서울 핵심구', bonus: 30 });
  assert.deepEqual(getDistrictTier('노원구', LAWD.노원구), { tier: '서울 외곽구', bonus: 5 });

  // ★ 실사고 재발 차단: 지방 광역시 구에 '서울 …' 라벨이 붙으면 안 된다.
  //   MOLIT sigungu 에는 광역 접두가 없어 이름만 보면 서울 구와 구별할 수 없다.
  assert.deepEqual(getDistrictTier('해운대구', LAWD.해운대구), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('수성구', LAWD.수성구), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('연수구', LAWD.연수구), { tier: '기타', bonus: 0 });

  // ★ 완전 동명 구 — 문자열로는 원리적으로 구별 불가능한 조합
  assert.deepEqual(getDistrictTier('중구', LAWD.서울중구), { tier: '서울 외곽구', bonus: 5 });
  assert.deepEqual(getDistrictTier('중구', LAWD.부산중구), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('서구', LAWD.부산서구), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('서구', LAWD.인천서구), { tier: '기타', bonus: 0 });

  // lawd_cd 가 없으면 서울로 단정하지 않는다 — 틀린 단정보다 미표기(절대룰 ②)
  assert.deepEqual(getDistrictTier('강남구', ''), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('강남구', null), { tier: '기타', bonus: 0 });
  assert.deepEqual(getDistrictTier('강남구', undefined), { tier: '기타', bonus: 0 });
  // sigungu 자체가 없을 때도 예외 없이 '기타'(molit_transactions.sigungu 는 nullable — 실측)
  assert.deepEqual(getDistrictTier(null, LAWD.강남구), { tier: '기타', bonus: 0 });

  // 경기 과천·분당·판교는 **의도적으로** 문자열 매칭이다(report.js:667 — 동명 지역이 없어 안전).
  //   lawd_cd 에 의존하지 않는다는 것 자체가 계약이므로 코드 유무 양쪽을 고정한다.
  assert.deepEqual(getDistrictTier('과천시', LAWD.과천시), { tier: '분당·과천·판교', bonus: 35 });
  assert.deepEqual(getDistrictTier('분당구', ''), { tier: '분당·과천·판교', bonus: 35 });
});

test('getRegulationPenalty — 서울 외 지역을 규제지역으로 단정하지 않는다 (금전 오판 차단)', () => {
  const getRegulationPenalty = _reportFn('getRegulationPenalty');

  assert.deepEqual(getRegulationPenalty('강남구', LAWD.강남구), { status: '투기과열·토허구역 일부', bonus: -8 });
  assert.deepEqual(getRegulationPenalty('노원구', LAWD.노원구), { status: '조정대상지역', bonus: -3 });
  assert.deepEqual(getRegulationPenalty('중구', LAWD.서울중구), { status: '조정대상지역', bonus: -3 });

  // ★ 지방은 코드만으로 규제 여부를 단정할 수 없다 → '미확인'(화면에서 라벨 생략)
  assert.deepEqual(getRegulationPenalty('해운대구', LAWD.해운대구), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('수성구', LAWD.수성구), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('중구', LAWD.부산중구), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('서구', LAWD.인천서구), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty(null, LAWD.강남구), { status: '미확인', bonus: 0 });

  // lawd_cd 가 비면 '비규제' 로 떨어진다.
  //   ⚠ 이 분기는 **보고서 경로에서는 도달 불가**다: 후보의 lawd_cd 는 molit_transactions 에서
  //   그대로 오고 그 컬럼은 NOT NULL 이다(2026-08-16 information_schema 실측).
  //   그래도 동작을 고정해 둔다 — 훗날 다른 호출부가 생겨 코드 없이 부르면 '강남구'에 "비규제"라는
  //   **사실 아닌 라벨**이 화면에 뜬다. 그때 이 줄이 근거가 된다.
  assert.deepEqual(getRegulationPenalty('강남구', ''), { status: '비규제', bonus: 0 });
});

test('applyObjectiveScore — 지방 단지 카드에 서울 위계·규제 문구가 찍히지 않는다 (실사고 재현)', () => {
  const deps = ['getDistrictTier', 'getBuilderTier', 'getHouseholdBonus',
    'getParkingBonus', 'getAgeBonus', 'getRegulationPenalty'];
  const applyObjectiveScore = _reportFn('applyObjectiveScore', deps, deps.map((n) => _reportFn(n)));

  const mk = (sigungu, lawd_cd) => ({
    sigungu, lawd_cd, umd_nm: '테스트동',
    households: 1200, build_year: new Date().getFullYear() - 3, n: 10,
    kaptInfo: { builder: '삼성물산', parking: 1500 },
    score: 100, scoreBreakdown: {},
  });

  // 서울 강남구 — 라벨이 붙어야 정상
  const seoul = mk('강남구', LAWD.강남구);
  applyObjectiveScore(seoul);
  assert.equal(seoul.objectiveFacts.district, '강남3구');
  assert.equal(seoul.objectiveFacts.regulation, '투기과열·토허구역 일부');

  // ★ 부산 해운대구 — 프론트가 `f.district ? … : null` 로 렌더하므로 null 이어야 문구가 사라진다.
  //   여기서 문자열이 새어 나가면 "해운대구 우동 (서울 외곽구)" 실사고가 그대로 재현된다.
  for (const [gu, code] of [['해운대구', LAWD.해운대구], ['수성구', LAWD.수성구], ['연수구', LAWD.연수구]]) {
    const local = mk(gu, code);
    applyObjectiveScore(local);
    assert.equal(local.objectiveFacts.district, null, `${gu} 에 행정구 등급 라벨이 붙었다`);
    assert.equal(local.objectiveFacts.regulation, null, `${gu} 에 규제 라벨이 붙었다`);
    // 라벨뿐 아니라 **점수 가산/감산도** 서울 기준으로 들어가면 안 된다
    assert.equal(local.scoreBreakdown['객관_행정구위계'], undefined, `${gu} 에 서울 위계 가산점이 붙었다`);
    assert.equal(local.scoreBreakdown['객관_규제'], undefined, `${gu} 에 규제 감산이 붙었다`);
  }
});

test('getAgeBonus — 노후도는 절대 연도가 아니라 현재 연도 기준 상대 나이다 (시간 드리프트 차단)', () => {
  const getAgeBonus = _reportFn('getAgeBonus');
  const Y = new Date().getFullYear();

  // 경계 양쪽을 모두 고정한다 — 한쪽만 보면 부등호 방향 실수를 놓친다(계획 008 의 취득세 경계와 동일 교훈)
  assert.deepEqual(getAgeBonus(Y - 5), { years: 5, bonus: 25 });
  assert.deepEqual(getAgeBonus(Y - 6), { years: 6, bonus: 18 });
  assert.deepEqual(getAgeBonus(Y - 10), { years: 10, bonus: 18 });
  assert.deepEqual(getAgeBonus(Y - 11), { years: 11, bonus: 12 });
  assert.deepEqual(getAgeBonus(Y - 15), { years: 15, bonus: 12 });
  assert.deepEqual(getAgeBonus(Y - 16), { years: 16, bonus: 6 });
  assert.deepEqual(getAgeBonus(Y - 20), { years: 20, bonus: 6 });
  assert.deepEqual(getAgeBonus(Y - 21), { years: 21, bonus: 2 });
  assert.deepEqual(getAgeBonus(Y - 30), { years: 30, bonus: 2 });
  assert.deepEqual(getAgeBonus(Y - 31), { years: 31, bonus: 0 });
  // 준공년도 미상 → 추정하지 않는다(0)
  assert.deepEqual(getAgeBonus(null), { years: null, bonus: 0 });
  assert.deepEqual(getAgeBonus(0), { years: null, bonus: 0 });
});

test('computeAptScore — 신축/재건축 우선순위도 상대 나이 기준이다 (절대연도 하드코딩 복귀 차단)', () => {
  const computeAptScore = _reportFn('computeAptScore');
  const Y = new Date().getFullYear();
  // 다른 항목을 전부 0 으로 만들어 priority 만 남긴다:
  //   n=0 → 거래량 가산 없음 / avgPrice·buy 비 = 0.79999 → 예산 fit 두 구간 모두 밖 / 가구상황 전부 무해
  const ctxOf = (priority) => ({ buy: 10, priority, kidPlan: '없음', stayYears: '5~10년', isFirstBuyer: false });
  const cOf = (buildYear) => ({ n: 0, households: 0, avgPrice: 79999, build_year: buildYear, sigungu: '강남구', umd_nm: '대치동' });

  const score = (priority, buildYear) => computeAptScore(cOf(buildYear), ctxOf(priority)).total;

  // 신축: 8년 이하 35 / 14년 이하 18 / 그 밖 0
  assert.equal(score('신축', Y - 8), 35);
  assert.equal(score('신축', Y - 9), 18);
  assert.equal(score('신축', Y - 14), 18);
  assert.equal(score('신축', Y - 15), 0);
  // 재건축: 30년 이상 30 / 25년 이상 12 / 그 밖 0
  assert.equal(score('재건축', Y - 30), 30);
  assert.equal(score('재건축', Y - 25), 12);
  assert.equal(score('재건축', Y - 24), 0);
  // 준공년도 미상이면 신축·재건축 어느 쪽으로도 추정하지 않는다
  assert.equal(score('신축', null), 0);
  assert.equal(score('재건축', null), 0);
});

test('computeAptScore — 예산 fit 구간 경계 (예산 ±10%/±20% 양쪽 끝)', () => {
  const computeAptScore = _reportFn('computeAptScore');
  const Y = new Date().getFullYear();
  // priority '신축' + 15년 구축 → priority 기여 0. n=0 → 거래량 0. 남는 것은 budget_fit 뿐.
  const ctx = { buy: 10, priority: '신축', kidPlan: '없음', stayYears: '5~10년', isFirstBuyer: false };
  const fit = (avgPriceManwon) => computeAptScore(
    { n: 0, households: 0, avgPrice: avgPriceManwon, build_year: Y - 15, sigungu: '강남구', umd_nm: '테스트동' }, ctx).total;

  // buy=10억 → 기준 100,000 만원
  assert.equal(fit(100000), 30);  // 정확 일치
  assert.equal(fit(90000), 30);   // 0.9 — 경계 포함
  assert.equal(fit(110000), 30);  // 1.1 — 경계 포함
  assert.equal(fit(89999), 12);   // 0.9 바로 아래 → 넓은 구간
  assert.equal(fit(80000), 12);   // 0.8 — 경계 포함
  assert.equal(fit(120000), 12);  // 1.2 — 경계 포함
  assert.equal(fit(79999), 0);    // 구간 밖
  assert.equal(fit(120001), 0);   // 구간 밖
});

test('getHouseholdBonus·getParkingBonus — 등급 경계 + 0 나눗셈 방어', () => {
  const getHouseholdBonus = _reportFn('getHouseholdBonus');
  const getParkingBonus = _reportFn('getParkingBonus');

  for (const [n, want] of [[3000, 30], [2999, 25], [2000, 25], [1999, 20], [1000, 20],
    [999, 12], [500, 12], [499, 5], [300, 5], [299, 0]]) {
    assert.equal(getHouseholdBonus(n), want, `세대수 ${n} 의 보너스가 ${want} 가 아니다`);
  }
  // 세대수 미상은 0 — KAPT 미매칭 단지를 대단지로 오인하지 않는다
  assert.equal(getHouseholdBonus(null), 0);
  assert.equal(getHouseholdBonus(0), 0);
  assert.equal(getHouseholdBonus('많음'), 0);

  // 주차 비율 — ratio 는 **문자열**(toFixed(2))이다. 프론트가 그대로 표시하므로 타입이 계약의 일부다.
  assert.deepEqual(getParkingBonus(1300, 1000), { ratio: '1.30', bonus: 12 });
  assert.deepEqual(getParkingBonus(1000, 1000), { ratio: '1.00', bonus: 8 });
  assert.deepEqual(getParkingBonus(700, 1000), { ratio: '0.70', bonus: 3 });
  assert.deepEqual(getParkingBonus(699, 1000), { ratio: '0.70', bonus: 0 }); // 표시는 반올림, 판정은 원값
  // ★ 0 나눗셈·미상 방어 — Infinity/NaN 이 점수에 섞이면 그 단지가 상위권을 통째로 차지한다
  assert.deepEqual(getParkingBonus(1000, 0), { ratio: null, bonus: 0 });
  assert.deepEqual(getParkingBonus(0, 1000), { ratio: null, bonus: 0 });
  assert.deepEqual(getParkingBonus(null, null), { ratio: null, bonus: 0 });
});

// ── Plan 015 (2026-08-16): cron 인증 게이트 (`backend/routes/cron.js` authorizeCron) ──
//   왜 추가하나: `router.use(authorizeCron)` 하나가 **모든 cron 엔드포인트의 유일한 방어선**이다.
//   그 뒤에는 실거래 재적재·apt_master 동기화·retention hard delete(복구 불가 삭제)가 있다.
//   그런데 테스트가 **0** 이었다.
//   특히 `timingSafeEqual` 은 **두 버퍼 길이가 다르면 예외를 던진다** — 사전 길이 체크가 빠지면
//   틀린 길이의 토큰이 401 이 아니라 **500(예외)** 으로 나가고, 그건 방어 실패는 아니지만
//   "인증 실패"와 "서버 오류"를 구분 못 하게 만들어 실제 공격 시도를 로그에서 놓치게 한다.
//   프로덕션 코드는 바꾸지 않는다 — report.js/auth.js 와 같은 정규식 추출 패턴.
function _authorizeCron() {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  const re = new RegExp('function authorizeCron\\([\\s\\S]*?\\n\\}');
  const m = src.match(re);
  assert.ok(m, 'cron.js 에서 authorizeCron 을 찾지 못했다 (함수명·형태 변경 시 이 테스트도 갱신할 것)');
  // crypto·logger 는 모듈 스코프 require 라 주입한다. logger 는 호출만 삼킨다.
  return new Function('crypto', 'logger',
    'return (' + m[0].replace(/^function authorizeCron/, 'function') + ');')(
    require('node:crypto'), { error() {}, warn() {}, info() {} });
}

test('authorizeCron — cron 게이트: 시크릿 미설정 차단 + 헤더 조합별 판정', () => {
  const authorizeCron = _authorizeCron();
  // ⚠ 픽스처 값은 반드시 `xxx…` 형태로 둘 것 — `.gitleaks.toml` 의 allowlist(`xxx+`)에 걸리도록.
  //   실사례: 처음엔 변수명 SECRET 에 하이픈+숫자 섞인 문자열을 넣었다가 gitleaks 의
  //   generic-api-key 가 엔트로피 4.09 로 잡아 **CI 가 빨갛게 됐다**(run 31933274554). 같은 레포에서
  //   `key: 'acquisition_tax_2025'` 픽스처로 한 번 겪은 것과 같은 함정이다.
  //   설정을 완화하는 대신(=.gitleaks.toml 주석의 "전면 완화 금지") 픽스처를 더미답게 만든다.
  const TOKEN = 'xxxxxxxx-cron-fixture-xxxxxxxx';
  const call = (authHeader, secret) => {
    const saved = process.env.CRON_SECRET;
    if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
    const res = _mockRes();
    let nexted = false;
    try {
      authorizeCron({ headers: authHeader === undefined ? {} : { authorization: authHeader } },
        res, () => { nexted = true; });
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    }
    return { status: nexted ? null : res.statusCode, nexted };
  };

  // ★ CRON_SECRET 미설정 → 403 으로 완전 차단. 여기서 열리면 배포 사고 시 아무나
  //   retention(복구 불가 hard delete)을 강제 실행할 수 있다.
  assert.deepEqual(call(`Bearer ${TOKEN}`, undefined), { status: 403, nexted: false });
  assert.deepEqual(call(undefined, undefined), { status: 403, nexted: false });

  // 정상 토큰만 통과
  assert.deepEqual(call(`Bearer ${TOKEN}`, TOKEN), { status: null, nexted: true });

  // 헤더 없음 / Bearer 접두 없음 / 다른 스킴 → 전부 401
  assert.deepEqual(call(undefined, TOKEN), { status: 401, nexted: false });
  assert.deepEqual(call('', TOKEN), { status: 401, nexted: false });
  assert.deepEqual(call(TOKEN, TOKEN), { status: 401, nexted: false });          // 접두 없이 값만
  assert.deepEqual(call(`Basic ${TOKEN}`, TOKEN), { status: 401, nexted: false });
  // 접두 대소문자는 구분한다(현재 동작 고정)
  assert.deepEqual(call(`bearer ${TOKEN}`, TOKEN), { status: 401, nexted: false });

  // ★ 길이가 다른 토큰 — timingSafeEqual 예외 없이 401 이어야 한다(사전 길이 체크 계약)
  assert.deepEqual(call('Bearer x', TOKEN), { status: 401, nexted: false });
  assert.deepEqual(call(`Bearer ${TOKEN}x`, TOKEN), { status: 401, nexted: false });
  assert.deepEqual(call('Bearer ', TOKEN), { status: 401, nexted: false });

  // 같은 길이·다른 값 → 401 (비교 자체가 동작하는지)
  const sameLenWrong = 'X'.repeat(TOKEN.length);
  assert.equal(sameLenWrong.length, TOKEN.length);
  assert.deepEqual(call(`Bearer ${sameLenWrong}`, TOKEN), { status: 401, nexted: false });

  // 토큰 앞뒤 공백은 trim 후 비교(현재 동작 고정 — 스케줄러가 개행을 붙이는 사고 대비)
  assert.deepEqual(call(`Bearer ${TOKEN}  `, TOKEN), { status: null, nexted: true });
});

// ── Plan 016 (2026-08-16): 규제 판정 두 경로 정합 (REG-DUAL-PATH-FIX) ──
//   [왜 이 테스트가 필요한가] 오늘 하루에만 **"같은 규칙이 두 경로에 복제돼 한쪽만 고쳐졌다"** 가
//   세 번 나왔다: ① 취득세 6억 경계(프론트/백엔드) ② 결제 실패기록 금액 제외(confirm/webhook)
//   ③ 그리고 이것 — 규제지역 판정이 `_regLtvLabel`(lawdCd 우선)과 `isRegFront`(문자열 전용)로
//   갈려 있었다. 매번 "고친 뒤 다른 경로를 grep 한다"에 의존했으니 이번엔 **테스트로 묶는다.**
//
//   [실측 영향 범위] transactionService.LAWD_CODES 전수 대조 결과 두 함수가 갈리는 곳은
//   **정확히 1곳**: 부산 강서구(26440) — SEOUL_GU_KW 의 '강서' 에 부분일치한다.
//   같은 상세 모달에서 LTV 는 "70%(비규제)", 세금 시뮬레이션은 조정지역 중과(2주택 8%),
//   특약·리스크는 "규제지역 6개월 전입 의무" 로 **서로 모순되는 사실**이 동시에 표시됐다.
//
//   ⚠ 이 테스트가 **덮지 않는** 것(정직한 한계): `_regLtvLabel` 은 lawd_cd 가 11 이면
//   스냅샷의 `seoulRegulated` 를 보지 않고 무조건 '40%' 를 돌려준다(SEOUL-JUNGGU-FIX-2026-07-25).
//   그래서 서울이 규제 해제되어 스냅샷이 갱신되는 날에는 두 함수가 다시 갈린다.
//   아래는 **현재 상태(서울 전 지역 규제)** 만 고정한다 — 해제 시 대응은 운영자 판단 사항으로 보고했다.
function _regPairFns(regKw) {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const grab = (re, what) => {
    const m = html.match(re);
    assert.ok(m, `frontend/index.html 에서 ${what} 을 찾지 못했다 (형태 변경 시 이 테스트도 갱신할 것)`);
    return m[0];
  };
  // SEOUL_GU_KW 도 소스에서 그대로 가져온다 — 테스트에 복사해두면 목록이 바뀔 때 조용히 어긋난다.
  const kwSrc = grab(/const SEOUL_GU_KW = \[[\s\S]*?\];/, 'SEOUL_GU_KW');
  const isSrc = grab(/function isRegFront\(regionStr[\s\S]*?\n\}/, 'isRegFront');
  const lblSrc = grab(/function _regLtvLabel\(area[\s\S]*?\n\}/, '_regLtvLabel');
  return new Function('__REG',
    `${kwSrc}\nconst window = { __REG_KW: __REG };\n${isSrc}\n${lblSrc}\n`
    + 'return { isRegFront, _regLtvLabel };')(regKw);
}

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
    // ★ 핵심 계약: 두 경로가 **서로** 같아야 한다. 한쪽만 고치면 여기서 걸린다.
    assert.equal(a, b === '40%',
      `규제 판정 두 경로가 갈렸다 — '${area}'(${code}): isRegFront=${a} vs _regLtvLabel=${b}. ` +
      '한쪽만 고치지 말고 두 함수를 함께 볼 것.');
  }

  // lawd_cd 를 모르는 경로(사용자가 지역을 직접 타이핑하는 특약 탭·대출계산 탭)는
  // 기존 문자열 판정 그대로 — 회귀가 없어야 한다.
  assert.equal(isRegFront('서울 강남구'), true);
  assert.equal(isRegFront('강서구 명지동'), true);  // 코드가 없으면 여전히 구별 불가(알려진 한계)
  assert.equal(isRegFront('일산동구 마두동'), false);
});

// ── Plan 018 (2026-08-16): 서울 규제 **해제** 시나리오에서도 두 경로가 붙어 있는가 ──
//   계획 016 에서 남겨둔 잔여 항목. `_regLtvLabel` 은 lawd_cd 11 이면 스냅샷을 보지 않고
//   무조건 '40%' 였다 — 서울이 해제되면 `isRegFront` 만 비규제로 바뀌어 다시 갈린다.
//   실측 근거: regulations_snapshot.housing_loan_2025 의 regulatedRegions =
//     { seoul: "서울 전 지역 (25개 구)"(문자열), gyeonggi: [15개] }  (2026-08-16 DB 조회)
//     → regulationsService.js:202 `const seoulRegulated = !!reg.seoul` 로 boolean 이 된다.
test('서울 규제 해제 시나리오 — 스냅샷을 따라 두 경로가 함께 움직인다 (부팅 전엔 보수적 40%)', () => {
  // (1) 현행: 서울 전 지역 규제 → 양쪽 다 규제
  {
    const { isRegFront, _regLtvLabel } = _regPairFns({ keywords: ['과천시'], seoulRegulated: true });
    assert.equal(_regLtvLabel('강남구 대치동', '11680'), '40%');
    assert.equal(isRegFront('강남구 대치동', '11680'), true);
  }
  // (2) ★ 해제: 스냅샷이 seoulRegulated=false → **양쪽 다** 비규제로 움직여야 한다.
  //     여기서 _regLtvLabel 만 40% 로 남으면 해제된 서울 매물에 사실 아닌 한도를 표기한다.
  {
    const { isRegFront, _regLtvLabel } = _regPairFns({ keywords: ['과천시'], seoulRegulated: false });
    assert.equal(isRegFront('강남구 대치동', '11680'), false);
    assert.equal(_regLtvLabel('강남구 대치동', '11680'), '70%',
      '스냅샷이 서울 해제인데 _regLtvLabel 이 40% 로 남았다 — 두 경로가 갈렸다');
    // 경기 규제는 그대로여야 한다(서울 해제가 경기까지 풀면 안 된다)
    assert.equal(_regLtvLabel('과천시 별양동', '41290'), '40%');
  }
  // (3) ★ 스냅샷 **미로드**(부팅 직후) → 보수적으로 40% 유지.
  //     이때 70% 를 찍으면 서울 매물 한도를 부풀리는 반대 방향 오표기가 된다.
  {
    const { _regLtvLabel } = _regPairFns(undefined);
    assert.equal(_regLtvLabel('강남구 대치동', '11680'), '40%',
      '스냅샷 미로드인데 서울이 비규제(70%)로 표기됐다 — 한도 부풀림');
  }
});

// ── Plan 017 (2026-08-16): KOSIS 미분양 Redis 2차 캐시의 Map 직렬화 계약 ──
//   순이동 로더에 이미 있던 Redis 캐시를 미분양 로더에 역이식했는데, **그대로 복붙하면 죽는다.**
//   미분양 로더의 반환값은 `map` 이 Map 인스턴스이고 Upstash 는 set(객체)→JSON 직렬화라
//   Map 이 `{}` 로 납작해진다. 그러면 복원 후 getUnsoldTrend 의 `all.map.get(...)` 이
//   TypeError 로 죽어 **보고서의 미분양 패널이 통째로 500** 이 된다.
//   이 테스트는 pack/unpack 이 그 함정을 실제로 막는지, 그리고 이상한 값이 오면
//   조용히 null(캐시 미스)로 떨어지는지를 고정한다.
test('KOSIS 미분양 캐시 — Map 은 JSON 왕복을 못 견딘다: pack/unpack 계약', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../services/kosisService.js'), 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    assert.ok(m, `kosisService.js 에서 ${name} 을 찾지 못했다`);
    return m[0];
  };
  const { _packUnsold, _unpackUnsold } = new Function(
    `${grab('_packUnsold')}\n${grab('_unpackUnsold')}\nreturn { _packUnsold, _unpackUnsold };`)();

  const out = {
    map: new Map([['서울|종로구', [{ ym: '202605', cnt: 12 }, { ym: '202606', cnt: 9 }]],
      ['부산|해운대구', [{ ym: '202606', cnt: 401 }]]]),
    fetchedAt: '2026-08-16T00:00:00.000Z',
  };

  // ★ 함정 자체를 고정한다 — Map 을 그냥 실으면 복원 후 .get 이 사라진다(2026-08-16 Node 실측).
  const naive = JSON.parse(JSON.stringify(out));
  assert.equal(typeof naive.map.get, 'undefined',
    'Map 이 JSON 왕복을 견디게 됐다면 이 테스트와 pack/unpack 의 전제를 다시 확인할 것');

  // pack → (Upstash JSON 직렬화 모사) → unpack 이면 Map 이 살아 돌아온다
  const restored = _unpackUnsold(JSON.parse(JSON.stringify(_packUnsold(out))));
  assert.ok(restored.map instanceof Map, '복원 결과가 Map 이 아니다 — getUnsoldTrend 가 TypeError 로 죽는다');
  assert.deepEqual(restored.map.get('서울|종로구'), [{ ym: '202605', cnt: 12 }, { ym: '202606', cnt: 9 }]);
  assert.equal(restored.map.size, 2);
  assert.equal(restored.fetchedAt, out.fetchedAt);
  // getUnsoldTrend 가 실제로 쓰는 두 연산이 복원본에서 동작하는지
  assert.equal(typeof restored.map.get, 'function');
  assert.equal(typeof restored.map.entries, 'function');

  // ★ fail-safe — 형태가 이상하면 예외가 아니라 null(캐시 미스 → 외부 재조회)
  for (const bad of [null, undefined, {}, { entries: null }, { entries: '해킹' }, 'string', 0]) {
    assert.equal(_unpackUnsold(bad), null, `이상 입력 ${JSON.stringify(bad)} 에 null 이 아니다`);
  }
  // pack 도 Map 이 아니면 null → 호출측이 rset 자체를 건너뛴다(깨진 값을 24h 캐싱하지 않는다)
  assert.equal(_packUnsold(null), null);
  assert.equal(_packUnsold({ map: {} }), null);
  assert.equal(_packUnsold({ map: naive.map }), null);
});
