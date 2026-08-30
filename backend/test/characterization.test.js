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
  //   ⚠ 감사 #30: 예전엔 `addrBonbun(a) === addrBonbun(b)` 로 **함수끼리** 비교했다.
  //     그러면 함수가 항상 null 을 돌려줘도 통과한다 → 리터럴 기대값으로 고정한다.
  assert.equal(addrBonbun('서울 도봉구 방학동 271-1'), '271');
  assert.equal(addrBonbun('서울 도봉구 방학동 271-4'), '271');
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
    officialAddress: '도봉구 방학동 271-1', placeName: '신동아1단지아파트',
  }), true);

  // ★ 기대값 변경 2026-08-17 (Sprint MMMMMMM) — 예전엔 이 케이스의 placeName 이
  //   '신동아1단지아파트 **노인정**' 인 채로 `true` 로 고정돼 있었다. 본번만 보고 무호출 통과시킨 것이다.
  //   그런데 **노인정 좌표는 단지 본체가 아니다** — 본번이 같아도 핀은 수십~수백m 어긋난다.
  //   서울 전수조사 4회차에서 이 단지가 실제 오배치 목록(도봉구 방학동 신동아아파트1 → "…노인정")에
  //   올라왔고, 전국 경로당/노인정 place 는 **298건**이다. '노인정'을 REHEAL_NONRES 에 넣어
  //   이제 fast-verify 가 거부하고 지오코딩 교정 경로로 내려간다 — 이것이 **의도한 동작 변경**이다.
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '서울 도봉구 방학동 271-4',
    officialAddress: '도봉구 방학동 271-1', placeName: '신동아1단지아파트 노인정',
  }), false);
  assert.equal(canFastVerify({
    addrFromMolit: true, storedAddress: '서울 노원구 상계동 700',
    officialAddress: '노원구 상계동 700-1', placeName: '상계주공10단지아파트 경로당',
  }), false, '경로당도 같은 이유로 무호출 통과 대상이 아니다');

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

  // ★★ 감사 #7: 위 케이스들은 전부 **reject** 경로인데, postgrest-js 는 실제로 reject 하지 않는다
  //   (구현 주석 참조 — 이 헬퍼의 reject 분기는 라이브러리 변경에 대비한 방어층이다).
  //   운영에서 진짜 일어나는 건 **error 를 담은 resolve** 이고, 그 경로에서 _softQuery 가 해야 할 일은
  //   "아무것도 하지 않는 것"이다. 변형하면 뒤이은 _isAbortErr 판정이 깨져 우리가 의도적으로 끊은
  //   요청이 'molit-error' 로 분류되고 **Sentry 이슈가 매일 쌓인다.**
  //   → 실제 shape 를 넣어 (a) 원형 보존 (b) 그 error 가 abort 로 판정됨 을 함께 못 박는다.
  const realShape = {
    data: null,
    error: {
      message: 'TimeoutError: The operation was aborted due to timeout',
      details: '', hint: '', code: '',
    },
  };
  const passed = await _softQuery(Promise.resolve(realShape));
  assert.deepEqual(passed, realShape,
    '_softQuery 가 postgrest 의 실패 resolve 를 변형했다 — 원형 그대로 통과해야 한다');
  const { _isAbortErr } = require('../routes/search');
  assert.equal(_isAbortErr(passed.error), true,
    '통과된 error 를 abort 로 판정하지 못한다 — 의도한 중단이 오류로 집계되고 Sentry 이슈가 매일 생긴다');
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
// ⚠ MOCK-EQ-RECORD-2026-08-16 (Plan 025) — **`.eq()` 인자를 기록한다. 무시하면 안 된다.**
//   [실사고] 이 목은 원래 `eq: () => c` 로 **인자를 통째로 버렸다**. 그 결과 프로덕션에서
//   CAS 가드(`.eq('status','requested')` — P0-5 동시처리 race 차단)나 소유자 필터
//   (`.eq('user_id', req.user.id)`)를 **지워도 결제 테스트 9건이 전부 초록**이었다.
//   돈 경로에 대해 잘못된 안심을 주는 구조라, 목이 필터를 기록하고 테스트가 그걸 단언한다.
//   `seen.updateFilters` / `seen.selectFilters` 는 [[col, val], …] 형태로 호출 순서대로 쌓인다.
// SELECT-RECORD-2026-08-28 (Plan 034): `.select()` 인자도 기록한다 — 응답에 내리면 안 되는 컬럼
//   (toss_payment_key·raw_response·failure_reason)이 새는 것을 계약으로 막으려면 필요하다.
//   목록 조회(`.order().limit()`) 경로도 지원한다: limit 이 await 대상이라 thenable 이어야 한다.
function _mockAdmin({ payRow, casRows, billingRow, listRows }) {
  const seen = { updates: [], updateFilters: [], selectFilters: [], upserts: [], tables: [], selects: [], clientCalls: [] };
  const upChain = (patch) => {
    const c = {
      eq: (col, val) => { seen.updateFilters.push([col, val]); return c; },
      select: async () => ({ data: casRows, error: null }),
      then: (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej),
    };
    seen.updates.push(patch);
    return c;
  };
  // UPSERT-MOCK-2026-08-16 (감사 #28): 목에 upsert 가 없어서 confirm **성공** 경로가
  //   `admin.from(...).upsert is not a function` 으로 죽고 next(err) 로 빠졌다.
  //   그런데 테스트가 next 를 `() => {}` 로 삼키고 res 도 안 봐서 **아무도 몰랐다** —
  //   즉 "결제 확정이 구독 기간을 실제로 기록하는가"는 테스트 0건이었다.
  //   테이블별로 다른 행을 돌려줘야 한다: payments 는 payRow, user_billing 은 billingRow.
  const makeSel = (table) => {
    const sel = {
      select: (cols) => { if (cols !== undefined) seen.selects.push(String(cols)); return sel; },
      eq: (col, val) => { seen.selectFilters.push([col, val]); return sel; },
      order: () => sel,
      limit: async () => ({ data: listRows || [], error: null }),
      maybeSingle: async () => ({ data: table === 'user_billing' ? (billingRow || null) : payRow, error: null }),
      update: upChain,
      upsert: async (row) => { seen.upserts.push({ table, row }); return { data: null, error: null }; },
    };
    return sel;
  };
  return {
    client: { from: (table) => { seen.tables.push(table); return makeSel(table); } },
    seen,
  };
}
/** 기록된 필터에 [col, val] 조합이 있는지 (순서·중복 무관) */
function _hasFilter(list, col, val) {
  return (list || []).some(([c, v]) => c === col && (val === undefined || v === val));
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
    // ★★ MOCK-EQ-RECORD-2026-08-16: 조회가 **소유자 필터**를 걸었는지. 이게 빠지면 남의 주문을
    //   orderId 만 알면 조회·확정할 수 있다. 목이 인자를 버리던 시절엔 지워도 통과했다.
    assert.ok(_hasFilter(seen.selectFilters, 'order_id', 'o1'),
      `confirm 조회에 order_id 필터가 없다: ${JSON.stringify(seen.selectFilters)}`);
    assert.ok(_hasFilter(seen.selectFilters, 'user_id', 'u1'),
      `confirm 조회에 소유자(user_id) 필터가 없다 — 남의 주문을 조회할 수 있다: ${JSON.stringify(seen.selectFilters)}`);
  });
});

// ── Plan 025 (2026-08-16): 결제 CAS 가드가 **실제로 걸리는지** 단언 ──
//   [왜] 감사에서 나온 지적 — 목의 `.eq()` 가 인자를 버려서, 프로덕션에서 CAS 조건
//   (`.eq('status','requested')`, P0-5 동시처리 race 차단)을 지워도 결제 테스트가 전부 초록이었다.
//   목이 필터를 기록하도록 고쳤으니(위 _mockAdmin), 그 조건이 실제로 걸리는지 여기서 못 박는다.
test('billing/confirm — captured 전환은 status=requested CAS 로만 (webhook 과의 race 차단)', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' };
  const axiosImpl = { post: async () => ({ data: { orderId: 'o1', status: 'DONE', totalAmount: 9900, method: '카드', approvedAt: '2026-08-16T00:00:00Z' } }) };
  await _withBillingStub2({ payRow, casRows: [{ order_id: 'o1' }], tossKey: 'test', axiosImpl }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')({ body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    const cap = seen.updates.find((u) => u && u.status === 'captured');
    assert.ok(cap, `captured 전환 update 가 없다: ${JSON.stringify(seen.updates)}`);
    // ★ 핵심: 이 두 필터가 함께 걸려야 "requested 인 것만 captured 로" 가 성립한다.
    assert.ok(_hasFilter(seen.updateFilters, 'order_id', 'o1'),
      `CAS update 에 order_id 필터가 없다: ${JSON.stringify(seen.updateFilters)}`);
    assert.ok(_hasFilter(seen.updateFilters, 'status', 'requested'),
      'CAS 가드(.eq("status","requested")) 가 없다 — webhook 이 먼저 captured 시켜도 confirm 이 덮어쓴다: '
      + JSON.stringify(seen.updateFilters));
  });
});

// ── 감사 #28 (2026-08-16): confirm 성공의 **마지막 배선** — 구독 기간이 실제로 기록되는가 ──
//   [왜] 결제가 승인되고 payments 가 captured 로 바뀌어도, `user_billing` 에 기간이 안 들어가면
//   **돈은 받았는데 이용권이 안 생긴다**. 그런데 목에 upsert 가 없어 이 경로는 항상 예외로 끝났고,
//   테스트가 next 를 삼켜서 통과했다 — 즉 이 배선은 지금까지 검증된 적이 없다.
//   기간 **계산**(computePeriodEnd)은 Plan 004 가 경계 4케이스로 이미 고정했다. 여기서 막는 건
//   "계산 결과가 plan·status 와 함께 user_billing 에 실제로 쓰이는가" 라는 **호출 배선**이다.
const _confirmOk = (extra = {}) => ({
  payRow: { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' },
  casRows: [{ order_id: 'o1' }],
  tossKey: 'test',
  axiosImpl: { post: async () => ({ data: { orderId: 'o1', status: 'DONE', totalAmount: 9900, method: '카드', approvedAt: '2026-08-16T00:00:00Z' } }) },
  ...extra,
});

test('billing/confirm 성공 — user_billing 에 plan·active·기간이 실제로 기록된다', async () => {
  await _withBillingStub2(_confirmOk({ billingRow: null }), async (seen) => {
    const res = _mockRes();
    let nextErr = null;
    await _billingHandler('/confirm')(
      { body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => { nextErr = e; });

    // ★ next(err) 를 삼키지 않는다 — 이걸 안 봐서 upsert 부재가 3개월 숨어 있었다
    assert.equal(nextErr, null, `confirm 성공 경로가 에러로 빠졌다: ${nextErr && nextErr.message}`);
    assert.equal(res.statusCode, 200);

    const up = seen.upserts.find((u) => u.table === 'user_billing');
    assert.ok(up, `user_billing upsert 가 없다 — 결제는 됐는데 이용권이 안 생긴다: ${JSON.stringify(seen.upserts)}`);
    assert.equal(up.row.user_id, 'u1');
    assert.equal(up.row.plan, 'pro', '결제한 플랜과 다른 플랜이 기록된다');
    assert.equal(up.row.status, 'active');
    assert.equal(up.row.canceled_at, null, '재결제인데 이전 해지 표시가 남는다');
    assert.ok(up.row.current_period_end, 'current_period_end 가 비어 있다');
  });
});

test('billing/confirm 성공 — 기존 구독이 남아 있으면 그 만료일 기준으로 이월된다', async () => {
  // 미래 만료(2026-09-01)가 남은 상태에서 재결제 → now+30 이 아니라 기존 만료+30 이어야 한다.
  const existingEnd = '2026-09-01T00:00:00.000Z';
  await _withBillingStub2(_confirmOk({ billingRow: { current_period_end: existingEnd } }), async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')(
      { body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    const up = seen.upserts.find((u) => u.table === 'user_billing');
    assert.ok(up, 'user_billing upsert 가 없다');
    // 라우트가 쓴 값이 planService 의 단일 소스와 같은지 — 인라인 재구현으로 갈라지는 것을 막는다
    const expected = require('../services/planService').computePeriodEnd(existingEnd, new Date()).toISOString();
    assert.equal(up.row.current_period_end, expected,
      `이월 계산이 planService.computePeriodEnd 와 다르다 (기존 만료 ${existingEnd} 무시 의심)`);
    // 기존 만료보다 뒤여야 한다는 것도 못 박는다(계산식이 통째로 now 기준으로 바뀌면 여기서 걸린다)
    assert.ok(new Date(up.row.current_period_end) > new Date(existingEnd),
      '재결제인데 만료일이 기존보다 앞이다 — 사용자가 기간을 손해본다');
  });
});

// ── Plan 012-2 (2026-08-16): webhook 상태 분기 + 환불 7일 창 ──────────
//   Plan 012 는 confirm 경로만 덮었다. 결제를 켜기 전 나머지 두 축을 고정한다.
//   webhook 은 Toss 재조회(axios)가 **사실상 서명 검증 역할**이라 axios 스텁이 필요하고,
//   환불 7일 경계는 payRow 의 approved_at 을 조작하면 **타이머 제어 없이** 검증된다.
//   여기서도 프로덕션 코드는 바꾸지 않는다 — 라우터 스택에서 핸들러만 꺼내 쓴다.
async function _withBillingStub2({ payRow, casRows, tossKey, webhookSecret, axiosImpl, billingRow, listRows, clientKey, liveEnabled }, fn) {
  const clientPath = require.resolve('../db/client');
  const billPath = require.resolve('../routes/billing');
  const axiosPath = require.resolve('axios');
  const saved = { c: require.cache[clientPath], b: require.cache[billPath], a: require.cache[axiosPath] };
  const savedEnv = { k: process.env.TOSS_SECRET_KEY, w: process.env.TOSS_WEBHOOK_SECRET,
    ck: process.env.TOSS_CLIENT_KEY, lv: process.env.PAYMENTS_LIVE_ENABLED };
  const { client, seen } = _mockAdmin({ payRow, casRows, billingRow, listRows });
  if (tossKey === undefined) delete process.env.TOSS_SECRET_KEY; else process.env.TOSS_SECRET_KEY = tossKey;
  if (webhookSecret === undefined) delete process.env.TOSS_WEBHOOK_SECRET; else process.env.TOSS_WEBHOOK_SECRET = webhookSecret;
  // PG-MODE-2026-08-28: /config·/checkout 의 mode 판정 테스트용 env.
  if (clientKey === undefined) delete process.env.TOSS_CLIENT_KEY; else process.env.TOSS_CLIENT_KEY = clientKey;
  if (liveEnabled === undefined) delete process.env.PAYMENTS_LIVE_ENABLED; else process.env.PAYMENTS_LIVE_ENABLED = liveEnabled;
  // CLIENT-CALL-RECORD-2026-08-28 (Plan 034): 어느 팩토리를 썼는지 기록한다 — 조회 라우트가
  //   service-role(getSupabaseAdmin)로 갈아타면 RLS 를 우회하게 되므로 그 회귀를 계약으로 막는다.
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
    getSupabaseAdmin: () => { seen.clientCalls.push('admin'); return client; },
    getSupabaseReadonly: () => { seen.clientCalls.push('readonly'); return client; },
    getUserScopedClient: () => { seen.clientCalls.push('userScoped'); return client; } } };
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
    if (savedEnv.ck === undefined) delete process.env.TOSS_CLIENT_KEY; else process.env.TOSS_CLIENT_KEY = savedEnv.ck;
    if (savedEnv.lv === undefined) delete process.env.PAYMENTS_LIVE_ENABLED; else process.env.PAYMENTS_LIVE_ENABLED = savedEnv.lv;
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

// ── Plan 034 (2026-08-28): GET /billing/payments 계약 ──────────────────────
//   왜 계약 테스트인가: payments 테이블이 **0행**(2026-08-28 실측)이라 라이브로는 RLS 도,
//   응답 필드도 증명할 수 없다. 그래서 "어느 클라이언트를 쓰는가 / 무엇을 select 하는가"를
//   목이 기록하고 여기서 단언한다 — Plan 025 가 `.eq()` 인자를 기록해 소유자 필터를 고정한 것과 같은 방식.
test('billing/payments — 본인 결제내역만, 내부 식별자·PG 원문은 내리지 않는다', async () => {
  const rows = [
    { id: 'p2', order_id: 'o2', amount: 9900, plan: 'pro', status: 'captured',
      approved_at: '2026-08-27T00:00:00Z', created_at: '2026-08-27T00:00:00Z' },
    { id: 'p1', order_id: 'o1', amount: 9900, plan: 'pro', status: 'refunded',
      approved_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z' },
  ];
  await _withBillingStub2({ payRow: null, casRows: [], tossKey: 'test', listRows: rows }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/payments')(_req({}), res, (e) => { assert.fail(`next(err): ${e && e.message}`); });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { payments: rows }, '결제내역이 그대로 내려가야 한다');

    // ① RLS 를 타는 클라이언트여야 한다 — service-role 로 갈아타면 소유자 필터가 유일한 방어선이 된다
    assert.ok(seen.clientCalls.includes('userScoped'),
      'GET /payments 가 userScopedClient 를 쓰지 않는다 — RLS 우회');
    assert.ok(!seen.clientCalls.includes('admin'),
      'GET /payments 가 service-role(getSupabaseAdmin)을 쓴다 — RLS 를 우회하면 안 된다');

    // ② 소유자 필터(이중 방어) — RLS 가 꺼지거나 정책이 바뀌어도 남의 결제가 새면 안 된다
    assert.ok(_hasFilter(seen.selectFilters, 'user_id', 'u1'),
      "GET /payments 에 .eq('user_id', req.user.id) 가 없다");

    // ③ 응답에 새면 안 되는 컬럼 — select 문자열로 고정한다
    const cols = seen.selects.join(' ');
    assert.ok(seen.tables.includes('payments'), 'payments 테이블을 조회하지 않았다');
    for (const forbidden of ['toss_payment_key', 'raw_response', 'failure_reason']) {
      assert.ok(!cols.includes(forbidden),
        `GET /payments 응답에 ${forbidden} 이 포함됐다 — 내부 식별자/PG 원문은 내리지 않는다`);
    }
    // 환불 버튼이 서버와 같은 기준으로 판단하려면 이 둘이 반드시 있어야 한다(7일 창 = approved_at || created_at)
    for (const need of ['id', 'status', 'approved_at', 'created_at']) {
      assert.ok(cols.includes(need), `GET /payments 응답에 ${need} 이 빠졌다 — 환불 버튼 판정이 불가능해진다`);
    }
  });
});

// ── PG-MODE (2026-08-28): 결제 개방 판정을 서버가 소유한다 ────────────────────
//   왜 계약인가: 종전엔 프론트 상수(PG_LAUNCH_BLOCKED)가 차단을 담당해 **키 교체와 코드 변경이
//   따로 놀았다**. 이제 /config 의 mode 하나로 결정하는데, 이 판정이 틀리면 곧바로 금전 사고다
//   (라이브 키가 들어가자마자 실결제가 열리거나, ck/sk 가 섞여 결제는 되고 확정이 실패한다).
test('billing/config — mode 판정 5종 (none·test·live_locked·live·mismatch)', async () => {
  const cases = [
    { name: 'none', env: {}, mode: 'none', open: false },
    { name: 'test', env: { clientKey: 'test_ck_x', tossKey: 'test_sk_x' }, mode: 'test', open: true },
    { name: 'live_locked', env: { clientKey: 'live_ck_x', tossKey: 'live_sk_x' }, mode: 'live_locked', open: false },
    { name: 'live', env: { clientKey: 'live_ck_x', tossKey: 'live_sk_x', liveEnabled: 'true' }, mode: 'live', open: true },
    { name: 'mismatch(ck test + sk live)', env: { clientKey: 'test_ck_x', tossKey: 'live_sk_x' }, mode: 'mismatch', open: false },
    { name: 'mismatch(ck live + sk test)', env: { clientKey: 'live_ck_x', tossKey: 'test_sk_x', liveEnabled: 'true' }, mode: 'mismatch', open: false },
  ];
  for (const c of cases) {
    await _withBillingStub2({ payRow: null, casRows: [], ...c.env }, async () => {
      const res = _mockRes();
      _billingHandler('/config')(_req({}), res, () => {});
      assert.equal(res.body.mode, c.mode, `${c.name}: mode 오판 (${res.body.mode})`);
      assert.equal(res.body.checkoutEnabled, c.open, `${c.name}: checkoutEnabled 오판`);
    });
  }
});

test('billing/checkout — 라이브 키만 있고 플래그가 없으면(live_locked) 주문을 발급하지 않는다', async () => {
  // 프론트 차단은 API 직접 호출로 우회된다 → 서버가 같은 판정으로 막아야 한다.
  const blocked = [
    { name: 'live_locked', env: { clientKey: 'live_ck_x', tossKey: 'live_sk_x' } },
    { name: 'mismatch', env: { clientKey: 'test_ck_x', tossKey: 'live_sk_x' } },
  ];
  for (const c of blocked) {
    await _withBillingStub2({ payRow: null, casRows: [], ...c.env }, async (seen) => {
      const res = _mockRes();
      await _billingHandler('/checkout')(_req({ body: { plan: 'pro' } }), res, () => {});
      assert.equal(res.statusCode, 503, `${c.name}: 주문이 발급됐다`);
      assert.equal(res.body.code, 'pg_not_ready');
      assert.equal(seen.upserts.length, 0, `${c.name}: 차단 상태인데 DB 쓰기가 일어났다`);
    });
  }
  // 반대로 test 모드에서는 게이트를 통과해야 한다(여기서 막히면 리허설 자체가 불가능해진다).
  await _withBillingStub2({ payRow: null, casRows: [], clientKey: 'test_ck_x', tossKey: 'test_sk_x' }, async () => {
    const res = _mockRes();
    await _billingHandler('/checkout')(_req({ body: { plan: 'pro' } }), res, () => {});
    assert.notEqual(res.body && res.body.code, 'pg_not_ready', 'test 모드인데 결제 게이트가 막았다');
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

  // ★ lawd_cd 가 없으면 '미확인' 이다 — REG-UNKNOWN-2026-08-16 (감사 #9).
  //   예전엔 여기서 '비규제' 가 나왔고 이 테스트가 그 값을 **정답으로 고정**하고 있었다.
  //   그런데 `regulation` 필드는 '미확인' 이면 null 로 생략되지만 '비규제' 는 화면에 그대로 뜬다
  //   (report.js:908). 즉 코드 없이 부르면 강남구에 "비규제" 라는 **사실 아닌 라벨**이 붙는다.
  //   코드가 없다는 건 "규제가 아니다" 가 아니라 "판정할 근거가 없다" 는 뜻이다(절대룰 ②).
  //   ⚠ 현재 이 분기는 **도달 불가**다(apt_master 14,405행 중 lawd_cd 결측 0건 실측).
  //     그래서 이 수정의 회귀 위험은 0이고, 훗날 코드 없는 호출부가 생겼을 때의 방어로만 존재한다.
  assert.deepEqual(getRegulationPenalty('강남구', ''), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('강남구', null), { status: '미확인', bonus: 0 });

  // ★★ Plan 027 (2026-08-16): 이 함수는 규제 판정의 **네 번째 사본**이었고, 프론트 두 함수가
  //   스냅샷을 따라가게 된 뒤에도 여기만 "서울=조정대상" 을 하드코딩하고 있었다.
  //   ⚠ 그리고 **이 테스트가 그 하드코딩을 정답으로 고정**하고 있었다(감사 지적).
  //   이제 3번째 인자로 스냅샷 상태를 받으므로 **두 상태 모두** 고정한다.
  //   기본값은 true(규제) — 스냅샷 조회 실패 시 보수적. 프론트 _regLtvLabel 미로드 동작과 같은 방향.
  assert.deepEqual(getRegulationPenalty('노원구', LAWD.노원구, true), { status: '조정대상지역', bonus: -3 });
  assert.deepEqual(getRegulationPenalty('강남구', LAWD.강남구, true), { status: '투기과열·토허구역 일부', bonus: -8 });
  // 해제 시: 서울 분기를 타지 않고 '미확인'(= 라벨 생략·감산 0) 으로 떨어져야 한다
  assert.deepEqual(getRegulationPenalty('노원구', LAWD.노원구, false), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('강남구', LAWD.강남구, false), { status: '미확인', bonus: 0 },
    '서울 해제인데 강남구에 투기과열 라벨이 남았다 — 프론트는 비규제로 바뀌므로 서비스가 서로 다른 말을 한다');
  // 지방은 스냅샷 상태와 무관하게 '미확인'
  assert.deepEqual(getRegulationPenalty('해운대구', LAWD.해운대구, false), { status: '미확인', bonus: 0 });
  assert.deepEqual(getRegulationPenalty('해운대구', LAWD.해운대구, true), { status: '미확인', bonus: 0 });
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

// ══════════════════════════════════════════════════════════════════════════════
// Plan 023 (2026-08-16): 중개보수 tier 경계 — **주 경로(스냅샷) == 폴백 경로(법정 하드코딩)**
//
// [실사고] 계획 008(02f4a26)이 취득세 경계를 `<` → `<=` 로 고쳤는데, 그 한 줄이 **같은 헬퍼를
//   쓰던 중개보수까지** 바꿨다. 두 tier 표는 `underAuk` 라는 같은 필드를 쓰지만 법정 경계가 반대다:
//     · 취득세   지방세법 §11①8호          — "6억원 **이하** 1%"    → `<=`
//     · 중개보수 공인중개사법 시행규칙 별표1 — "2억~9억원 **미만** 0.4%" → `<`
//   그 결과 0.5·2·9·12·15억 정확히 5개 지점에서 법정 요율과 어긋났다
//   (라이브 실측 2026-08-16: 9억 −90만 · 12억 −120만 · 15억 −150만 **과소**, 0.5억 +5만 · 2억 +20만 과대).
//   커밋 메시지는 "경계값 하나만 바뀌고 회귀 위험 낮음" 이었다 — **공유 헬퍼의 두 번째 소비처를
//   확인하지 않은 것**이 근본 원인이고, 기존 테스트는 폴백 경로(`source:'fallback'`)만 봐서 못 잡았다.
//
// [이 테스트가 고정하는 것] 스냅샷 tier 로 계산한 값과, 법령을 그대로 옮긴 하드코딩 폴백이
//   **모든 경계에서 같아야 한다**. 손으로 고른 지점이 아니라 tier 의 `underAuk` 에서 경계를
//   **파생**시켜 그 앞·정확히·뒤 3점을 전부 본다(계획 022 의 교훈 — 손으로 고른 목록은 빠뜨린다).
// ══════════════════════════════════════════════════════════════════════════════
test('중개보수 tier — 스냅샷 경로와 법정 폴백이 모든 경계에서 일치한다 (공인중개사법 별표1 = 미만)', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  // 프로덕션에 실제로 실린 tier (regulations_snapshot.acquisition_tax_2025.commission, 2026-08-16 DB 실측)
  const COMMISSION_TIERS = [
    { rate: 0.006, underAuk: 0.5 }, { rate: 0.005, underAuk: 2 },
    { rate: 0.004, underAuk: 9 }, { rate: 0.005, underAuk: 12 },
    { rate: 0.006, underAuk: 15 }, { rate: 0.007, underAuk: 999 },
  ];
  // 법령 그대로 (별표1 매매·교환) — 프론트 7477행·백엔드 analysisService 폴백과 동일한 식
  const legalRate = (p) => (p < 0.5 ? 0.006 : p < 2 ? 0.005 : p < 9 ? 0.004
    : p < 12 ? 0.005 : p < 15 ? 0.006 : 0.007);

  const grabFront = (name) => {
    const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
    const m = html.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    assert.ok(m, `frontend/index.html 에서 ${name} 을 찾지 못했다`);
    return new Function(`${m[0]}; return ${name};`)();
  };
  const frontUnder = grabFront('_pickTierRateUnder');
  const frontIncl = grabFront('_pickTierRate');

  // 경계를 **데이터에서 파생** — tier 목록이 바뀌어도 자동으로 따라간다
  const bounds = COMMISSION_TIERS.map((t) => t.underAuk).filter((v) => v < 999);
  assert.ok(bounds.length >= 5, `경계가 ${bounds.length}개뿐 — tier 표가 바뀌었는지 확인할 것`);

  for (const b of bounds) {
    for (const p of [Number((b - 0.01).toFixed(2)), b, Number((b + 0.01).toFixed(2))]) {
      const law = legalRate(p);
      assert.equal(frontUnder(COMMISSION_TIERS, p, 0.007), law,
        `프론트 중개보수 ${p}억: 스냅샷 경로가 법정 요율(${(law * 100).toFixed(1)}%)과 다르다`);
    }
    // ★ 경계 **정확히** 그 값일 때가 사고 지점이었다 — '이하' 헬퍼를 쓰면 여기서 갈린다.
    assert.notEqual(frontIncl(COMMISSION_TIERS, b, 0.007), undefined);
    if (frontIncl(COMMISSION_TIERS, b, 0.007) !== legalRate(b)) {
      // 이 분기가 도는 것이 정상이다: '이하' 헬퍼는 중개보수에 쓰면 안 된다는 사실 자체를 고정한다.
      assert.notEqual(frontIncl(COMMISSION_TIERS, b, 0.007), frontUnder(COMMISSION_TIERS, b, 0.007),
        `${b}억에서 두 헬퍼가 같은 값을 낸다 — 경계 분리가 무의미해졌으니 이 테스트를 재검토할 것`);
    }
  }

  // 백엔드 쌍둥이도 같은 계약 (지금은 라우트가 taxConfig 를 안 넘겨 도달 불가지만,
  //   넘기는 순간 되살아나는 결함이라 함께 고정한다 — 오늘만 "한쪽만 고침"이 4번 나왔다)
  const beSrc = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  const mBe = beSrc.match(/function pickTierRateUnder\([\s\S]*?\n\}/);
  assert.ok(mBe, 'analysisService.js 에서 pickTierRateUnder 를 찾지 못했다');
  const beUnder = new Function(`${mBe[0]}; return pickTierRateUnder;`)();
  for (const b of bounds) {
    assert.equal(beUnder(COMMISSION_TIERS, b, 0.007), legalRate(b),
      `백엔드 중개보수 ${b}억이 법정 요율과 다르다`);
    assert.equal(beUnder(COMMISSION_TIERS, b, 0.007), frontUnder(COMMISSION_TIERS, b, 0.007),
      `${b}억에서 프론트↔백엔드 중개보수가 갈렸다`);
  }

  // 취득세는 반대로 '이하' 가 맞다 — 두 표의 경계 의미가 다르다는 것 자체를 고정한다
  const ACQ_TIERS = [{ rate: 0.01, underAuk: 6 }, { rate: 0.02, underAuk: 9 }, { rate: 0.03, underAuk: 999 }];
  assert.equal(frontIncl(ACQ_TIERS, 6, 0.03), 0.01, '취득세 6억 정확히는 1%(지방세법 §11①8호 6억 이하)여야 한다');
  assert.equal(frontIncl(ACQ_TIERS, 9, 0.03), 0.02, '취득세 9억 정확히는 누진구간(2% tier)이어야 한다');

  // ★★ 배선(wiring) 계약 — 헬퍼가 옳아도 **호출부가 틀린 헬퍼를 부르면** 사고가 그대로 재현된다.
  //   [실측 근거] 위 단언들만 있을 때 회귀 주입(호출부를 `_pickTierRateUnder` → `_pickTierRate` 로
  //   되돌림)을 했더니 **65개 전부 통과했다** — 원래 사고를 그대로 되돌려도 못 잡았다.
  //   함수 단위 테스트는 "함수가 옳은가"만 보고 "누가 그 함수를 쓰는가"는 안 본다.
  const feSrc = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const feCall = feSrc.split('\n').find((l) => /cr\s*=\s*_pickTierRate\w*\(tc\.commission/.test(l));
  assert.ok(feCall, '프론트에서 중개보수 요율 선택 호출부를 찾지 못했다 (형태 변경 시 이 테스트도 갱신할 것)');
  assert.match(feCall, /_pickTierRateUnder\(tc\.commission/,
    `프론트 중개보수가 '이하' 헬퍼를 쓰고 있다 — 별표1 은 '미만' 경계다: ${feCall.trim()}`);

  const beCall = beSrc.split('\n').find((l) => /commRate\s*=\s*pickTierRate\w*\(taxConfig\.commission/.test(l));
  assert.ok(beCall, '백엔드에서 중개보수 요율 선택 호출부를 찾지 못했다');
  assert.match(beCall, /pickTierRateUnder\(taxConfig\.commission/,
    `백엔드 중개보수가 '이하' 헬퍼를 쓰고 있다: ${beCall.trim()}`);

  // 취득세 호출부는 반대로 '이하' 헬퍼여야 한다(Under 를 잘못 쓰면 6억에서 다시 1,200만원 과다).
  //   ⚠ `rate = _pickTierRate…(at.` 형태만 잡는다. 처음엔 `\((at|tiers)\b` 로 느슨하게 썼다가
  //   **함수 정의 줄까지 매칭**해 테스트가 자기 자신 때문에 실패했다(2026-08-16 실측) —
  //   소스 텍스트 기반 단언은 정의/호출을 반드시 구분할 것.
  const acqCalls = feSrc.split('\n').filter((l) => /rate\s*=\s*_pickTierRate\w*\(at\./.test(l));
  assert.ok(acqCalls.length >= 2,
    `취득세 호출부를 ${acqCalls.length}개만 찾았다 — 형태 변경 시 이 테스트도 갱신할 것`);
  for (const l of acqCalls) {
    assert.ok(!/_pickTierRateUnder/.test(l),
      `취득세 호출부가 '미만' 헬퍼를 쓰고 있다 — §11①8호는 '6억 이하'다: ${l.trim()}`);
  }
});

// ── Plan 023-2: cron 인증 **배선** 계약 (감사 워크플로 지적 — 함수만 보고 router.use 는 안 봤다) ──
//   `authorizeCron` 함수 자체는 아래 테스트가 12개 조합으로 고정하지만, 그 함수가 **라우터에
//   실제로 물려 있는지**는 아무도 안 봤다. `router.use(authorizeCron)` 한 줄이 사라지면
//   실거래 재적재·apt_master 동기화·retention hard delete(복구 불가)가 인증 없이 열리는데
//   테스트는 초록이다. 위 중개보수 배선 누락과 **같은 클래스**라 함께 막는다.
test('cron 라우터 배선 — authorizeCron 이 모든 엔드포인트 앞에 물려 있다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  const lines = src.split('\n');

  const useIdx = lines.findIndex((l) => /^\s*router\.use\(\s*authorizeCron\s*\)/.test(l));
  assert.ok(useIdx >= 0, 'cron.js 에 `router.use(authorizeCron)` 이 없다 — 모든 cron 엔드포인트가 무인증으로 열린다');

  // ★ 라우트 정의보다 **먼저** 와야 한다. 뒤에 오면 앞선 라우트는 게이트를 통과하지 않는다.
  const firstRouteIdx = lines.findIndex((l) => /^\s*router\.(get|post|put|patch|delete)\s*\(/.test(l));
  assert.ok(firstRouteIdx >= 0, 'cron.js 에서 라우트 정의를 찾지 못했다');
  assert.ok(useIdx < firstRouteIdx,
    `router.use(authorizeCron) 이 첫 라우트(${firstRouteIdx + 1}행)보다 뒤(${useIdx + 1}행)에 있다 — 앞선 라우트가 무인증이다`);

  // 이 파일이 실제로 여러 cron 엔드포인트를 들고 있는지도 확인(빈 파일이면 위 단언이 무의미해진다)
  const routeCount = lines.filter((l) => /^\s*router\.(get|post|put|patch|delete)\s*\(/.test(l)).length;
  assert.ok(routeCount >= 5, `cron 라우트가 ${routeCount}개뿐 — 파일 구조가 바뀌었는지 확인할 것`);
});

// ── 감사 #2 (2026-08-16): billing 인증 **배선** 계약 ──────────────────────────
//   [왜] 위 cron 배선 계약은 Plan 023-2 에서 만들었는데 **billing 에는 같은 방어가 없었다**.
//   결제 테스트는 `router.stack` 에서 route 레이어의 핸들러만 꺼내 직접 호출하므로
//   (`l.route` 가 있는 레이어만 찾는다 — `router.use` 미들웨어는 `l.route` 가 undefined)
//   인증 게이트를 통째로 지워도 결제 테스트가 전부 초록이다. 실제로 테스트 req 에
//   `user: { id: 'u1' }` 을 손으로 주입하는 것 자체가 게이트를 안 거친다는 증거다.
//   ★ 특히 이 파일은 게이트(router.use)가 파일 **중간**에 있고 그 앞에 공개 라우트 2개가 있다.
//     새 라우트를 무심코 그 위에 추가하면 무인증으로 열린다 — 그걸 여기서 막는다.
test('billing 라우터 배선 — requireAuth 게이트가 보호 대상 라우트 앞에 있고, 그 앞은 공개 허용 라우트뿐', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/billing.js'), 'utf8');
  const lines = src.split('\n');

  // 1) 게이트 존재 — router.use(...) 블록 안에서 requireAuth 를 호출한다
  const useIdx = lines.findIndex((l) => /^\s*router\.use\(/.test(l));
  assert.ok(useIdx >= 0, 'billing.js 에 router.use 게이트가 없다 — 결제 라우트가 무인증으로 열린다');
  const gateBlock = lines.slice(useIdx, useIdx + 6).join('\n');
  assert.match(gateBlock, /requireAuth\s*\(/,
    `router.use 블록이 requireAuth 를 호출하지 않는다:\n${gateBlock}`);

  // 2) webhook 예외는 **POST + 경로 끝이 /webhook** 일 때만. 조건이 느슨해지면 인증이 뚫린다.
  //    (Toss 서버가 JWT 없이 호출하므로 이 예외 자체는 의도된 설계 — AUTH-FIX-2026-05-21)
  assert.match(gateBlock, /req\.method\s*===\s*'POST'/,
    'webhook 예외에 method 조건이 없다 — GET 으로도 인증을 우회할 수 있다');
  assert.match(gateBlock, /req\.path\.endsWith\('\/webhook'\)/,
    "webhook 예외가 endsWith('/webhook') 가 아니다 — 경로 조건이 느슨하면 다른 라우트도 열린다");

  // 3) 게이트보다 **앞에** 정의된 라우트는 공개가 의도된 것만이어야 한다.
  //    새 라우트를 위쪽에 추가하면 조용히 무인증이 되므로 허용 목록으로 못 박는다.
  const PUBLIC_OK = ['/config', '/plans'];
  const routeRe = /^\s*router\.(get|post|put|patch|delete)\s*\(\s*'([^']+)'/;
  const before = [];
  const after = [];
  lines.forEach((l, i) => {
    const m = l.match(routeRe);
    if (!m) return;
    (i < useIdx ? before : after).push(m[2]);
  });
  assert.ok(after.length >= 4, `게이트 뒤 라우트가 ${after.length}개뿐 — 파일 구조가 바뀌었는지 확인할 것`);
  const unexpected = before.filter((p) => !PUBLIC_OK.includes(p));
  assert.deepEqual(unexpected, [],
    `인증 게이트보다 앞에 있는 비공개 라우트: ${JSON.stringify(unexpected)} — 무인증으로 열려 있다. `
    + `공개가 맞다면 PUBLIC_OK 에 근거와 함께 추가할 것 (현재 허용: ${JSON.stringify(PUBLIC_OK)})`);

  // 4) 돈이 움직이는 라우트는 반드시 게이트 뒤에 있어야 한다
  for (const p of ['/confirm', '/cancel', '/checkout']) {
    assert.ok(after.includes(p), `${p} 가 인증 게이트 뒤에 없다 — 결제 경로가 무인증이다`);
  }
});

// ── 감사 #45 (2026-08-16): 응답 직전 관측이 **await 되는지** 소스 계약 ────────────────
//   [왜] 이건 단위 테스트로 잡을 수 없는 종류다 — 유실은 "서버리스가 응답 후 함수를 동결할 때"
//   일어나고, 로컬에서는 Redis 도 동결도 재현되지 않는다(실제로 await 를 지우는 회귀 주입을 해도
//   테스트 71개가 전부 초록이었다). 그래서 **동작이 아니라 소스의 형태**를 고정한다.
//   cron·billing 배선 계약과 같은 부류: 지워지면 조용히 관측만 사라지고 아무도 모른다.
test('강등 관측 배선 — popular-stale 은 응답 전에 await 된다 (서버리스 동결 유실 차단)', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');

  // 1) 함수가 Promise 를 돌려줘야 호출부가 기다릴 수 있다 (return 이 없으면 await 가 무의미)
  //    DEGRADE-SHARED-2026-08-17: 구현이 services/degradeStats 로 옮겨졌으므로 **소스 정규식이 아니라
  //    실제로 실행해서** Promise 인지 확인한다(형태 검사보다 강하다 — 위임이 끊기면 여기서 잡힌다).
  const fnStart = src.indexOf('function _observeDegrade(');
  assert.ok(fnStart >= 0, 'search.js 에서 _observeDegrade 를 찾지 못했다');
  const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
  assert.match(fnBody, /return\s+/,
    '_observeDegrade 가 아무것도 반환하지 않는다 — 호출부가 await 해도 즉시 통과한다');
  const { observeDegrade } = require('../services/degradeStats');
  const ret = observeDegrade('test-kind');
  assert.ok(ret && typeof ret.then === 'function',
    'degradeStats.observeDegrade 가 Promise 를 반환하지 않는다 — await 가 무의미해진다');

  // 2) 응답 직전 경로(popular-stale)는 반드시 await
  assert.match(src, /await\s+_observeDegrade\('popular-stale'\)/,
    "popular-stale 강등이 await 되지 않는다 — res.json 직후 동결되면 관측이 유실된다");

  // 3) await 가 res.json 보다 **앞**이어야 의미가 있다
  const awaitIdx = src.indexOf("await _observeDegrade('popular-stale')");
  const jsonIdx = src.indexOf('res.json({ results: stale, stale: true })');
  assert.ok(awaitIdx >= 0 && jsonIdx >= 0 && awaitIdx < jsonIdx,
    `await 가 응답(res.json)보다 뒤에 있다 — await ${awaitIdx} vs json ${jsonIdx}`);

  // 4) Redis 미설정(로컬)에서도 절대 reject 하지 않는다 — 관측이 응답을 막으면 안 된다.
  await ret;

  // 5) 두 소비처가 **같은 Redis 키**를 쓴다(검색·보고서). 갈리면 health 에서 한쪽이 사라진다.
  const { KEY_PREFIX } = require('../services/degradeStats');
  assert.equal(KEY_PREFIX, 'searchdeg:',
    '강등 키 접두어가 바뀌었다 — /api/health 의 searchDegrade 배선과 함께 확인할 것');
  assert.match(src, /require\('\.\.\/services\/degradeStats'\)/,
    'search.js 가 공유 모듈을 쓰지 않는다 — 사본이 다시 갈린다');
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
//   [실측 영향 범위] ⚠ 최초에 "전수 대조 결과 **정확히 1곳**(부산 강서구)" 이라고 적었는데
//   **그 주장이 거짓이었다.** 실제로는 2곳이다 — 부산 강서구(26440, SEOUL_GU_KW 의 '강서' 부분일치)와
//   **서울 중구(11140)**. 중구는 강서구를 고친 뒤 반대 방향으로 갈려(취득세 중과 누락) 남아 있었다.
//   증상은 같은 상세 모달에서 LTV "70%(비규제)" · 세금 조정지역 중과 · 특약 "규제지역 6개월 전입"이
//   **동시에** 표시되는 모순이었다.
//   ★ 교훈: 그때 계약 테스트는 **초록이었는데 프로덕션이 갈렸다** — 케이스를 손으로 골라 중구를
//   빠뜨렸기 때문이다. 그래서 아래 서울 전수 테스트는 케이스를 `LAWD_CODES` 에서 **파생**시킨다.
//   "손으로 고른 목록"으로 영향 범위를 단정하지 말 것.
//
//   [해소됨 2026-08-16] 이전 주석은 "서울이 규제 해제되면 두 함수가 다시 갈린다 — 운영자 판단으로
//   보고했다" 로 끝났는데, 그건 계획 018·022 에서 **이미 해결됐다**: 두 함수 모두 스냅샷의
//   `seoulRegulated` 를 따르고, 아래 '서울 규제 해제 시나리오' 테스트가 그 축을 고정한다.
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

// ────────────────────────────────────────────────────────────────────────────
// Sprint MMMMMMM (2026-08-17) — 서울 전수조사 4회차에서 **실측으로 확정된** 두 결함의 계약.
//   두 결함 모두 "코드가 던지지도, 로그를 남기지도 않는" 조용한 종류라 테스트로만 지킬 수 있다.
// ────────────────────────────────────────────────────────────────────────────

const { buildFacility } = require('../utils/buildFacility');

test('buildFacility — 세대수 원천 2개가 20% 이상 어긋나면 householdsConflict 로 드러난다', () => {
  // [실측 근거] 서울 apt_master 중 kaptdaCnt·hoCnt 가 둘 다 0이 아니면서 서로 다른 단지 207곳.
  //   상대차 분포: 5%미만 157 / 5~20% 26 / 20~50% 16 / 50%이상 8.
  //   20% 임계는 이 분포에서 뽑았다 — 20% 미만은 관리세대수와 호수의 정상적 차이다.
  const mk = (da, ho) => buildFacility({ kaptdaCnt: String(da), hoCnt: String(ho) }, 'A1', null);

  // ① 아스테리움용산 실값 — 128 vs 338 (62.1%). 이 단지가 '주차여유' 태그를 받고 있었다.
  const conflict = mk(128, 338);
  assert.deepEqual(conflict.householdsConflict, { kaptdaCnt: 128, hoCnt: 338, used: 'kaptdaCnt' });
  assert.equal(conflict.totalHouseholds, 128, '표시값 규칙(kaptdaCnt 우선)은 바뀌지 않아야 한다');

  // ② 대치풍림아이원 1.2단지 실값 — 19 vs 90 (78.9%). 5개동에 19세대는 성립하지 않는다.
  assert.ok(mk(19, 90).householdsConflict, '78.9% 차이가 감지되지 않는다');

  // ③ 반대 방향도 같은 규칙 — 방원예뜨랑 실값(121 vs 3). hoCnt 가 틀린 케이스다.
  assert.ok(mk(121, 3).householdsConflict, 'hoCnt 쪽이 틀린 경우도 불일치로 잡아야 한다');

  // ④ 임계 미만은 **평소 경로** — null 이어야 하고, 여기가 깨지면 정상 단지 대부분이 오탐된다.
  //    롯데캐슬클라시아 실값(2033 vs 2029, 0.2%) — 건축물대장은 hoCnt 손을 들었지만 차이는 무시 가능.
  assert.equal(mk(2033, 2029).householdsConflict, null);
  assert.equal(mk(100, 81).householdsConflict, null, '19% 는 임계 미만이다');
  assert.ok(mk(100, 80).householdsConflict, '정확히 20% 는 임계 이상이다');

  // ⑤ 한쪽만 존재하면 비교 자체가 성립하지 않는다 → null (기존 hoCnt fallback 은 그대로 동작)
  assert.equal(mk(0, 1540).householdsConflict, null);
  assert.equal(mk(1540, 0).householdsConflict, null);
  assert.equal(buildFacility({ kaptdaCnt: '0', hoCnt: '1540' }, 'A1', null).totalHouseholds, 1540,
    'HH-HOCNT-FALLBACK(위례래미안이편한세상 [VERIFIED]) 이 깨졌다');
});

test('주차 필터 — 세대수 불일치 단지는 minParkingRatio 조건에서 빠진다 (소스 계약)', () => {
  // 단위 테스트로는 못 잡는 종류다(필터가 DB·KAPT 응답에 얽혀 있다) → 배선의 **형태**를 고정한다.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');
  const guard = src.indexOf('if (fMinPark > 0 && fac.householdsConflict) return false;');
  const ratio = src.indexOf('if (fMinPark > 0 && !(fac.parkingRatio != null && fac.parkingRatio >= fMinPark)) return false;');
  assert.ok(guard > 0, '세대수 불일치 가드가 사라졌다 — 분모를 못 믿는 단지가 "주차 여유"로 추천된다');
  assert.ok(ratio > 0, '주차 비율 필터 자체가 사라졌다');
  assert.ok(guard < ratio, '가드가 비율 검사보다 뒤에 있다 — 순서가 바뀌어도 결과는 같지만 의도가 흐려진다');
});

test('지도 마커 — 좌표가 같은 단지는 세로로 쌓여 서로를 가리지 않는다', () => {
  // [실측 근거] 라이브 DOM: 올림픽선수기자촌 1·2·3단지가 x=546.8/548.3/546.8, y=172.8(폭 83~86px)
  //   → 98% 포개져 하나만 클릭 가능했다. 전국 209그룹·450단지 중 241단지가 가려져 있었다.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const grab = (re, what) => {
    const m = html.match(re);
    assert.ok(m, `frontend/index.html 에서 ${what} 을 찾지 못했다`);
    return m[0];
  };
  const stepSrc = grab(/const _MK_STACK_STEP = \d+;/, '_MK_STACK_STEP');
  const fnSrc = grab(/function _assignMarkerStack\(list\)[\s\S]*?\n\}/, '_assignMarkerStack');
  const styleSrc = grab(/function _mkStackStyle\(p\)[\s\S]*?\n\}/, '_mkStackStyle');
  const { _assignMarkerStack, _mkStackStyle, _MK_STACK_STEP } = new Function(
    `${stepSrc}\n${fnSrc}\n${styleSrc}\nreturn { _assignMarkerStack, _mkStackStyle, _MK_STACK_STEP };`)();

  // ① 겹친 3단지 — 서로 다른 dy 를 받고, 간격은 라벨 높이(26px)보다 커야 겹치지 않는다
  const same = [
    { aptName: '올림픽선수기자촌3단지', lat: 37.5145538, lng: 127.1352531 },
    { aptName: '올림픽선수기자촌1단지', lat: 37.5145538, lng: 127.1352531 },
    { aptName: '올림픽선수기자촌2단지', lat: 37.5145538, lng: 127.1352531 },
  ];
  _assignMarkerStack(same);
  const dys = same.map(p => p._stackDy);
  assert.equal(new Set(dys).size, 3, '같은 좌표 3개가 서로 다른 오프셋을 받지 못했다 — 여전히 포개진다');
  assert.ok(_MK_STACK_STEP > 26, '간격이 라벨 높이(실측 26.3px)보다 작으면 쌓아도 겹친다');
  // 정렬은 단지명 오름차순 — 렌더마다 순서가 흔들리면 같은 마커를 다시 찾을 수 없다
  const byName = [...same].sort((a, b) => a._stackDy - b._stackDy).map(p => p.aptName);
  assert.deepEqual(byName, ['올림픽선수기자촌3단지', '올림픽선수기자촌2단지', '올림픽선수기자촌1단지'],
    'dy 가 단지명 오름차순으로 부여되지 않았다(1단지가 맨 아래여야 한다)');

  // ② 겹치지 않는 마커는 오프셋 0 · style 없음 → 기존 마크업과 픽셀 단위로 동일(회귀 0)
  const solo = [{ aptName: '반포자이', lat: 37.5075936, lng: 127.0131932 },
                { aptName: '은마', lat: 37.4974184, lng: 127.0653274 }];
  _assignMarkerStack(solo);
  assert.deepEqual(solo.map(p => p._stackDy), [0, 0]);
  assert.equal(_mkStackStyle(solo[0]), '', '겹치지 않는 마커에 style 이 붙으면 안 된다');
  assert.match(_mkStackStyle(same.find(p => p._stackDy !== 0)), /^ style="--mkdy:-\d+px"$/);

  // ③ 재렌더(필터 변경) 시 초기화 — 안 하면 오프셋이 누적돼 마커가 화면 밖으로 날아간다
  _assignMarkerStack([same[0]]);
  assert.equal(same[0]._stackDy, 0, '그룹이 1개로 줄었는데 이전 오프셋이 남았다');

  // ④ 좌표 없는 항목이 섞여도 죽지 않는다 (검색 결과엔 좌표 미해결 단지가 실제로 섞인다)
  assert.doesNotThrow(() => _assignMarkerStack([null, { aptName: 'x' }, { aptName: 'y', lat: 1, lng: null }]));

  // ⑤ 마커 HTML 두 경로(Naver·Leaflet fallback)가 모두 이 style 을 실제로 쓰는지 — 배선 계약
  const pinTags = html.match(/<div class="nmap-pin \$\{cls\}\}?"?[^>]*/g) || [];
  const wired = (html.match(/class="nmap-pin \$\{cls\}"\$\{_mkStackStyle\(p\)\}/g) || []).length;
  assert.equal(wired, 2, `_mkStackStyle 배선이 ${wired}곳이다 — Naver·Leaflet 두 경로 모두여야 한다`);
  assert.ok(pinTags.length >= 2);

  // ⑥ CSS 가 --mkdy 를 실제로 반영하는지 (변수만 넣고 transform 을 안 고치면 아무 일도 안 일어난다)
  assert.match(html, /\.nmap-pin\{[^}]*translate\(-50%,calc\(-100% \+ var\(--mkdy,0px\)\)\)/);
  assert.match(html, /\.nmap-pin:hover\{[^}]*translate\(-50%,calc\(-100% \+ var\(--mkdy,0px\)\)\) scale/);
});

test('geocode 단건 호출 3경로가 모두 sigungu·umdNm 을 넘긴다 (배선 계약)', () => {
  // [근본 원인] 백엔드 kakaoGeocode 의 검증 3종(sigungu 주소 하드필터 · 동명 구 umd 하드필터 ·
  //   umdMatch +2)은 전부 `if (sgg && ...)` 조건부다. 프론트가 area 문자열만 넘기면 **전부 꺼지고**
  //   점수 0 동점 → `score > bestScore` 라 Kakao 관련도 1순위(상가·교차로)가 그대로 채택된다.
  //   실호출 실측: '반포자이'→"반포자이플라자", '은마'→"은마아파트입구교차로", '헬리오시티'→"…상가".
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  // /geocode 와 /geocode/batch 호출의 body 를 전부 뽑아 하나도 빠짐없이 검사한다
  //   (한 곳만 고치고 나머지를 놓치는 것이 이 저장소의 반복 실패 모드였다).
  const calls = [...html.matchAll(/\$\{CFG\.api\}\/geocode(?:\/batch)?`[\s\S]{0,420}?JSON\.stringify\(\{[\s\S]{0,300}?\}\)/g)]
    .map(m => m[0]);
  assert.ok(calls.length >= 3, `geocode 호출을 ${calls.length}곳만 찾았다 — 형태가 바뀌었다면 이 테스트도 갱신할 것`);
  for (const c of calls) {
    assert.match(c, /sigungu\s*:/, `sigungu 를 안 넘기는 geocode 호출이 있다:\n${c.slice(0, 160)}`);
    assert.match(c, /umdNm\s*:/, `umdNm 을 안 넘기는 geocode 호출이 있다:\n${c.slice(0, 160)}`);
  }
});

test('부속시설 키워드가 세 판정 경로에 모두 반영돼 있다 (드리프트 방지)', () => {
  // 같은 개념이 3곳에 흩어져 있고 과거에 실제로 갈렸다(GEO-VALIDATE-SSOT 주석의 ca9fcf7 이력).
  //   ① geocodeCacheService.NON_APT_PATTERNS — 지오코딩 후보 점수(-5)
  //   ② geocacheBackfill.REHEAL_NONRES_KEYWORDS — 기존 캐시 재지오코딩 대상 판정
  //   ③ routes/search.js SUBFEATURE_RE — in-bounds 대표좌표 선택 시 강등
  const fs = require('node:fs');
  const path = require('node:path');
  const { NON_APT_PATTERNS } = require('../services/geocodeCacheService');
  const backfillSrc = fs.readFileSync(path.join(__dirname, '../jobs/geocacheBackfill.js'), 'utf8');
  const searchSrc = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  const subM = searchSrc.match(/const SUBFEATURE_RE = \/[^/]+\//);
  assert.ok(subM, 'search.js 에서 SUBFEATURE_RE 를 찾지 못했다');

  // 전국 실측 규모: 경로당/노인정 298건 · 교차로 9건. 단지명 사용례는 apt_master·molit 모두 0건.
  // 5회차 추가분 — 단지명 사용례 apt_master·molit 모두 0건 실측(출구7·다이소5·복지관3·주민센터1·치과1·기공소1)
  for (const kw of ['경로당', '노인정', '교차로', '주민센터', '복지관', '다이소', '출구', '치과', '기공소']) {
    assert.ok(NON_APT_PATTERNS.test(kw), `NON_APT_PATTERNS 에 '${kw}' 가 없다 — 지오코딩이 그 지점을 고른다`);
    assert.ok(backfillSrc.includes(`'${kw}'`), `REHEAL_NONRES_KEYWORDS 에 '${kw}' 가 없다 — 기존 298건이 안 고쳐진다`);
    assert.ok(subM[0].includes(kw), `SUBFEATURE_RE 에 '${kw}' 가 없다 — 지도 대표좌표로 뽑힌다`);
  }
  // 기존 항목이 사라지지 않았는지도 함께 고정 (넓히다 지우는 사고 방지)
  for (const kw of ['충전소', '주차장', '관리사무소', '경비실', '놀이터']) {
    assert.ok(NON_APT_PATTERNS.test(kw), `NON_APT_PATTERNS 에서 기존 '${kw}' 가 사라졌다`);
    assert.ok(subM[0].includes(kw), `SUBFEATURE_RE 에서 기존 '${kw}' 가 사라졌다`);
  }
  // '플라자'는 의도적으로 넣지 않았다 — 주상복합 실명에 쓰여 오탐 위험이 있다.
  assert.equal(NON_APT_PATTERNS.test('플라자'), false,
    "'플라자'가 NON_APT_PATTERNS 에 들어갔다 — 주상복합 단지명 오탐 위험. 넣으려면 단지명 실측부터 할 것");
  // '프라자' 도 같은 이유로 금지 — 단지명 실측 master 13건·molit 261건.
  assert.equal(NON_APT_PATTERNS.test('프라자'), false,
    "'프라자'는 단지명으로 261건 쓰인다 — 넣으면 진짜 단지를 비주거로 오판한다");
  // '입구' 도 금지 — "서울대입구" 오탐. ('출구'는 지하철 출구 전용이라 위 목록에 들어가 있다.)
  assert.equal(NON_APT_PATTERNS.test('서울대입구'), false,
    "'입구'가 들어가면 '서울대입구'가 비주거로 걸린다");
});

test('세대당 주차 판정 5곳이 모두 세대수 불일치 가드를 거친다 (사본 드리프트 방지)', () => {
  // [배경] 같은 지표가 이미 5곳에서 판단에 쓰이고 있었다 — 태그 2곳(프론트 단지정보·백엔드 추천카드),
  //   점수 가산 1곳, 보고서 등급 보너스 1곳, 보고서 '장점' 문장 1곳. 여기에 필터가 하나 더 있다.
  //   이 저장소는 "사본 하나만 고치고 나머지가 갈리는" 사고를 여러 번 겪었으므로 전부 묶는다.
  const fs = require('node:fs');
  const path = require('node:path');
  const p = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const svc = p('../services/propertyService.js');
  const rep = p('../routes/report.js');
  const html = p('../../frontend/index.html');

  // 판정은 한 곳(householdsConflictOf)에서만 나온다 — 임계값을 복사한 자리가 있으면 안 된다
  const { householdsConflictOf, HH_CONFLICT_THRESHOLD } = require('../utils/buildFacility');
  assert.equal(HH_CONFLICT_THRESHOLD, 0.2);
  assert.ok(householdsConflictOf(128, 338), '아스테리움용산 실값(62%)이 불일치로 안 잡힌다');
  assert.equal(householdsConflictOf(2033, 2029), null, '0.2% 차이가 불일치로 잡히면 정상 단지가 오탐된다');
  assert.equal(householdsConflictOf(0, 1540), null, '한쪽만 있으면 비교 불가 → null');
  assert.equal(householdsConflictOf('abc', 100), null, '숫자가 아니면 null (KAPT 원천은 문자열이다)');
  assert.ok(rep.includes("require('../utils/buildFacility')"),
    '보고서가 판정을 따로 구현했다 — 임계값이 갈리면 같은 단지가 화면마다 다르게 나온다');

  // ① 점수 가산 ② 추천카드 태그 ③ 주차 필터 — propertyService
  assert.match(svc, /const pr = facility\?\.householdsConflict \? 0 : \(facility\?\.parkingRatio \|\| 0\)/,
    '점수 가산(+4)이 불일치 단지에도 붙는다');
  assert.match(svc, /parkingRatio >= 1\.2 && !facility\?\.householdsConflict/,
    '추천카드 주차여유 태그에 가드가 없다');
  assert.ok(svc.includes('if (fMinPark > 0 && fac.householdsConflict) return false;'),
    '주차 필터에 가드가 없다');

  // ④ 보고서 등급 보너스 ⑤ 보고서 장점 문장
  assert.match(rep, /function getParkingBonus\(parkingTotal, households, householdsConflict\)/,
    'getParkingBonus 가 불일치 여부를 받지 않는다');
  assert.match(rep, /if \(householdsConflict\) return \{ ratio: \(p \/ h\)\.toFixed\(2\), bonus: 0, uncertain: true \}/,
    '불일치인데 보너스(최대 12점)가 그대로 붙는다');
  assert.match(rep, /getParkingBonus\(c\.kaptInfo\?\.parking, c\.households, c\.householdsConflict\)/,
    '호출부가 불일치 값을 안 넘긴다 — 함수만 고치고 배선을 놓친 상태다');
  assert.match(rep, /parking_per_household >= 1 && !f\.parking_uncertain/,
    "보고서 '장점' 문장에 가드가 없다");
  assert.match(rep, /parking_uncertain: parking\.uncertain \|\| false/,
    'objectiveFacts 에 parking_uncertain 이 실리지 않는다 — 위 pros 가드가 항상 통과한다');

  // ⑥ 프론트 단지정보 태그
  assert.match(html, /f\.parkingRatio >= 1\.2 && !f\.householdsConflict/,
    '프론트 단지정보 주차여유 태그에 가드가 없다');
});

test('절대 규칙 — 화면·프롬프트가 추천/예측/대출알선을 하지 않는다 (Sprint MMMMMMM-4)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const ai = fs.readFileSync(path.join(__dirname, '../services/aiService.js'), 'utf8');
  const clause = fs.readFileSync(path.join(__dirname, '../routes/clause.js'), 'utf8');

  // ① 미래 사건 확률 — AI 가 지어낸 "발생 가능성 35%" 가 필터를 우회해 화면에 뜨고 있었다.
  //    (aiOutputFilter 의 CLAUSE_FILTER_FIELDS 는 risks.probability 를 의도적으로 제외한다.)
  //   ★ 주석은 검사 대상이 아니다 — clause.js:161 은 2026-07-15 에 POST /risk 를 지우며
  //     "'발생 가능성 %' 등 예측성 서술 요구(절대룰 저촉 소지)" 라고 **문제를 이미 기록해 둔** 줄이다.
  //     그때 죽은 라우트만 지우고 **살아있는 /clause 프롬프트의 같은 문제는 남겨뒀다** — 그 잔여분이
  //     이번에 제거됐다. 기록은 보존하고, 실제 스키마 키만 본다.
  assert.equal(/"probability"/.test(clause), false,
    'clause 프롬프트가 다시 AI 에게 확률을 요구한다 — 근거 없는 수치가 화면에 뜬다');
  assert.equal(/class="rcard-p">\$\{_escHtml\(r\.probability/.test(html), false,
    '리스크 카드가 다시 probability 를 렌더한다');

  // ② 대출 알선 — aiService 규칙 5 가 "대출 알선·소개 금지"인데 같은 프롬프트가 이를 어기고 있었다.
  assert.ok(/대출 알선·소개 금지/.test(ai), '대출 알선 금지 규칙 자체가 사라졌다');
  assert.equal(/신협·수협 특판/.test(ai), false,
    '프롬프트가 특정 금융기관 특판 금리를 다시 싣는다 — 화면 disclaimer "대출 알선 X" 와 충돌');
  assert.equal(/대출상담사 활용 권장/.test(ai), false, '프롬프트가 대출상담사를 다시 권한다');
  assert.equal(/상호금융권\(DSR 50%\) 사전 상담/.test(html), false,
    '규칙기반 특약 폴백이 특정 금융업권 상담을 다시 유도한다');

  // ③ 단지 등급 판정 — 규칙 10(특정 단지 평가 금지)과 절대 룰 ①에 어긋나던 지시문
  assert.equal(/3% 이상: 양호, 5% 이상: 우수/.test(ai), false,
    '프롬프트가 다시 단지에 등급을 매긴다');
  assert.equal(/하방 지지력/.test(ai), false,
    '프롬프트가 다시 미래 가격 방어력을 단정한다');

  // ④ 랜딩 첫 화면의 가짜 실측값 — API 실패 시 하드코딩 단지가 '실시간' 딱지를 달고 남았다
  assert.equal(/id="lv-aptName">헬리오시티/.test(html), false,
    '랜딩 카드에 하드코딩 단지명이 되돌아왔다 — 실패 시 가짜 시세가 실시간으로 보인다');
  assert.equal(/id="lv-aptPrice">\d/.test(html), false, '랜딩 카드에 하드코딩 가격이 되돌아왔다');
  assert.match(html, /id="lv-aptMeta">불러오는 중</, '초기 라벨이 플레이스홀더가 아니다');
  assert.match(html, /_set\('lv-aptMeta', '실시간'\)/, "'실시간' 라벨을 응답 수신 후에 달지 않는다");
});

test('공유링크 거래 건수 — 같은 6개월 응답을 3번 합산하지 않는다 (Sprint MMMMMMM-4)', () => {
  // 백엔드는 aptName 이 있으면 dealYm 을 무시하고 6개월치 전량을 준다
  //   (routes/transactions.js:35-37 → transactionService.getTransactionsByApt(…, monthsBack = 6)).
  //   프론트가 3개월을 각각 호출해 합치면 **정확히 3배**가 된다 — 공유링크 "최근 6개월 실거래 N건",
  //   관심단지 "새 거래 N건" 이 전부 부풀어 있었다.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const svc = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');

  // 전제 고정 — 이 시그니처가 바뀌면 위 판단의 근거가 사라진다
  assert.match(svc, /async function getTransactionsByApt\(lawdCd, aptName, monthsBack = 6\)/,
    'getTransactionsByApt 시그니처가 바뀌었다 — 6개월 전량 반환 전제를 다시 확인할 것');

  const m = html.match(/async function fetchRecentTx\(lawdCd, aptName\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'fetchRecentTx 를 찾지 못했다');
  const fn = m[0];
  assert.match(fn, /if\(aptName\)\{/, 'aptName 단축 경로가 없다 — 3배 합산이 되돌아왔다');
  // 단축 경로 안에서는 prevYm 을 한 번만 쓴다(월 3회 루프로 되돌아가지 않았는지)
  const short = fn.slice(fn.indexOf('if(aptName){'), fn.indexOf('const months='));
  assert.equal((short.match(/prevYm\(/g) || []).length, 1,
    'aptName 경로가 다시 여러 달을 호출한다');
  assert.equal(/aptName\]/.test(short) || /aptName,\s*$/.test(short), false);
});

test('기간·금리 표기가 실제와 일치한다 (Sprint MMMMMMM-5)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const ana = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  const tx = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');

  // ① 가격 위치 백분위 — 표본은 6개월인데 표기는 1년이었다.
  //    전제: percentile 은 calcPricePercentile(filteredTx)로 계산되고 그 원천이 monthsBack=6 이다.
  assert.match(tx, /async function getTransactionsByAptInclAliases\(lawdCd, aptName, monthsBack = 6\)/,
    '표본 기간 전제가 바뀌었다 — 표기도 함께 다시 판단할 것');
  assert.match(ana, /calcPricePercentile\(filteredTx/, '백분위 입력이 filteredTx 가 아니다');
  for (const bad of ['최근 1년 하위', '최근 1년 상위', '가격 위치 (최근 1년']) {
    assert.equal(ana.includes(bad) || html.includes(bad), false,
      `"${bad}" 표기가 되돌아왔다 — 실제 표본은 6개월이다`);
  }
  assert.match(ana, /최근 6개월 하위 \$\{percentile\}%/);
  assert.match(html, /가격 위치 \(최근 6개월 거래 대비\)/);

  // ② 정책자금 금리 — 계산 패널이 비교표와 다른 값을 쓰고 있었다(계산 패널은 갱신 대상 밖).
  assert.match(html, /window\._hfRates = hf;/, 'HF 공시값을 공유하지 않는다');
  assert.match(html, /function _polRate\(key, fallback\)/, '_polRate 헬퍼가 없다');
  assert.match(html, /rate: _polRate\('didimdol', '2\.85~4\.15%'\)/, '디딤돌 금리가 공시값과 연결되지 않았다');
  assert.match(html, /rate: _polRate\('bogeum', '4\.9~5\.3%'\)/, '보금자리론 금리가 공시값과 연결되지 않았다');
  // stale 값이 되살아나지 않았는지 (한도 '3.6~4.2억' 은 금리가 아니므로 % 로 한정해 검사)
  assert.equal(/rate: '3\.6~4\.2%'/.test(html), false, '보금자리론에 stale 금리가 되돌아왔다');
  assert.equal(/rate: '2\.0~3\.3%'/.test(html), false, '디딤돌에 stale 금리가 되돌아왔다');
  // HF API 가 없는 두 상품은 하드코딩이 정상 — 실수로 _polRate 에 묶이지 않았는지
  assert.match(html, /name: '신혼 디딤돌'[\s\S]{0,250}rate: '1\.8~3\.1%'/);
  assert.match(html, /name: '신생아 특례'[\s\S]{0,250}rate: '1\.6~3\.3%'/);
});

test('보고서 일괄 관심추가가 정식 북마크 형태를 만든다 (Sprint MMMMMMM-6)', () => {
  // 알림 대상 필터는 lawdCd 가 5자리 숫자인 북마크만 통과시킨다. 일괄 추가가 그 필드를 안 넣으면
  // "N단지 관심 추가 완료" 토스트만 뜨고 **알림에서는 조용히 빠진다**.
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const rep = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');

  // 전제 ①: 보고서 응답이 식별 필드를 실제로 내려준다
  for (const f of ['aptName: c.apt_name', 'sigungu: c.sigungu', 'umdNm: c.umd_nm', 'lawdCd: c.lawd_cd']) {
    assert.ok(rep.includes(f), `보고서 apartments 에 ${f} 가 없다 — 일괄 추가가 쓸 소스가 사라졌다`);
  }
  // 전제 ②: 알림 대상 필터가 lawdCd 5자리를 요구한다
  assert.ok(html.includes('.test(x.lawdCd)') && html.includes('slice(0,30)'),
    '알림 대상 필터 형태가 바뀌었다 — 아래 판단 근거를 다시 확인할 것');

  const m = html.match(/function _addAllReportAptsToBookmarks\(\)[\s\S]*?\n\}/);
  assert.ok(m, '_addAllReportAptsToBookmarks 를 찾지 못했다');
  const fn = m[0];
  for (const need of ['lawdCd: a.lawdCd', 'sigungu: a.sigungu', 'umdNm: a.umdNm', 'savedAt: Date.now()']) {
    assert.ok(fn.includes(need), `일괄 추가가 ${need} 를 넣지 않는다`);
  }
  assert.equal(/aptName: a\.name\b/.test(fn), false, 'aptName 에 표시용 문자열이 되돌아왔다');
  assert.equal(/areaPyeong \+ '평'/.test(fn), false, "area 에 평형이 되돌아왔다 — 규제 판정이 area 를 지역으로 읽는다");
  assert.equal(/addedAt:/.test(fn), false, '타임스탬프 키가 정식(savedAt)과 다르다');
  assert.equal(/localStorage\.setItem\('mhl_bookmarks'/.test(fn), false,
    'saveBookmarks() 를 건너뛰고 localStorage 를 직접 쓴다');
  assert.ok(fn.includes('saveBookmarks(bks)'), '정식 저장 헬퍼를 쓰지 않는다');

  // 평형 칩 라벨 — '전체'/'34평+' 가 실제 조회 범위를 숨기고 있었다
  assert.match(html, /전체\(15~60평\)/, "'전체' 칩이 실제 범위를 밝히지 않는다");
  assert.match(html, /대형 34~60평/, "'대형 34평+' 가 상한을 숨긴다");
  const py = html.match(/function pyRange\(\)\{[\s\S]*?\n\}/);
  assert.ok(py && py[0].includes('{minArea:15,maxArea:60}'), 'pyRange 전체 분기가 바뀌었다 — 라벨도 함께 볼 것');
  assert.ok(py[0].includes('{minArea:34,maxArea:60}'), 'pyRange 대형 분기가 바뀌었다');
});

test('매칭 0건 안내가 단지 건수로 세어지지 않는다 + 진행 문구가 실제와 맞다 (Sprint MMMMMMM-7)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const svc = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① 안내 항목은 단지가 아니다 — 예전엔 표식이 없어 '추천 단지 1건' 으로 세어졌다
  const fb = svc.match(/function getStaticFallback\(budget, region\)[\s\S]*?\n\}/);
  assert.ok(fb, 'getStaticFallback 을 찾지 못했다');
  assert.ok(fb[0].includes('_notice: true'), '안내 항목에 식별 플래그가 없다 — 단지 건수로 세어진다');
  assert.ok(html.includes("props.filter(p=>!p._notice).length"), '프론트가 안내 항목을 건수에서 빼지 않는다');
  assert.equal(html.includes("textContent=props.length+'건'"), false,
    '건수에 안내 항목이 다시 포함된다');

  // ② 추천 경로에 LLM 호출이 없다 — 문구가 'AI 분석' 이면 거짓 서술이 된다
  for (const k of ['callAI', 'anthropic', 'openai']) {
    assert.equal(svc.includes(k), false,
      `propertyService 에 ${k} 가 생겼다 — LLM 을 쓴다면 진행 문구도 다시 판단할 것`);
  }
  assert.ok(html.includes("searchStep('조건 매칭·점수 계산 중...', 3)"), '진행 문구가 사실과 다르다');
  assert.equal(html.includes("searchStep('AI 분석·점수 계산 중...', 3)"), false,
    '추천 진행 문구에 AI 표현이 되돌아왔다');
});

test('인기 단지 범례·학군 칩이 실제 동작을 숨기지 않는다 (Sprint MMMMMMM-8)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const pop = fs.readFileSync(path.join(__dirname, '../services/popularService.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../services/chatDataRouter.js'), 'utf8');
  const svc = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① 인기 단지 — 세 가지가 범례에 없었다: 21일 게이트 / 캡이 하드캡 아님 / 좌표 없으면 탈락.
  //    전제(설계)가 그대로인지 먼저 고정한다 — 바뀌면 문구도 다시 판단해야 한다.
  assert.ok(pop.includes('21 * 24 * 60 * 60 * 1000'), '21일 게이트가 사라졌다');
  assert.ok(pop.includes('top = capped.concat(overflow)'), '캡 초과분 재투입 구조가 바뀌었다');
  assert.ok(pop.includes('if (c && c.lat && c.lng) out.push'), '좌표 없는 단지 탈락 구조가 바뀌었다');
  // 문구 3곳이 '최대 2곳' 을 단정하지 않는다
  for (const [label, src] of [['프론트', html], ['챗봇', chat]]) {
    assert.equal(src.includes('시군구당 최대 2곳'), false,
      `${label} 문구가 하드캡을 단정한다 — 실제로는 자리가 남으면 초과분도 채운다`);
  }
  assert.ok(html.includes('최근 21일 거래 단지 우선'), '21일 게이트가 안내되지 않는다');
  assert.ok(chat.includes('최근 21일 거래 단지 우선'), '챗봇 안내에 21일 게이트가 없다');
  assert.ok(html.includes('좌표 확인된 단지'), '좌표 없는 단지 탈락이 안내되지 않는다');

  // ② 학군 중요도 칩 — 검색 결과에는 무영향이고 보고서에만 반영된다
  assert.equal(svc.includes('schoolNeeded'), false,
    'propertyService 가 schoolNeeded 를 쓰기 시작했다면 칩 안내를 다시 판단할 것');
  assert.ok(html.includes('(보고서 반영)'), '학군 칩이 반영 범위를 밝히지 않는다 — 죽은 입력으로 보인다');
});

test('시세 "평균"·노후 배지가 실제 계산 기준을 밝힌다 (Sprint MMMMMMM-9)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const tx = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');

  // ① 시세는 단순평균이 아니라 반감기 90일 가중평균이다 — 화면의 거래 목록으로 재현되지 않는다.
  //    설계 전제를 함께 고정: 이 계산이 단순평균으로 바뀌면 라벨도 되돌려야 한다.
  assert.ok(tx.includes('function _weightedMean'), '_weightedMean 이 사라졌다 — 라벨 근거를 다시 볼 것');
  assert.ok(tx.includes('Math.exp(-daysAgo / 90)'), '가중치 반감기가 바뀌었다');
  assert.ok(html.includes('최근 6개월 실거래 가중평균'), '평형별 시세 라벨이 가중평균임을 밝히지 않는다');
  assert.ok(html.includes('6개월 가중평균(최근 거래 가중)'), '추천 카드 가격 기준 라벨이 부정확하다');

  // ② 노후 기준이 화면마다 다르다 — 배지 25년 / 리스크 30년. 배지에 기준을 밝혀 혼선을 없앤다.
  assert.ok(html.includes("tags.push('🏚 노후 25년+')"), '노후 배지가 기준 연수를 밝히지 않는다');
  assert.ok(html.includes('age != null && age >= 30'), '리스크 탭의 30년 기준이 바뀌었다 — 배지 표기도 함께 볼 것');
});

test('평↔㎡ 환산 계수가 저장소 전체에서 하나다 (Sprint MMMMMMM-10)', () => {
  // 정확값 1평 = 3.305785㎡. 예전엔 3.3(어림)과 3.3058 이 섞여 있었다.
  // 실측: 20~250㎡ 전 구간 반올림 불일치 7.2%, 다만 대표 평형(59.82·84.92·114.97·134.9·164.9)은 전부 동일.
  const fs = require('node:fs');
  const path = require('node:path');
  const files = ['../routes/report.js', '../services/analysisService.js', '../services/transactionService.js',
                 '../../frontend/index.html'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    // 어림값이 나눗셈에 다시 쓰이면 실패 — 주석·문서의 '3.3' 은 잡지 않도록 나눗셈 형태만 본다
    assert.equal(src.includes('/ 3.3)'), false, `${f} 에 어림 계수 나눗셈이 되돌아왔다`);
    assert.equal(src.includes('/ 3.3;'), false, `${f} 에 어림 계수 나눗셈이 되돌아왔다`);
    assert.equal(src.includes('/3.3)'), false, `${f} 에 어림 계수 나눗셈이 되돌아왔다`);
  }
  // 정확 계수가 실제로 쓰이고 있는지(전부 지워지는 사고 방지)
  const ana = fs.readFileSync(path.join(__dirname, '../services/analysisService.js'), 'utf8');
  assert.ok(ana.includes('_PYEONG_M2 = 3.3058'), '기준 상수가 사라졌다');
  assert.ok(ana.includes('/ 3.3058'), 'analysisService 가 정확 계수를 쓰지 않는다');
});

test('표본·범위 표기가 실제 집계와 맞다 (Sprint MMMMMMM-11)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const svc = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');
  const txs = fs.readFileSync(path.join(__dirname, '../services/transactionService.js'), 'utf8');
  const kakao = fs.readFileSync(path.join(__dirname, '../services/kakaoService.js'), 'utf8');

  // ① totalTxAnalyzed 는 거래 건수가 아니라 **단지 개수**다.
  //    전제: analyzeTransactions 가 단지별로 묶어서 배열을 돌려준다.
  assert.ok(txs.includes('function analyzeTransactions'), 'analyzeTransactions 가 사라졌다');
  assert.ok(txs.includes('const byApt = {}'), '단지별 그룹화 구조가 바뀌었다 — 표기 근거를 다시 볼 것');
  assert.ok(svc.includes('totalTxAnalyzed: analyzed.length'), '집계 소스가 바뀌었다');
  assert.ok(html.includes('거래가 있는 단지'), '건수/단지수 표기가 되돌아왔다');
  assert.equal(html.includes('실거래 ${(Number(searchMeta.totalTx)||0).toLocaleString()}건 분석'), false,
    "'N건 분석' 표기가 되돌아왔다 — N 은 단지 수다");

  // ② 주변시설 반경은 항목마다 다르다 (편의점 500 ~ 종합병원 2000)
  for (const r of ['500', '1200', '1500', '2000']) {
    assert.ok(kakao.includes(r), `kakaoService 의 반경 ${r} 이 사라졌다 — 표기를 다시 판단할 것`);
  }
  assert.ok(html.includes('항목별 500m~2km'), '주변시설 반경 표기가 실제와 다르다');
  assert.equal(html.includes('주변 (반경 800m~1km)'), false, '단일 반경 표기가 되돌아왔다');

  // ③ 층 분포는 전량이 아니라 화면에 불러온 표본 기준이다
  assert.ok(html.includes('최근 6개월 MOLIT · 표본 기준'), '층 분포가 전량 집계처럼 표기된다');
});

// ── CRON-STALE-2026-08-17 (Sprint MMMMMMM-12) ─────────────────────────────────
// [실측 배경] 2026-08-16 에 geocache-backfill(04:00) · building-register-backfill(06:00) ·
//   retention(18:00) 의 실행 기록이 통째로 비었는데 **Sentry 의 cron 오류도 0건**이었다.
//   즉 실패한 게 아니라 안 돈 것인데, 그걸 알아차릴 수단이 하나도 없었다.
//   원인 두 갈래를 모두 코드에서 확인했고 여기서 형태로 고정한다.
test('cron 실행 기록이 성공·실패 양쪽에 남는다 + await 로 유실을 막는다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/cron.js'), 'utf8');
  const { CRON_PATH_TO_JOBS, CRON_MAX_AGE_H } = require('../services/cronStats');

  // ① 모든 cron 잡이 **실패 경로에서도** 기록을 남긴다.
  //   종전엔 실패 기록이 단 한 곳도 없었다(popular-snapshot 만 try 안에서 ok:false 를 남겼다).
  //   그래서 기록이 빈 cron 을 두고 "미실행 vs 실패" 를 구별할 수 없었다.
  const jobsWithOwnThrowPath = Object.values(CRON_PATH_TO_JOBS).flat()
    .filter(j => j !== 'popular-snapshot'); // popular-snapshot 은 자기 라우트가 없다(retention 안에서 계산)
  for (const job of jobsWithOwnThrowPath) {
    assert.ok(src.includes(`recordCronRun('${job}', { ok: false`),
      `'${job}' 의 catch 에 실패 기록이 없다 — 실패하면 health.crons 에 흔적이 사라진다`);
  }

  // ② 모든 recordCronRun 이 await 된다.
  //   ⚠ 이 저장소는 같은 실수를 이미 겪었다 — `_observeDegrade` 를 await 안 하면 서버리스가
  //     응답 후 함수를 동결하면서 Redis 쓰기가 잘린다(커밋 ba1db07). cron 기록도 같은 경로다.
  //     await 없이 두면 cron 은 정상인데 기록만 사라지는, 가장 헷갈리는 상태가 만들어진다.
  const total = (src.match(/\.recordCronRun\(/g) || []).length;
  const awaited = (src.match(/await require\('\.\.\/services\/cronStats'\)\.recordCronRun\(/g) || []).length;
  assert.ok(total > 0, 'recordCronRun 호출을 하나도 못 찾았다 — 이 테스트의 전제가 깨졌다');
  assert.equal(awaited, total,
    `recordCronRun ${total}개 중 ${awaited}개만 await 된다 — 안 된 것은 서버리스 동결로 유실된다`);

  // ③ 미실행 감시가 retention **쌍둥이 양쪽**에 걸려 있다.
  //   이 저장소는 쌍둥이 한쪽만 고쳐 사고가 난 이력이 여러 번 있다(GET-PARITY·SENTRY-GAP 주석).
  const iPost = src.indexOf("router.post('/retention'");
  const iGet = src.indexOf("router.get('/retention'");
  const iMolit = src.indexOf('async function handleMolitIngest');
  assert.ok(iPost >= 0 && iGet > iPost && iMolit > iGet, 'retention 쌍둥이 구조를 못 찾았다');
  for (const [name, part] of [['POST', src.slice(iPost, iGet)], ['GET', src.slice(iGet, iMolit)]]) {
    assert.match(part, /await checkCronStaleness\(\)/, `retention ${name} 에 cron 미실행 감시가 없다`);
    assert.ok(part.includes("recordCronRun('retention'"), `retention ${name} 이 자기 실행을 기록하지 않는다`);
    // Sprint MMMMMMM-22: 지역 단위 적재 중단 감시도 쌍둥이 양쪽에 있어야 한다.
    //   실제로 Vercel cron 이 호출하는 쪽이 GET 이었던 전례가 있다(GET-PARITY 주석) — 한쪽만 넣으면 감시가 안 돈다.
    assert.match(part, /await checkRegionIngestFreshness\(\)/, `retention ${name} 에 지역 적재 중단 감시가 없다`);
  }

  // ④ 감시 대상 목록이 vercel.json 과 1:1 이다 — 새 cron 이 감시에서 조용히 빠지는 것을 막는다.
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '../../vercel.json'), 'utf8'));
  const declared = [...new Set(vercel.crons.map(c => c.path.split('?')[0]))].sort();
  assert.deepEqual(declared, Object.keys(CRON_PATH_TO_JOBS).sort(),
    'vercel.json 의 cron 경로와 CRON_PATH_TO_JOBS 가 어긋났다 — 새 cron 을 감시 대상에 넣을 것');
  assert.deepEqual(
    [...new Set(Object.values(CRON_PATH_TO_JOBS).flat())].sort(),
    Object.keys(CRON_MAX_AGE_H).sort(),
    'CRON_MAX_AGE_H 에 기대 주기가 없는 잡이 있다(또는 없는 잡이 남아 있다)');

  // ⑤ push-notify 주석의 시각이 실제 스케줄과 맞는다 (2026-08-17 까지 '18:20 UTC' 로 어긋나 있었다)
  const pn = vercel.crons.find(c => c.path === '/api/cron/push-notify');
  assert.equal(pn.schedule, '30 22 * * *', 'push-notify 스케줄이 바뀌었다 — 주석도 함께 고칠 것');
  assert.equal(src.includes('18:20 UTC'), false, 'push-notify 주석이 실제 스케줄(22:30 UTC)과 다르다');
});

test('findStaleCrons — 기대 주기 초과만 경보, 기록 없음은 침묵', () => {
  const { findStaleCrons } = require('../services/cronStats');
  const now = Date.parse('2026-08-17T00:00:00Z');
  const { stale, never } = findStaleCrons({
    'geocache-backfill': { at: '2026-08-16T04:00:00Z' },  // 20h — 정상
    'facility-backfill': { at: '2026-08-14T05:00:00Z' },  // 67h — 일간 기준(50h) 초과
    'apt-master-sync': { at: '2026-08-11T20:00:00Z' },    // 124h — 주간 기준(240h) 안이라 정상
    'audit-prune': { at: null },                          // 값이 깨진 기록 → 판단 불가
  }, now);

  assert.deepEqual(stale.map(s => s.job), ['facility-backfill'],
    '주기 초과 판정이 바뀌었다 — 일간 50h / 주간 240h 전제를 확인할 것');
  assert.equal(stale[0].ageH, 67);
  // ⚠ "기록 없음" 은 경보로 올리지 않는다 — 이 기능 배포 직후엔 아직 한 번도 안 돈 잡이 정상적으로
  //   여기 들어오기 때문이다(오탐). 진단용으로만 함께 싣는다.
  assert.ok(never.includes('audit-prune'), 'at 이 깨진 기록은 never 로 분류돼야 한다');
  assert.ok(never.includes('push-notify'), '기록이 아예 없는 잡은 never 로 분류돼야 한다');
  assert.equal(stale.some(s => s.job === 'audit-prune'), false, '판단 불가를 경보로 올리면 안 된다');

  // Redis 미설정(null) 이어도 던지지 않는다 — 감시가 cron 본체를 막아선 안 된다.
  assert.deepEqual(findStaleCrons(null, now).stale, []);
});

// ── REGION-FRESHNESS-2026-08-17 (Sprint MMMMMMM-22) ───────────────────────────
// 이 저장소는 **지역 단위** 적재 중단으로 두 번 사고를 냈다(광주 44일 · 인천 45일).
// 둘 다 HTTP 200 · 0건이라 status='ok' 였고, 전역 신선도 감시(MAX(ingested_at) 하나)로는
// 원리적으로 보이지 않는다. 판정을 실행해서 고정한다 — 형태 검사로는 경계값(> vs >=)을 못 잡는다.
test('pickStaleRegions — 30일 초과만 경보 · 폐지 코드 제외 · 이력 없음은 침묵', () => {
  const { pickStaleRegions, REGION_STALE_DAYS } = require('../services/cronStats');
  const now = Date.parse('2026-08-17T05:00:00Z');
  const retired = new Set(['28110', '28140', '28260']);

  const { stale, never } = pickStaleRegions({
    '11680': '2026-08-14',   // 3일 — 정상
    '41290': '2026-07-28',   // 20일 — 실측상 가장 오래된 **정상** 지역(과천). 경보가 나면 안 된다
    '29110': '2026-07-04',   // 44일 — 광주 사고 재현. 반드시 잡혀야 한다
    '28260': '2026-06-24',   // 54일이지만 **폐지 코드** → 제외
    '28720': null,           // 거래 이력 자체가 없음(옹진군) → never, 경보 아님
  }, retired, now);

  const codes = stale.map(s => s.lawdCd);
  assert.deepEqual(codes, ['29110'], `경보 대상이 정확히 광주 1곳이어야 한다: ${JSON.stringify(stale)}`);
  assert.equal(stale[0].days, 44, '경과일 계산이 어긋난다');
  assert.equal(stale[0].lastDealDate, '2026-07-04');
  assert.deepEqual(never, ['28720'], '이력 없는 지역은 never 로만 분류돼야 한다');

  // 경계값 — 임계와 정확히 같은 날은 경보가 아니고, 하루 더 지나면 경보다(> 인지 >= 인지 고정).
  const at = (days) => new Date(now - days * 86400000).toISOString().slice(0, 10);
  assert.equal(pickStaleRegions({ '11680': at(REGION_STALE_DAYS) }, retired, now).stale.length, 0,
    `${REGION_STALE_DAYS}일 정확히는 경보 대상이 아니어야 한다`);
  assert.equal(pickStaleRegions({ '11680': at(REGION_STALE_DAYS + 1) }, retired, now).stale.length, 1,
    `${REGION_STALE_DAYS + 1}일은 경보 대상이어야 한다`);

  // 서버 런타임 TZ 는 UTC 다 — 로컬(한국)에서만 통과하는 계산이 되면 안 된다(TZ 사고 이력).
  assert.equal(pickStaleRegions({ '11680': '2026-07-04' }, retired, now).stale[0].days, 44);

  // 빈 입력·retired 미전달에도 던지지 않는다 — 감시가 cron 본체를 막아선 안 된다.
  assert.deepEqual(pickStaleRegions(null, null, now).stale, []);
  assert.deepEqual(pickStaleRegions({}, undefined, now).never, []);
});

test('RETIRED_LAWD_CODES — 감시에서만 빼고 LAWD_CODES 에는 남아 있어야 한다', () => {
  const { LAWD_CODES, LAWD_CODE_TO_NAME, RETIRED_LAWD_CODES } = require('../services/transactionService');
  const all = new Set(Object.values(LAWD_CODES));
  for (const code of RETIRED_LAWD_CODES) {
    // ⚠ 지우면 적재된 인천 옛 구 거래의 지역명 매핑과 지역 대시보드가 깨진다(transactionService 주석).
    assert.ok(all.has(code), `폐지 코드 ${code} 를 LAWD_CODES 에서 지우면 안 된다 — 감시 제외만 하는 것이다`);
    assert.ok(LAWD_CODE_TO_NAME[code], `폐지 코드 ${code} 의 지역명 매핑이 사라졌다`);
  }
  // 폐지 목록이 전체를 삼키면 감시가 통째로 꺼진다 — 그런 실수를 막는다.
  assert.ok(RETIRED_LAWD_CODES.size > 0 && RETIRED_LAWD_CODES.size < all.size / 4,
    `폐지 목록이 비정상적으로 크다: ${RETIRED_LAWD_CODES.size}/${all.size}`);
});

// ── POOL-COVERAGE-2026-08-17 (Sprint MMMMMMM-13) ──────────────────────────────
// [실측 배경] 보고서 후보 풀 상한 2,500 이 광역 보고서를 조용히 "최근 2개월"짜리로 만들고 있었다.
//   서울 광역·평형 전체·매수가 10억 기준: 밴드 내 180일 행수 11,983 → 풀이 실제로 덮는 시작일이
//   2026-06-19(59일). 적격 단지(n>=2) **1,329곳 → 508곳**, 즉 **821곳(62%)이 후보에 못 들어왔다.**
//   n 은 표시용이 아니라 TRUST-GATE(n>=2)와 점수의 입력이라 라벨 수정으로는 못 덮는다.
test('보고서 후보 풀 — 상한·시간예산·잘림 표기가 실제 커버리지를 따른다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');

  // ① 상한이 서울 광역 최대 밴드(11,983행)를 덮는다. 낮추면 62% 탈락이 되살아난다.
  const m = src.match(/POOL_MAX\s*=\s*(\d+)/);
  assert.ok(m, 'report.js 에서 POOL_MAX 를 찾지 못했다');
  assert.ok(Number(m[1]) >= 12000,
    `POOL_MAX 가 ${m[1]} 이다 — 서울 광역 밴드 실측 최대 11,983행을 못 덮으면 후보가 조용히 탈락한다`);

  // ② 시간 예산이 있고, **왕복 실측을 덮을 만큼** 크다.
  //    [실측 — Supabase edge_logs `response.origin_time`, molit_transactions]
  //      1,000행 페이지 평균 935ms(최대 3,967) · 2페이지째 평균 1,076ms → 12페이지 순차 ≈ 11~12초.
  //    ⚠ 처음엔 8s 로 잡았다가 이 실측에서 뒤집혔다 — 8s 면 7~8페이지에서 끊겨
  //      "12,000 이면 전량 커버" 가 성립하지 않는다. 예산을 낮추려면 왕복부터 다시 재라.
  const bm = src.match(/POOL_BUDGET_MS\s*=\s*(\d+)/);
  assert.ok(bm, '후보 풀 페이징에 시간 예산이 없다');
  assert.ok(Number(bm[1]) >= 20000,
    `POOL_BUDGET_MS 가 ${bm[1]}ms 다 — 12페이지 순차 실측(≈11~12초)을 못 덮으면 상한 12,000 이 무의미하다`);

  // ②-b 잘림이 **얼마나 자주** 일어나는지 관측된다(Hobby 로그는 1시간이면 사라진다).
  assert.match(src, /await require\('\.\.\/services\/degradeStats'\)\.observeDegrade\('report-pool-cut'\)/,
    '풀 절단이 카운터로 남지 않는다 — 예산·병렬화를 데이터가 아니라 추측으로 정하게 된다');

  // ③ "다 가져왔는가" 를 별도 플래그로 판정하고, 그 결과가 후보에 실려 나간다.
  //    (행수만 보고 판단하면 "정확히 상한만큼 있는 경우"와 "잘린 경우"를 구별 못 한다.)
  assert.match(src, /poolComplete\s*=\s*true/, '전량 확보 판정 플래그가 없다');
  assert.match(src, /_poolTruncated:\s*poolTruncated/, '후보에 잘림 여부가 실리지 않는다');
  assert.match(src, /_poolFrom:\s*poolFromDate/, '후보에 실제 커버 시작일이 실리지 않는다');

  // ④ 페이지마다 **새 빌더**를 만든다 — supabase-js 빌더는 mutable 이라 한 인스턴스를 병렬로 쓰면
  //    .range() 가 서로를 덮어 같은 구간을 여러 번 읽거나 빠뜨린다(조용한 데이터 손상).
  assert.match(src, /const _newPageQuery = \(\) =>/, '페이지 쿼리 팩토리가 없다 — 병렬 요청이 서로를 덮는다');
  assert.equal(/_newPageQuery\(\)\.range\(/.test(src), true, '페이징이 팩토리로 만든 새 빌더를 쓰지 않는다');
  // 지역 판정은 **적용 함수**로만 담긴다(빌더를 직접 mutate 하면 팩토리가 무의미해진다).
  assert.match(src, /let _regionOp = null;/, '지역 필터가 적용 함수로 분리돼 있지 않다');
  assert.equal(/\bq = q\.(in|like)\(/.test(src), false,
    '지역 분기가 아직 빌더를 직접 mutate 한다 — 페이지 병렬 요청과 양립하지 않는다');
  // 동시성 상한이 있다 — 재보지 않은 부담을 떠안지 않는다.
  const cm = src.match(/POOL_CONCURRENCY\s*=\s*(\d+)/);
  assert.ok(cm && Number(cm[1]) >= 2 && Number(cm[1]) <= 8,
    `POOL_CONCURRENCY 가 ${cm && cm[1]} 이다 — 2~8 범위를 벗어나면 왕복 부담을 다시 실측할 것`);
  // ④-c ⚠ **첫 페이지는 단독**이어야 한다. 프로덕션 DB 실측에서 0번부터 4개를 동시에 던지면
  //     콜드 경합으로 **4개 전부 statement timeout**(4,177ms)이 났다. 한 번 워밍하면 4개 병렬이 167ms.
  //     statement_timeout 은 service_role 도 무제한이 아니다(authenticator 의 8s 를 물려받는다).
  assert.match(src, /첫 페이지 단독 — 콜드 경합 방지/, '첫 페이지 단독 워밍 단계가 사라졌다');
  const loopStart = src.match(/for \(let from = (\w+); from < POOL_MAX && !poolComplete;/);
  assert.ok(loopStart && loopStart[1] === 'PAGE',
    `병렬 루프가 ${loopStart && loopStart[1]} 부터 시작한다 — 0 부터면 첫 배치가 콜드 경합에 노출된다`);
  // 2차 정렬키 — 병렬이라 페이지 경계의 동점 처리가 더 중요해졌다.
  assert.match(src, /\.order\('id', \{ ascending: false \}\)/, '2차 정렬키(id)가 없다 — 페이지 경계에서 중복·누락이 생긴다');

  // ④-b 검색·보고서가 **같은 강등 모듈**을 쓴다(2026-08-17 통합 완료 — 종전엔 같은 코드가 두 벌이었다).
  //     키가 갈리면 /api/health 의 searchDegrade 에서 한쪽이 조용히 사라진다.
  const searchSrc = fs.readFileSync(path.join(__dirname, '../routes/search.js'), 'utf8');
  assert.match(searchSrc, /require\('\.\.\/services\/degradeStats'\)/,
    'search.js 가 공유 강등 모듈을 쓰지 않는다 — 사본이 갈리면 관측이 반쪽이 된다');

  // ⑤ '표본 적음(시세 판단 주의)' 는 잘린 풀에서 **거짓 경고**가 되므로 가드를 거친다.
  //    반대로 '거래 활발'(n>=20)은 잘려도 하한 보장이라 가드가 없어야 정상이다.
  assert.match(src, /!c\._poolTruncated && c\.n <= 5/,
    "'표본 적음' 판정이 잘림 가드를 안 거친다 — 실제로 거래 많은 단지에 없는 위험을 붙인다");
});

test('poolSpanLabel — 잘리지 않으면 6개월, 잘리면 실제 커버 일수', () => {
  const poolSpanLabel = _reportFn('poolSpanLabel');
  assert.equal(poolSpanLabel({ _poolTruncated: false, _poolFrom: '2026-06-19' }), '최근 6개월');
  assert.equal(poolSpanLabel({}), '최근 6개월');
  assert.equal(poolSpanLabel(null), '최근 6개월');
  // 잘린 경우 — 오늘로부터의 일수. 값 자체가 아니라 **형태**를 고정한다(테스트가 날짜에 안 묶이게).
  const out = poolSpanLabel({ _poolTruncated: true, _poolFrom: '2026-06-19' });
  assert.match(out, /^최근 \d+일$/, `잘린 풀인데 '${out}' 로 나온다 — 6개월이라고 말하면 거짓 서술이다`);
  // _poolFrom 이 없으면 판단 불가 → 억지로 추정하지 않고 기본 문구로 돌아간다.
  assert.equal(poolSpanLabel({ _poolTruncated: true }), '최근 6개월');
});

// ── MARKET-SAMPLE-2026-08-17 (Sprint MMMMMMM-13) ──────────────────────────────
// [실측 배경] AI 도우미 시세 답변이 이름 부분일치 전체를 `.limit(400)` 최신순으로 긁어 그 안에서
//   그룹핑했다. 6개월 매칭 행수는 "자이" 6,117건(289그룹)·"푸르지오" 7,057건(351그룹) — 400행은 6.5%.
//   그래서 단지 선택도, 그 단지의 "거래 N건 · 단순평균"도 잘린 조각에서 나왔다.
//   ("은마"는 233건이라 상한에 닿은 적이 없다 — 라이브 점검에서 안 보인 이유.)
test('AI 도우미 시세 — 단지 선택과 통계 계산이 분리돼 있다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../services/chatDataRouter.js'), 'utf8');

  // ① 후보 단지는 단지 단위 집계 MV 에서 고른다(거래 테이블 전체 긁기 아님).
  assert.match(src, /molit_apt_index/, '단지 후보를 MV 에서 고르지 않는다 — 절단이 되살아난다');

  // ② 통계는 **고른 단지 하나**로 좁혀 조회한다. eq(apt_name) 이 없으면 다시 전체를 긁는 것이다.
  assert.match(src, /\.eq\('apt_name',\s*c\.aptName\)/,
    '거래 조회가 단지 하나로 좁혀지지 않는다');

  // ③ 세 등급 조회는 서로 포함관계라 같은 MV 행이 중복으로 온다 — 행 고유키로 걸러야 한다.
  //    안 걸러내면 deal_count 가 2~3배로 부풀어 순위가 뒤집힌다.
  assert.match(src, /seenRow/, 'MV 행 중복 제거가 없다 — deal_count 가 부풀어 순위가 뒤집힌다');
  assert.match(src, /rowKey\s*=\s*`\$\{r\.apt_name\}\|\$\{r\.lawd_cd\}/,
    '중복 제거 키가 MV 행 고유키(이름|법정동코드|시군구|읍면동|준공년)가 아니다');

  // ④ MV 의 deal_count 는 **전 기간** 누적이다 — 6개월 건수와 같은 줄에 놓으면 사용자가 비교한다.
  //    "다른 단지도 있어요" 목록에 건수를 붙이지 않는 것이 이 커밋의 결정이다.
  const others = src.match(/같은 이름의 다른 단지도 있어요[\s\S]{0,200}/);
  assert.ok(others, '동명 단지 안내 문구를 찾지 못했다');
  assert.equal(/\$\{[^}]*dealCount[^}]*\}건/.test(others[0]), false,
    '동명 단지 목록에 전 기간 deal_count 를 "건" 으로 붙였다 — 위의 6개월 건수와 기준이 다르다');

  // ⑤ 상한에 닿으면 그 사실을 숨기지 않는다(조용한 절단 재발 방지).
  assert.match(src, /txs\.length >= TX_CAP/, '단지 단위 조회의 상한 도달을 표기하지 않는다');
});

// ── 출처 없는 단정·수치 제거 (Sprint MMMMMMM-13) ──────────────────────────────
// 절대 룰 ②는 "공식 출처만 인용 + 출처·검증일자 명시"다. 아래 세 자리는 그 룰을 어기고 있었다.
// ⚠ 이 테스트는 **금지 문자열**을 검사하므로, 소스 주석에 옛 문구를 그대로 인용하면 안 된다
//   (이 저장소에서 실제로 두 번 재발한 함정이다 — 설명은 하되 원문은 적지 말 것).
test('출처 없는 단정·수치가 화면에 없다 (청약 커트라인·신용대출 금리·권유 단어)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

  // ① 청약 가점 — 당락 단정 + 근거 없는 커트라인 점수.
  //    커트라인은 단지·공급유형·평형마다 다르고 공고 후 확정된다. 인용할 공시값이 없다.
  assert.equal(html.includes('안정권'), false, '청약 가점에 당락 단정 표현이 남아 있다');
  assert.equal(/커트라인\s*평균/.test(html), false, '근거 없는 커트라인 평균 점수가 남아 있다');
  assert.equal(html.includes('65~70점'), false, '하드코딩된 커트라인 점수 범위가 남아 있다');
  //    대신 공식 확인처 안내는 반드시 남아 있어야 한다(정보를 지우기만 하면 안 된다).
  assert.ok(html.includes('applyhome.co.kr'), '청약Home 안내가 사라졌다 — 확인 경로는 남겨야 한다');

  // ② 신용대출·마이너스통장 금리 — 출처도 기준시점도 없던 수치.
  assert.equal(/평균 금리 6%대/.test(html), false, '출처 없는 신용대출 금리 수치가 남아 있다');
  assert.equal(/변동 금리 7~8%/.test(html), false, '출처 없는 마이너스통장 금리 수치가 남아 있다');
  assert.ok(html.includes('거래 은행에서 직접 확인'), '금리 확인 경로 안내가 없다');

  // ③ 검색 결과 섹션 제목이 권유 단어를 쓰지 않는다 — 보고서 프롬프트의 금지와 말을 맞춘다.
  assert.equal(html.includes('<span class="st">추천 단지</span>'), false,
    '검색 결과 섹션 제목이 여전히 권유 단어다 (절대 룰 ① · report.js 프롬프트 금지와 모순)');
  assert.ok(html.includes('<span class="st">조건 맞는 단지</span>'), '섹션 제목이 바뀌지 않았다');

  // ④ 보고서 프롬프트 쪽 금지 지시가 살아 있는지도 함께 고정 — 한쪽만 남으면 다시 갈린다.
  const rep = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');
  assert.ok(rep.includes('조건 부합 단지'), 'report.js 프롬프트의 대체 표현 지시가 사라졌다');

  // ⑤ 정책 블록의 출처 표기가 정직하다 — 자동 갱신되는 것(LTV·DSR)과 코드에 고정된 것
  //    (규제지역·토허 범위)을 구분해 말해야 한다. 전부를 "자동 인용" 이라 부르면 출처를 오도한다.
  assert.equal(/본 정보는 정부 공시 자동 인용/.test(rep), false,
    '하드코딩된 규제 범위까지 "자동 인용" 이라고 말한다 — 절대 룰 ②(출처 명시) 위반');
  assert.match(rep, /LTV·DSR 은 정부 공시 스냅샷에서 자동 인용/,
    '무엇이 자동이고 무엇이 고정인지 구분하는 문구가 사라졌다');
});

test('단지 카드 — 기간 라벨은 서버 값을 쓰고, 세대당 주차에는 총량이 함께 붙는다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  const rep = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');

  // ① 서버가 기간 라벨을 내려보낸다. 프론트가 자기 문자열로 다시 만들면 잘림 표기가 조용히 갈린다
  //    (백엔드는 잘렸을 때 '최근 N일' 로 낮추는데 카드만 6개월이라고 우기는 상태가 실제로 있었다).
  assert.match(rep, /sampleSpan:\s*_span/, 'report 응답에 기간 라벨(sampleSpan)이 없다');
  assert.match(html, /a\.sampleSpan\s*\|\|/, '카드가 서버의 기간 라벨을 쓰지 않는다 — 사본이 갈린다');
  assert.equal(/신고가 <b>6개월 /.test(html), false, '카드가 아직 기간을 하드코딩한다');

  // ② 세대당 주차는 **비율**이다 — 분모(총 주차대수)가 데이터에 있는데 카드에만 빠져 있었다.
  //    report.js:948 이 parking_total 을 이미 싣고 있으므로 새 조회 없이 붙일 수 있다.
  assert.match(rep, /parking_total:/, 'objectiveFacts 에 총 주차대수가 없다');
  assert.match(html, /f\.parking_total\?`\s*\(총 /, '카드의 세대당 주차에 총량이 안 붙는다');

  // ③ 세대수 불일치로 분모를 못 믿는 경우 카드에서도 그 사실을 밝힌다(상세 표와 동일 처리).
  assert.match(html, /f\.parking_uncertain\?/, '카드가 세대수 불일치를 표시하지 않는다');
});

// ── NO-UNDEF-2026-08-17 (Sprint MMMMMMM-14) ───────────────────────────────────
// 같은 날 **매달린 참조**를 두 건 잡았다. 둘 다 문법은 합법이라 `node --check` 와 `vm.Script` 로는
// 원리적으로 못 잡고, 실행해 봐야만 드러난다:
//   ① chatDataRouter._market 이 교체 후 옛 변수를 계속 참조 → 시세 답변이 라이브에서 죽었다.
//   ② backend/routes/kakao.js 가 SSOT 리팩터링(acfd032)에서 선언만 지워진 상수를 계속 참조
//      → 카카오 알림 OAuth 의 state 서명이 무증상으로 죽어 있었다.
// 이 테스트는 규칙이 조용히 꺼지는 것을 막는다(끄면 같은 사고가 다시 통과한다).
test('eslint 에 no-undef 가 켜져 있다 (매달린 참조 차단)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const cfg = fs.readFileSync(path.join(__dirname, '../../eslint.config.mjs'), 'utf8');
  const blocks = cfg.split('rules:').slice(1);
  assert.ok(blocks.length >= 2, 'eslint 설정의 rules 블록을 2개(백엔드·인라인) 찾지 못했다');
  for (const [i, b] of blocks.entries()) {
    assert.match(b, /'no-undef':\s*'error'/,
      `rules 블록 #${i + 1} 에 no-undef 가 없다 — 한쪽만 켜면 다른 쪽 매달린 참조가 그대로 통과한다`);
  }
  // 리팩터링이 지운 그 상수가 실제로 복구돼 있는지도 함께 못 박는다(재발 시 여기서 먼저 걸린다).
  const kakao = fs.readFileSync(path.join(__dirname, '../routes/kakao.js'), 'utf8');
  assert.match(kakao, /const SERVICE_KEY = process\.env\.SUPABASE_SERVICE_ROLE_KEY/,
    'kakao.js 의 state HMAC 파생 키 선언이 다시 사라졌다 — OAuth state 서명이 죽는다');
});

// ── REGION-SCOPE-2026-08-17 (Sprint MMMMMMM-16) ───────────────────────────────
// [실측 배경] 프론트가 보내는 지역 문자열은 닫힌 집합이다(`${wide} ${sub}`, wide 4종 · sub 52종).
//   그 56개를 보고서의 지역 분기에 전부 넣어 돌린 결과 **21개가 광역 전체로 샜다**:
//     · 경기 16개 전부 → 경기 44코드   · 인천 5개 → 인천 14코드   · '지방' 미선택 → **전국(필터 없음)**
//   원인은 분기가 `[가-힣]+구` 로 '구'가 붙은 이름만 좁힐 수 있다는 것 —
//   경기·인천 칩은 '과천'·'분당'·'남동'처럼 '구'가 없다.
//   화면 안내는 "선택 시 **그 지역만** 분석" 이라 52개 중 21개가 그 말과 달랐다.
// ⚠ 이 테스트는 **프론트의 칩 목록을 직접 읽어** 검사한다. 칩을 새로 추가했는데 백엔드가
//   해석 못 하면 여기서 잡힌다 — 사람이 케이스를 손으로 고르면 반드시 빠뜨린다(중구 사고).
test('지역 세부 칩 전부가 광역보다 좁게 해석된다 (프론트 칩 목록 기준 전수)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  // REGION-MENU-2026-08-30: 칩 목록은 이제 `/api/region/menu`(LAWD_CODES 파생)에서 온다.
  //   index.html 에 남은 표는 **네트워크 실패 시 폴백**이다 — 그것도 여전히 해석돼야 하므로 같이 검사한다.
  const m = html.match(/const REGION_SUB_FALLBACK = (\{[\s\S]*?\});/);
  assert.ok(m, 'index.html 에서 REGION_SUB_FALLBACK 을 찾지 못했다 (칩 목록 형태가 바뀌었다면 이 테스트도 갱신할 것)');
  const REGION_SUB = new Function(`return ${m[1]}`)();
  assert.deepEqual(Object.keys(REGION_SUB).sort(), ['경기', '서울', '인천', '지방'],
    '광역 칩 구성이 바뀌었다 — report.js 의 광역 분기도 함께 확인할 것');

  const { pickRegions } = require('../services/propertyService');
  const WIDE_PFX = { '서울': '11', '경기': '41', '인천': '28' };
  // 광역 전체 코드 수 — 이 수에 도달하면 "좁히지 못하고 광역으로 샌 것" 이다.
  const { LAWD_CODES } = require('../services/transactionService');
  const wideCount = (pfx) => Object.values(LAWD_CODES).filter(c => String(c).startsWith(pfx)).length;

  // 예산에 따라 pickRegions 의 폴백 분기가 달라지므로 여러 예산으로 함께 본다.
  for (const budget of [4, 6, 8, 10, 15, 25]) {
    for (const [wide, subs] of Object.entries(REGION_SUB)) {
      for (const sub of subs) {
        const region = `${wide} ${sub}`;
        const picked = pickRegions(region, budget, '') || [];
        const codes = [...new Set(picked.map(p => p.lawdCd))];
        assert.ok(codes.length, `'${region}'(예산 ${budget}) 이 아무 지역으로도 해석되지 않는다`);
        // ⚠ 코드 개수만 보면 부족하다 — 매핑에 없는 칩은 **광역 대표 몇 개 구**로 폴백되어
        //   개수·접두 검사를 그대로 통과한다(실측: '인천 테스트동' → 28185·28200·28237·28245).
        //   판별자는 name 이다. 매핑에 걸리면 매칭 키워드가, 못 걸리면 **광역 이름**이 온다.
        const names = picked.map(p => p.name);
        assert.ok(!names.some(n => ['서울', '경기', '인천', '지방'].includes(n)),
          `'${region}'(예산 ${budget}) 이 매핑에 없어 광역 대표 구로 폴백된다 — ` +
          `REGION_KEYWORDS 에 이 칩의 매핑을 추가할 것 (현재 name=${names.join('/')})`);
        const pfx = WIDE_PFX[wide];
        if (pfx) {
          assert.ok(codes.every(c => String(c).startsWith(pfx)),
            `'${region}'(예산 ${budget}) 이 다른 광역 코드로 해석된다: ${codes.join(',')}`);
          assert.ok(codes.length < wideCount(pfx),
            `'${region}'(예산 ${budget}) 이 광역 전체(${wideCount(pfx)}개)로 샌다 — "그 지역만 분석" 안내와 다르다`);
        } else {
          // '지방' 은 여러 시도가 섞이므로 "수도권 코드가 아닐 것" 으로 본다.
          assert.ok(codes.every(c => !['11', '41', '28'].includes(String(c).slice(0, 2))),
            `'${region}'(예산 ${budget}) 이 수도권 코드로 해석된다: ${codes.join(',')}`);
        }
      }
    }
  }
});

test('보고서 지역 분기 — 검증된 매핑을 재사용하고 광역 폴백에 지방이 있다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/report.js'), 'utf8');

  // ① 별도 표를 새로 만들지 않고 propertyService 의 매핑을 재사용한다(세 번째 사본 방지).
  assert.match(src, /require\('\.\.\/services\/propertyService'\)/,
    '보고서가 검증된 지역 매핑을 재사용하지 않는다 — 사본을 새로 만들면 또 갈린다');
  // REGION-CODE-2026-08-30: 4번째 인자로 **시군구 코드**를 넘긴다 — 있으면 문자열 해석을 건너뛴다.
  assert.match(src, /pickRegions\(region, buy, '', _reqLawdCd\)/,
    'pickRegions 재사용 호출이 없다(또는 lawdCd 를 넘기지 않는다)');
  assert.ok(/const _reqLawdCd = \/\^\\d\{5\}\$\/\.test\(String\(input\.lawdCd/.test(src),
    'lawdCd 를 5자리 숫자로 검증하지 않는다 — 임의 코드로 조회가 열린다');

  // ② ⚠ pickRegions 는 매칭 실패 시 **예산 기반 서울 인기 구**를 돌려준다(추천용 폴백).
  //    그게 그대로 새면 "경기 보고서에 서울 단지" 가 된다 → 시도 접두 검증이 반드시 있어야 한다.
  assert.match(src, /codes\.every\(c => String\(c\)\.startsWith\(wantPfx\)\)/,
    '세부 해석 결과의 시도 접두를 검증하지 않는다 — 다른 광역 단지가 섞인다');
  // ②-b 접두만으로는 부족하다. 매핑에 없는 세부는 **광역 대표 구 몇 개**로 폴백되는데 접두는 맞는다.
  //     name 이 광역 이름이면 해석 실패로 보고 광역 분기로 내려가야 한다.
  assert.match(src, /names\.some\(n => \['서울', '경기', '인천', '지방'\]\.includes\(n\)\)/,
    '해석 실패(광역 대표 구 폴백)를 걸러내지 않는다 — 고른 곳과 무관한 구를 조용히 뒤진다');

  // ③ '지방' 광역이 lawd_cd 필터 없이 **전국**으로 새던 분기가 막혀 있다.
  assert.match(src, /region\.includes\('지방'\)/,
    "'지방' 광역 분기가 없다 — 세부 미선택 시 전국이 후보 풀이 된다");
  // 어느 분기에도 안 걸리는 입력은 조용히 넘어가지 말고 흔적을 남긴다.
  assert.match(src, /지역 필터 미적용 — 전국이 후보 풀이 된다/,
    '예상치 못한 지역 문자열이 조용히 전국 조회가 된다');
});

// ── REGION-MENU-2026-08-30 (Sprint OOOOOOO) ───────────────────────────────────
// [무엇이 있었나 — 운영자 발견] "경기는 시 자체도 이상하게 되어 있고, 동탄도 없어."
//   프론트 지역 칩이 **손으로 적은 52개 문자열**이었다. LAWD_CODES 는 122개인데 칩으로
//   도달 가능한 시군구는 pickRegions 전수 계산 결과 **56개뿐** — 적재 실거래 448,508건 중
//   **194,951건(43.5%)이 선택 자체가 불가능**했다(동탄 9,784건 포함).
// [왜 테스트로 묶나] 목록을 손으로 관리하는 한 지역이 늘 때마다 다시 어긋난다. 여기서
//   메뉴가 LAWD_CODES 전수를 덮는지 기계로 확인한다 — 사람이 케이스를 고르면 반드시 빠뜨린다.
test('지역 메뉴가 LAWD_CODES 전수를 덮는다 (도달 불가 시군구 0)', async () => {
  const express = require('express');
  const app = express();
  app.use('/api/region', require('../routes/region'));
  const srv = app.listen(0);
  try {
    const port = srv.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/region/menu`);
    assert.equal(res.status, 200, '지역 메뉴 엔드포인트가 200 이 아니다');
    const j = await res.json();
    const items = (j.groups || []).flatMap(g => g.items || []);

    const { LAWD_CODES, RETIRED_LAWD_CODES } = require('../services/transactionService');
    const want = [...new Set(Object.values(LAWD_CODES).map(String))].filter(c => !RETIRED_LAWD_CODES.has(c));
    const got = new Set(items.map(i => String(i.lawdCd)));
    const missing = want.filter(c => !got.has(c));
    assert.deepEqual(missing, [], `메뉴에서 고를 수 없는 시군구가 있다: ${missing.join(',')}`);

    // 폐지 코드는 **빼야** 한다 — 고르면 신규 거래가 0 인 곳이다.
    const retiredShown = [...got].filter(c => RETIRED_LAWD_CODES.has(c));
    assert.deepEqual(retiredShown, [], `폐지된 시군구가 메뉴에 남아 있다: ${retiredShown.join(',')}`);

    // 라벨 중복은 사용자가 두 칩을 구별할 수 없다는 뜻이다.
    const labels = items.map(i => `${i.label}`);
    assert.equal(new Set(labels).size, labels.length, '지역 라벨이 중복된다 — 사용자가 구별할 수 없다');

    // ⚠ 핵심: 칩이 실어 보내는 lawdCd 가 **그 코드 그대로** 해석돼야 한다.
    //   이름 문자열 경로였다면 동명 구(중구 6곳)에서 갈렸다 — 그 계열의 원천 차단을 여기서 못박는다.
    const { pickRegions } = require('../services/propertyService');
    for (const it of items) {
      const picked = pickRegions('무의미한 문자열', 9, '', it.lawdCd) || [];
      assert.deepEqual(picked.map(x => x.lawdCd), [String(it.lawdCd)],
        `'${it.label}'(${it.lawdCd}) 칩이 다른 코드로 해석된다: ${picked.map(x => x.lawdCd).join(',')}`);
      assert.ok(!['서울', '경기', '인천', '지방'].includes(picked[0].name),
        `'${it.label}'(${it.lawdCd}) 의 name 이 광역 이름이다 — 보고서가 해석 실패로 보고 광역으로 내려간다`);
    }
  } finally { srv.close(); }
});

// ── HH-UNKNOWN-2026-08-17 (Sprint MMMMMMM-19) ─────────────────────────────────
// [실측 배경] 추천의 소형 단지 게이트가 **세대수 미확인(0)을 소형으로 취급**해 407곳(서울 56)을
//   조용히 배제하고 있었다. 코드 주석은 "세대수 **확인된** 100세대 미만 제외 · 미확인(null) 유지"
//   라고 적혀 있었지만, `buildFacility` 는 모를 때 null 이 아니라 **0** 을 넣으므로 그 의도는
//   도달할 수 없었다(`Number.isFinite(0)` = true).
//   그 407곳 중 건축물대장으로 교차확인되는 17곳은 **전부 100세대 이상**(평균 878·최대 2,700),
//   소형은 0곳 — "미확인 = 소형" 전제가 데이터로 반증된다.
test('추천 소형 게이트 — 미확인(0)은 배제하지 않고, 확인된 1~99만 배제한다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../services/propertyService.js'), 'utf8');

  // 판정을 소스에서 뽑아 **직접 실행**한다 — 형태만 보면 경계 실수를 못 잡는다.
  const m = src.match(/const _isKnownSmall = \(r\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(m, 'propertyService 에서 _isKnownSmall 을 찾지 못했다 (형태가 바뀌면 이 테스트도 갱신할 것)');
  const _isKnownSmall = new Function(`${m[0]} return _isKnownSmall;`)();

  const mk = (hh) => ({ facility: hh === undefined ? undefined : { totalHouseholds: hh } });
  // 미확인 계열 — 전부 유지(배제 대상 아님)
  assert.equal(_isKnownSmall(mk(0)), false, '세대수 0(미확인)이 소형으로 배제된다 — 407곳이 사라진 원인');
  assert.equal(_isKnownSmall(mk(null)), false, 'null(미확인)이 배제된다');
  assert.equal(_isKnownSmall(mk(undefined)), false, 'undefined(미확인)가 배제된다');
  assert.equal(_isKnownSmall({}), false, 'facility 자체가 없을 때 배제된다');
  // 확인된 소형 — 배제 (운영자 지시의 실제 대상, 실측 239곳)
  assert.equal(_isKnownSmall(mk(1)), true, '1세대가 소형으로 안 걸린다');
  assert.equal(_isKnownSmall(mk(83)), true, '83세대(YM프라젠 실사례)가 소형으로 안 걸린다');
  assert.equal(_isKnownSmall(mk(99)), true, '99세대가 소형으로 안 걸린다');
  // 경계 — 100 이상은 유지
  assert.equal(_isKnownSmall(mk(100)), false, '100세대가 소형으로 배제된다(경계 오류)');
  assert.equal(_isKnownSmall(mk(2700)), false, '2,700세대가 배제된다');

  // 주석이 실제 동작과 다시 어긋나지 않도록 근거 수치를 함께 고정한다.
  assert.match(src, /미확인이 전부 소형으로 배제/, 'HH-UNKNOWN 근거 주석이 사라졌다');
});

// OAUTH-STATE-2026-08-17 (Sprint MMMMMMM-15): 이 세 함수는 **3개월간 테스트가 0** 이었고,
//   그 사이 매달린 참조로 통째로 죽어 있었는데 아무도 몰랐다. 형태(선언 존재)만 고정하면
//   같은 사고의 다른 형태(예: 키가 undefined 로 계산되어 서명이 항상 같아짐)를 못 잡는다.
//   → 실제로 **실행해서** 서명·검증 왕복과 위조 거부를 확인한다.
test('카카오 OAuth state — 서명·검증 왕복과 위조·만료 거부가 실제로 동작한다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/kakao.js'), 'utf8');
  const pick = (name) => {
    const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    assert.ok(m, `kakao.js 에서 ${name} 을 찾지 못했다 (형태가 바뀌면 이 테스트도 갱신할 것)`);
    return m[0];
  };
  const build = (serviceKey) => new Function('crypto', 'SERVICE_KEY',
    `${pick('stateHmacKey')}\n${pick('signState')}\n${pick('verifyState')}\n` +
    'return { stateHmacKey, signState, verifyState };'
  )(require('node:crypto'), serviceKey);

  const k = build('test-service-key-xxxxxxxx');

  // ① 정상 왕복 — 서명한 payload 가 그대로 돌아온다.
  const payload = { n: 'nonce-1', exp: Date.now() + 60000 };
  const signed = k.signState(payload);
  assert.match(signed, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'state 형식이 data.sig 가 아니다');
  const back = k.verifyState(signed);
  assert.equal(back && back.n, 'nonce-1', '서명한 state 가 검증을 통과하지 못한다 — OAuth 가 죽는다');

  // ② 위조 거부 — 서명부를 바꾸면 통과하면 안 된다(CSRF 방어의 본체).
  const [d, s] = signed.split('.');
  assert.equal(k.verifyState(`${d}.${s.slice(0, -1)}X`), null, '변조된 서명이 통과한다');
  assert.equal(k.verifyState('garbage'), null, '형식이 깨진 값이 통과한다');
  assert.equal(k.verifyState(''), null, '빈 값이 통과한다');

  // ③ 만료 거부.
  assert.equal(k.verifyState(k.signState({ n: 'x', exp: Date.now() - 1 })), null, '만료된 state 가 통과한다');

  // ④ **키가 다르면 검증이 실패해야 한다** — 이게 깨지면 파생 키가 실제로 안 쓰이는 것이다.
  //    (SERVICE_KEY 가 undefined 로 조용히 'no-key' 폴백만 타는 회귀를 여기서 잡는다.)
  const other = build('another-service-key-yyyyyyyy');
  assert.equal(other.verifyState(signed), null,
    '다른 키로 서명한 state 가 통과한다 — 파생 키가 서명에 반영되지 않는다');
});

// ── HH-BR-FALLBACK-2026-08-17 (Sprint MMMMMMM-23) ─────────────────────────────
// 운영자 지시: "미확인은 다시 조사해서 채워넣어야지 뭘 그냥 통과시켜."
// 세대수의 3순위 원천으로 건축물대장을 붙인다. 경계는 셋 — KAPT 우선 / 모를 때만 BR / 그래도 없으면 모름.
test('buildFacility — 세대수는 KAPT 우선, 둘 다 0일 때만 건축물대장, 출처를 함께 낸다', () => {
  const { buildFacility } = require('../utils/buildFacility');
  const br = { hhldCnt: 630, dongCnt: 4, useAprDay: '19911115', source: 'buildingRegister' };

  // (1) KAPT 값이 있으면 BR 이 있어도 절대 덮지 않는다 (교차검증 12건 kaptdaCnt 9:2 우세 — 기본 규칙 유지)
  const kapt = buildFacility({ kaptdaCnt: '1540', hoCnt: '1540', _br: br }, 'A1', null);
  assert.equal(kapt.totalHouseholds, 1540, 'KAPT 값이 건축물대장에 밀렸다');
  assert.equal(kapt.householdsSource, 'kapt');

  // (2-1) kaptdaCnt=0 이어도 hoCnt 가 살아 있으면 그쪽이 먼저다 (HH-HOCNT-FALLBACK 유지)
  const ho = buildFacility({ kaptdaCnt: '0', hoCnt: '1540', _br: br }, 'A2', null);
  assert.equal(ho.totalHouseholds, 1540);
  assert.equal(ho.householdsSource, 'kapt');

  // (2-2) 둘 다 0 → 건축물대장. 실측 대상 12곳이 정확히 이 형태다 (kaptdaCnt "0" · hoCnt "0")
  const brOnly = buildFacility({ kaptdaCnt: '0', hoCnt: '0', _br: br }, 'A3', null);
  assert.equal(brOnly.totalHouseholds, 630, '둘 다 0인데 건축물대장 값이 안 붙었다');
  assert.equal(brOnly.householdsSource, 'buildingRegister');

  // (2-3) KAPT 조회 실패 sentinel 위에도 붙는다 — 실측 모집단 395곳이 이 형태다
  const onEmpty = buildFacility({ _empty: true, _br: br }, 'A4', null);
  assert.equal(onEmpty.totalHouseholds, 630);
  assert.equal(onEmpty.householdsSource, 'buildingRegister');

  // (3) 아무 원천도 없으면 **모름**이다. 0 이 나오되 출처는 null — 이 null 이 "0을 값으로 읽지 말라"는 표시다.
  const none = buildFacility({ kaptdaCnt: '0', hoCnt: '0' }, 'A5', null);
  assert.equal(none.totalHouseholds, 0);
  assert.equal(none.householdsSource, null, '미확인인데 출처가 붙으면 0이 값으로 읽힌다');

  // BR 값이 0/음수/쓰레기면 채택하지 않는다(모름 유지) — 상류가 0을 줄 수 있다
  for (const bad of [0, -1, null, undefined, 'N/A']) {
    const r = buildFacility({ kaptdaCnt: '0', hoCnt: '0', _br: { hhldCnt: bad } }, 'A6', null);
    assert.equal(r.totalHouseholds, 0, '쓸 수 없는 BR 값이 채택됐다: ' + String(bad));
    assert.equal(r.householdsSource, null);
  }

  // 세대당 주차는 세대수를 분모로 쓴다 — BR 로 세대수가 생기면 비율도 함께 성립해야 한다
  const withPark = buildFacility({ kaptdaCnt: '0', hoCnt: '0', _br: br }, 'A7', { kaptdPcnt: '300', kaptdPcntu: '330' });
  assert.equal(withPark.parkingTotal, 630);
  assert.equal(withPark.parkingRatio, 1, '분모(세대수)가 BR 로 채워졌는데 비율이 안 나왔다');
});

test('BR 되쓰기 — 캐시된 세대수만 붙이고 동명·값없음은 건드리지 않는다', async () => {
  const { writeBackToMaster } = require('../jobs/buildingRegisterBackfill');
  const brRows = [
    { apt_key: 'name:지산타운|27260', title: { hhldCnt: 630, dongCnt: 4, useAprDay: '19911115' } },
    { apt_key: 'name:값없음|11110', title: { hhldCnt: 0 } },       // 상류가 0 → 적지 않는다
    { apt_key: 'name:쌍둥이|11140', title: { hhldCnt: 999 } },     // 동명 2행 → 어느 쪽인지 모른다
    { apt_key: 'name:세대수0|11680', title: { hhldCnt: 250, dongCnt: 2 } },
  ];
  const emptyRows = [
    { kapt_code: 'A1', apt_name: '지산타운', lawd_cd: '27260', facility: { _empty: true } },
    { kapt_code: 'A2', apt_name: '값없음', lawd_cd: '11110', facility: { _empty: true } },
    { kapt_code: 'A3', apt_name: '쌍둥이', lawd_cd: '11140', facility: { _empty: true } },
    { kapt_code: 'A4', apt_name: '쌍둥이', lawd_cd: '11140', facility: { _empty: true } },
    { kapt_code: 'A5', apt_name: '캐시없음', lawd_cd: '41290', facility: { _empty: true } },
  ];
  const zeroRows = [
    { kapt_code: 'B1', apt_name: '세대수0', lawd_cd: '11680', facility: { kaptdaCnt: '0', hoCnt: '0', kaptName: '세대수0' } },
  ];

  const updates = [];
  const admin = {
    from(table) {
      const calls = [];
      const o = {
        select() { return o; },
        not(...a) { calls.push(['not'].concat(a)); return o; },
        is(...a) { calls.push(['is'].concat(a)); return o; },
        eq(...a) { calls.push(['eq'].concat(a)); return o; },
        in(...a) { calls.push(['in'].concat(a)); return o; },
        limit() { return o; },
        update(p) { calls.push(['update', p]); return o; },
        then(res, rej) {
          let data = [];
          if (table === 'building_register') {
            const inCall = calls.find(c => c[0] === 'in');
            const keys = new Set(inCall ? inCall[2] : []);
            data = brRows.filter(b => keys.has(b.apt_key));
          } else if (calls.some(c => c[0] === 'update')) {
            const patch = calls.find(c => c[0] === 'update')[1];
            const key = calls.find(c => c[0] === 'eq' && c[1] === 'kapt_code');
            updates.push({ kaptCode: key && key[2], facility: patch.facility });
            data = null;
          } else {
            // 두 후보 질의를 구분 — 세대수 0 질의만 kaptdaCnt 필터를 건다
            data = calls.some(c => c[0] === 'eq' && c[1] === 'facility->>kaptdaCnt') ? zeroRows : emptyRows;
          }
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return o;
    },
  };

  const r = await writeBackToMaster(admin);
  const byCode = new Map(updates.map(u => [u.kaptCode, u.facility]));

  assert.equal(r.written, 2, '되쓴 행 수가 다르다: ' + JSON.stringify(updates.map(u => u.kaptCode)));
  assert.deepEqual([...byCode.keys()].sort(), ['A1', 'B1']);

  assert.equal(byCode.get('A1')._br.hhldCnt, 630);
  assert.equal(byCode.get('A1')._br.dongCnt, 4);
  assert.equal(byCode.get('A1')._br.useAprDay, '19911115');
  assert.equal(byCode.get('A1')._br.source, 'buildingRegister');
  // 기존 facility 를 통째로 갈아끼우면 안 된다 — 덧붙이는 것이다
  assert.equal(byCode.get('A1')._empty, true, '기존 facility 키가 사라졌다');
  assert.equal(byCode.get('B1').kaptName, '세대수0', '기존 KAPT raw 가 사라졌다');
  assert.equal(byCode.get('B1')._br.hhldCnt, 250);

  // 건드리면 안 되는 것들
  assert.equal(byCode.has('A2'), false, '상류 세대수가 0인데 적었다 — 모름을 0으로 굳히면 안 된다');
  assert.equal(byCode.has('A3') || byCode.has('A4'), false, '동명 단지에 값을 붙였다 — 어느 쪽인지 알 수 없다');
  assert.equal(byCode.has('A5'), false, '캐시에 없는 단지를 적었다');
  assert.equal(r.ambiguous, 2, '동명으로 건너뛴 수가 안 맞는다');
});

test('_br 보존 — facility 통째 교체 경로가 건축물대장 값을 지우지 않는다', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/aptFacilityService.js'), 'utf8');
  const i = src.indexOf('async function backfillFacilityByKaptCode');
  assert.ok(i >= 0, 'backfillFacilityByKaptCode 를 못 찾았다');
  const body = src.slice(i, i + 3000);
  // 이 함수는 facility 를 **통째로 교체**한다. 보존이 빠지면 empty 재시도(14일 주기)마다 건축물대장
  //   세대수가 지워져 "채웠는데 며칠 뒤 다시 미상" 이 된다 — 사후 원인 추적이 매우 어렵다.
  assert.match(body, /select\('facility'\)/, '기존 facility 를 읽지 않으면 보존할 수 없다');
  assert.match(body, /_empty: true, _br: prevBr/, '실패 sentinel 경로가 _br 을 버린다');
  assert.match(body, /facilityToStore\._br = prevBr/, '성공 경로가 _br 을 버린다');
  // raw 를 그대로 넘기면 _br 을 붙일 때 상류 객체를 오염시킨다 → 복사본이어야 한다
  assert.match(body, /detail \? \{ \.\.\.raw, _dtl: detail \} : \{ \.\.\.raw \}/, 'facilityToStore 가 raw 참조를 그대로 쓴다');
});

// ── CRON-MISS-2026-08-17 (Sprint MMMMMMM-24) ──────────────────────────────────
// Vercel 공식 문서로 확정한 사실: cron 전달은 best effort 라 회차가 통째로 누락될 수 있고,
// 그때 런타임 로그조차 안 남으며, 실패해도 재시도하지 않는다. 따라서 알림 job 은
// "한 회차 걸러도 다음 회차가 따라잡는" 창을 가져야 한다. 그 창을 여기서 고정한다.
test('pushNotify — 누락 내성 창 72h + 캡에서 최신을 버리지 않는다', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../jobs/pushNotify.js'), 'utf8');

  // (1) 바닥 창 = 72h. 48h 면 하루만 걸러도 경계이고 이틀 연속이면 그 사이 신고 거래가 영구 유실된다.
  //     cronStats 의 미실행 임계 50h(=2회 연속 누락)와 같은 기준으로 맞춘 값이다.
  assert.match(src, /NOTIFY_FLOOR_MS\s*=\s*72\s*\*\s*3600\s*\*\s*1000/,
    '알림 바닥 창이 72h 가 아니다 — cron 누락 2회 내성이 깨진다');
  assert.equal(/48\s*\*\s*3600\s*\*\s*1000/.test(src), false, '옛 48h 창이 남아 있다');

  // (2) 거래 조회 정렬은 **내림차순**이어야 한다. 안전캡에 걸릴 때 오름차순이면 최신이 잘린다 —
  //     "새 실거래 알림" 에서 최신을 버리는 것은 정확히 반대 동작이다.
  const q = src.slice(src.indexOf("from('molit_transactions')"));
  assert.match(q.slice(0, 600), /order\('ingested_at',\s*\{\s*ascending:\s*false\s*\}\)/,
    '거래 조회가 오름차순이라 캡에 걸리면 최신 거래가 잘린다');
  assert.match(q.slice(0, 600), /order\('id',\s*\{\s*ascending:\s*false\s*\}\)/,
    '2차 정렬키 방향이 어긋나면 페이지 경계가 흔들린다');

  // (3) 캡·상한에 닿으면 침묵하지 않는다 — 조용히 잘리면 건수가 틀린 채로 발송된다.
  assert.match(src, /rows\.length >= ROW_CAP/, '거래 조회 캡 도달 경고가 없다');
  assert.match(src, /상한\(500\)에 닿음/, '구독자 조회 상한 경고가 없다');
});

// ── HH-BR-OBSERV-2026-08-17 (Sprint MMMMMMM-26) ───────────────────────────────
// emptyFetch·householdsZero 는 **KAPT 커버리지** 지표라 건축물대장으로 세대수를 채워도 안 줄어든다.
// 그래서 지표만 보면 "407곳 미확인" 이 영원히 유지된다 — 실제로 해소된 몫이 안 보인다.
// 여기서 고정하는 것은 "해소분을 어떻게 세는가" 다. 세는 방법을 틀리면 수치가 조용히 거짓이 된다.
test('facilityQuality — 건축물대장 해소분은 모집단 안에서만 센다', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const i = src.indexOf('async function getFacilityQuality');
  assert.ok(i >= 0, 'getFacilityQuality 를 못 찾았다');
  const body = src.slice(i, i + 4000);

  // (1) `_br` 을 **단독으로** 세면 안 된다. KAPT 가 나중에 성공한 행도 `_br` 을 보존하므로
  //     (aptFacilityService 가 재조회 시 유실을 막으려고 남긴다) 모집단 밖까지 빼게 되어
  //     실질 미확인이 과소 집계된다 → 반드시 각 모집단 조건과 AND 로 묶어야 한다.
  assert.match(body, /not\('facility->_empty', 'is', null\)\.not\('facility->_br', 'is', null\)/,
    '_empty 모집단 안의 해소분을 AND 로 세지 않는다');
  const zeroBr = body.slice(body.indexOf("_dtl"));
  assert.match(zeroBr, /kaptdaCnt[\s\S]{0,200}hoCnt[\s\S]{0,200}not\('facility->_br', 'is', null\)/,
    '세대수0 모집단 안의 해소분을 AND 로 세지 않는다');

  // (2) 실질 미확인은 뺄셈이되 음수 방어가 있어야 한다(모집단 정의가 바뀌어도 안전).
  assert.match(body, /Math\.max\(0,\s*\(emp - brE\)\)\s*\+\s*Math\.max\(0,\s*\(hh - brZ\)\)/,
    '실질 미확인 계산이 없거나 음수 방어가 없다');

  // (3) 두 신규 필드가 실제로 응답에 실린다 — 안 실으면 관측이 여전히 불가능하다.
  assert.match(body, /householdsFilledByBr:/, '해소 누계 필드가 응답에 없다');
  assert.match(body, /householdsUnknown:/, '실질 미확인 필드가 응답에 없다');

  // (4) warn 은 **실질 미확인**을 봐야 한다. emp 를 그대로 보면 건축물대장으로 다 채워도 계속 켜진다.
  assert.match(body, /warn:[^;]*hhUnknown >= 50/, 'warn 이 실질 미확인이 아니라 옛 지표를 본다');
  assert.equal(/warn:[^;]*emp >= 50/.test(body), false, 'warn 에 옛 emp 임계가 남아 있다');
});

/* ─────────────────────────────────────────────────────────────────────────────
 * PRICE-RECORDS-2026-08-29 (Sprint NNNNNNN-30): 지역 표시명은 **lawd_cd 에서만** 나온다.
 *
 * [왜 테스트로 묶는가] 동명 구를 문자열로 판정하다 6회 재발했다(서울 중구 LTV 오표기,
 *   부산 강서구 오판 등). molit 의 sigungu 는 광역이 없어 '남구'(부산·대구·울산)·'중구'(6곳)·
 *   '서구'(4곳)·'동구'(5곳)·'북구'(3곳)·'강서구'(2곳)가 **원리적으로 구별되지 않는다**.
 *   그래서 표시명은 LAWD_CODES 에서 파생하고, 그 파생이 전 코드에서 충돌 없는지를 여기서 고정한다.
 *   케이스를 손으로 고르면 빠뜨린다(중구 실사고) — **전수**로 돈다.
 * ───────────────────────────────────────────────────────────────────────────── */
const { regionLabel } = require('../services/priceRecordsService');
const { LAWD_CODES: _LC } = require('../services/transactionService');

test('지역 표시명: LAWD_CODES 전 코드가 매핑되고 표시명이 서로 충돌하지 않는다', () => {
  const seen = new Map();
  for (const [name, code] of Object.entries(_LC)) {
    const label = regionLabel(code, '__FALLBACK__');
    assert.notEqual(label, '__FALLBACK__', `${code}(${name}) 매핑 실패`);
    assert.ok(label && label.length >= 2, `${code}(${name}) 표시명이 비었다`);
    if (seen.has(label)) {
      assert.fail(`표시명 충돌: "${label}" ← ${seen.get(label)} / ${name} — 동명 구가 화면에서 구별되지 않는다`);
    }
    seen.set(label, name);
  }
  assert.equal(seen.size, Object.keys(_LC).length);
});

test('지역 표시명: 동명 구는 광역이 붙어 구별된다', () => {
  // 이름만으로는 같은 '남구'·'중구'·'서구' — 코드가 다르면 표시명도 달라야 한다.
  const 남구 = ['26290', '27200', '31140'].map(c => regionLabel(c, ''));
  assert.equal(new Set(남구).size, 3, `'남구' 3곳이 구별되지 않는다: ${남구.join(' / ')}`);
  const 중구 = ['11140', '26110', '27110', '28110', '30140', '31110'].map(c => regionLabel(c, ''));
  assert.equal(new Set(중구).size, 6, `'중구' 6곳이 구별되지 않는다: ${중구.join(' / ')}`);
  // 서울은 LAWD_CODES 에 접두 없이 등재돼 있다 — 화면에선 '서울'이 붙어야 어느 시인지 알 수 있다.
  assert.match(regionLabel('11140', ''), /^서울/, '서울 구에 광역 표기가 없다');
  assert.match(regionLabel('11500', ''), /^서울/, '서울 강서구에 광역 표기가 없다');
  assert.notEqual(regionLabel('11500', ''), regionLabel('26440', ''), '서울 강서구와 부산 강서구가 같은 표시명이다');
});

test('지역 표시명: 표에 없는 코드는 원본 sigungu 로 폴백한다(빈 문자열 아님)', () => {
  assert.equal(regionLabel('99999', '어딘가구'), '어딘가구');
  assert.equal(regionLabel(null, '어딘가구'), '어딘가구');
  assert.equal(regionLabel('99999', ''), '');
});

/* ─────────────────────────────────────────────────────────────────────────────
 * REG-BY-LAWD-2026-08-29 (Sprint NNNNNNN-31): 규제 판정을 **lawd_cd 로** 바꿨다.
 *
 * [왜 계약 테스트인가] 이제 판정이 두 벌 존재한다:
 *   ① getRegulatedKeywords — 사용자가 입력한 자유 문자열("분당","평촌")용. lawd_cd 가 없는 경로.
 *   ② getRegulatedLawdCodes — 지역 페이지·대시보드용. lawd_cd 를 이미 아는 경로.
 *   둘이 갈리면 같은 지역이 화면마다 다르게 표시된다(취득세 tier 사본 2개가 3주간 갈렸던 그 사고).
 *   그래서 **전 122코드에서 두 판정이 일치**함을 강제한다. 케이스를 손으로 고르지 않는다.
 *
 * DB 없이 돈다 — getSnapshot 이 FALLBACK 으로 떨어지고, 그 FALLBACK 이 현행 규제 목록이다.
 * ───────────────────────────────────────────────────────────────────────────── */
const _reg = require('../services/regulationsService');
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
