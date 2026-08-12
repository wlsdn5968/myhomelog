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
