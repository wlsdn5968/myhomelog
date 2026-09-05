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
function _mockAdmin({ payRow, casRows, billingRow, listRows, upsertError }) {
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
      // BILLING-REPAIR-2026-09-02: upsert 실패를 주입할 수 있어야 '조용한 이용권 누락' 을 테스트할 수 있다.
      upsert: async (row) => { seen.upserts.push({ table, row }); return { data: null, error: upsertError || null }; },
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
  // 미래 만료가 남은 상태에서 재결제 → now+30 이 아니라 기존 만료+30 이어야 한다.
  // ⚠ TEST-DATE-ROT-2026-09-02 (감사 중 발견): 종전엔 `'2026-09-01T00:00:00.000Z'` 하드코딩이었다.
  //   그 날짜가 **2026-09-01 부로 과거가 되면서** computePeriodEnd 가 "기존 만료 기준 이월" 대신
  //   `now + 30일` 분기를 타기 시작했다 → ① 이 테스트가 검증하려던 이월 경로가 **무커버리지**가 되고
  //   ② 라우트의 new Date() 와 테스트의 new Date() 가 1ms 어긋나면 실패 → CI 가 무작위로 빨개졌다
  //   (실측: 16회 중 3회 실패, actual …040Z vs expected …041Z).
  //   → 절대 날짜를 쓰지 말고 **항상 미래**가 되도록 상대 시각으로 만든다.
  const existingEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
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
async function _withBillingStub2({ payRow, casRows, tossKey, webhookSecret, axiosImpl, billingRow, listRows, clientKey, liveEnabled, upsertError }, fn) {
  const clientPath = require.resolve('../db/client');
  const billPath = require.resolve('../routes/billing');
  const axiosPath = require.resolve('axios');
  const saved = { c: require.cache[clientPath], b: require.cache[billPath], a: require.cache[axiosPath] };
  const savedEnv = { k: process.env.TOSS_SECRET_KEY, w: process.env.TOSS_WEBHOOK_SECRET,
    ck: process.env.TOSS_CLIENT_KEY, lv: process.env.PAYMENTS_LIVE_ENABLED };
  const { client, seen } = _mockAdmin({ payRow, casRows, billingRow, listRows, upsertError });
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
  // ⚠ 하네스는 함수를 떼어내 실행한다 — 모듈 import(공유 구간)는 명시 주입해야 한다.
  const applyObjectiveScore = _reportFn('applyObjectiveScore',
    deps.concat(['turnoverScore']),
    deps.map((n) => _reportFn(n)).concat([require('../utils/scoreBands').turnoverScore]));

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
  // UNKNOWN-MID-2026-09-02 (감사 P1-5): 준공년도 미상은 **0 이 아니라 null**(모름) 이다.
  //   이 점수는 가산식이라 0 은 곧 "확인된 31년 초과" 와 같은 최하위였다 — 데이터가 없다는 이유로
  //   순위가 밀렸다. 호출부(applyObjectiveScore)가 null 을 보고 중간 밴드를 준다.
  //   years 는 여전히 null — 나이를 **추정하지는 않는다**(표시는 미확인).
  assert.deepEqual(getAgeBonus(null), { years: null, bonus: null });
  assert.deepEqual(getAgeBonus(0), { years: null, bonus: null });
});

test('computeAptScore — 신축/재건축 우선순위도 상대 나이 기준이다 (절대연도 하드코딩 복귀 차단)', () => {
  // ⚠ 하네스는 함수를 떼어내 실행하므로 모듈 import 가 없다 — 공유 구간 모듈을 주입한다.
  const computeAptScore = _reportFn('computeAptScore', ['turnoverScore'], [require('../utils/scoreBands').turnoverScore]);
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
  // ⚠ 하네스는 함수를 떼어내 실행하므로 모듈 import 가 없다 — 공유 구간 모듈을 주입한다.
  const computeAptScore = _reportFn('computeAptScore', ['turnoverScore'], [require('../utils/scoreBands').turnoverScore]);
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
  // UNKNOWN-MID-2026-09-02 (감사 P1-5): 세대수 미상은 **null**(모름) — 0 이 아니다.
  //   실측: 세대수 미확인 734곳(5.0%) 이 "확인된 300세대 미만" 4,606곳과 똑같이 0 점을 받고 있었다.
  //   여전히 대단지로 오인하지는 않는다(중간 밴드 12 점, 최고 30 점과 구별).
  assert.equal(getHouseholdBonus(null), null);
  assert.equal(getHouseholdBonus(0), null);
  assert.equal(getHouseholdBonus('많음'), null);

  // 주차 비율 — ratio 는 **문자열**(toFixed(2))이다. 프론트가 그대로 표시하므로 타입이 계약의 일부다.
  assert.deepEqual(getParkingBonus(1300, 1000), { ratio: '1.30', bonus: 12 });
  assert.deepEqual(getParkingBonus(1000, 1000), { ratio: '1.00', bonus: 8 });
  assert.deepEqual(getParkingBonus(700, 1000), { ratio: '0.70', bonus: 3 });
  assert.deepEqual(getParkingBonus(699, 1000), { ratio: '0.70', bonus: 0 }); // 표시는 반올림, 판정은 원값
  // ★ 0 나눗셈·미상 방어 — Infinity/NaN 이 점수에 섞이면 그 단지가 상위권을 통째로 차지한다
  //   UNKNOWN-MID-2026-09-02: 미상은 bonus null(모름). ratio 는 여전히 null — 비율을 지어내지 않는다.
  assert.deepEqual(getParkingBonus(1000, 0), { ratio: null, bonus: null });
  assert.deepEqual(getParkingBonus(0, 1000), { ratio: null, bonus: null });
  assert.deepEqual(getParkingBonus(null, null), { ratio: null, bonus: null });
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

// ── COND-FILTER-BEHAVIORAL-2026-09-02 (감사 후속: 테스트 행위화) ─────────────
//   [왜] 추천 조건 필터(_condPass)는 "모름"을 어떻게 다루느냐가 곧 결과다. 이 저장소는 이미
//     미확인 세대수를 0 으로 읽어 407곳(서울 56)을 소형으로 잘못 배제한 적이 있다.
//   [무엇이 바뀌었나] 종전 테스트는 소스에서 두 줄의 **존재와 순서**만 봤다("단위 테스트로는
//     못 잡는다"고 스스로 적어 뒀다). 그런데 _condPass 는 fMinHh/fMinPark/fSaleOnly 세 값만
//     닫아 쓰는 순수 클로저다 — 소스에서 그대로 **추출해 실행**하면 DB 없이 판정을 확인할 수 있다.
//     (프론트 함수에 쓰던 추출 기법과 같다. 프로덕션 코드는 건드리지 않는다.)
test('추천 조건 필터 — 실제로 실행해 판정을 확인한다 (모름·불일치·경계)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');
  const m = src.match(/ {2}const _condPass = \(fac\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(m, 'propertyService 에서 _condPass 를 찾지 못했다 — 이름/형태가 바뀌었다면 이 테스트도 갱신할 것');

  // 클로저가 닫아 쓰는 값만 주입해 실제 함수를 만든다
  const make = (fMinHh, fMinPark, fSaleOnly) =>
    new Function('fMinHh', 'fMinPark', 'fSaleOnly', m[0] + '\nreturn _condPass;')(fMinHh, fMinPark, fSaleOnly);

  const none = make(0, 0, false);
  const park = make(0, 1.5, false);
  const hh = make(500, 0, false);
  const sale = make(0, 0, true);

  // ① 필터가 없으면 통과 — 단, facility 자체를 모르면 조건을 확인할 수 없으니 제외한다
  //    (UI 안내와 같은 의미: "조건 확인 불가"이지 "조건 미달"이 아니다)
  assert.equal(none({ totalHouseholds: 100 }), true, '무필터인데 걸러졌다');
  assert.equal(none(null), false, 'facility 를 모르는데 조건을 만족한다고 봤다');

  // ② 주차 비율 — 경계와 **모름**
  assert.equal(park({ parkingRatio: 1.6 }), true, '기준 이상인데 걸러졌다');
  assert.equal(park({ parkingRatio: 1.5 }), true, '경계값(1.5)은 통과해야 한다');
  assert.equal(park({ parkingRatio: 1.4 }), false, '기준 미달이 통과했다');
  assert.equal(park({ parkingRatio: null }), false, '주차 비율을 모르는데 통과시켰다');

  // ③ ★ 세대수 원천이 갈린 단지는 주차 비율의 **분모를 믿을 수 없다** → 주차 조건에서 제외.
  //    이 가드가 빠지면 "주차 여유"라며 근거 없는 단지가 추천된다.
  assert.equal(park({ parkingRatio: 1.6, householdsConflict: true }), false,
    '세대수 불일치 단지가 주차 조건을 통과했다 — 분모를 못 믿는 값으로 추천된다');
  // 단, 주차 조건을 안 걸었으면 불일치는 배제 사유가 아니다(과잉 배제 방지)
  assert.equal(none({ parkingRatio: 1.6, householdsConflict: true }), true,
    '주차 필터를 안 걸었는데 세대수 불일치만으로 배제했다');

  // ④ 세대수 — 경계와 모름. `null` 과 `0` 둘 다 통과시키지 않는다
  //    (모름을 0 으로 표현한 생산자가 있어서 실제로 사고가 났던 지점이다)
  assert.equal(hh({ totalHouseholds: 500 }), true, '경계값(500)은 통과해야 한다');
  assert.equal(hh({ totalHouseholds: 499 }), false, '기준 미달이 통과했다');
  assert.equal(hh({ totalHouseholds: null }), false, '세대수를 모르는데 통과시켰다');
  assert.equal(hh({ totalHouseholds: 0 }), false, '0(=모름의 잘못된 표현)이 통과했다');

  // ⑤ 분양만
  assert.equal(sale({ saleType: '분양' }), true, '분양 단지가 걸러졌다');
  assert.equal(sale({ saleType: '임대' }), false, '임대 단지가 분양만 조건을 통과했다');
  assert.equal(sale({}), false, '분양 여부를 모르는데 통과시켰다');
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
  // SCORE-V2-2026-08-30: 점수 함수가 100점 모델로 바뀌면서 표현이 달라졌다 —
  //   가드의 **의도**(세대수 원천이 갈리면 주차 비율로 점수를 올리지 않는다)는 그대로여야 한다.
  //   ⚠ 다만 이제는 0점이 아니라 **중간값**을 준다(모르는 것을 나쁨으로 만들지 않는다).
  assert.match(svc, /facility && facility\.householdsConflict\) \? null : \(\(facility && facility\.parkingRatio\) \|\| null\)/,
    '점수 가산이 세대수 불일치 단지에도 붙는다 — 실측상 세대당 6.07대까지 부푼다');
  assert.match(svc, /const 주차 = pr === null \? 3 :/,
    '세대수 불일치·주차 미확인을 0점으로 떨어뜨린다 — 모르는 것은 중간값이어야 한다');
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
  // PYEONG-CONST-2026-09-02: 리터럴 나눗셈(`/ 3.3058`)을 상수(`/ _PYEONG_M2`)로 바꿨다.
  //   이 단언의 의도는 '계수가 실제로 쓰이는가'(전부 지워지는 사고 방지)이므로, 리터럴이 아니라
  //   **상수를 쓰는 나눗셈이 존재하는가**로 확인한다.
  const divs = (ana.match(/\/\s*_PYEONG_M2/g) || []).length;
  assert.ok(divs >= 2, `analysisService 가 정확 계수를 나눗셈에 쓰지 않는다(${divs}회)`);
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
  //    PRICE-BASIS-2026-08-30: 건수 자체가 `c.n`(예산 밴드로 잘린 풀) → `_n`(밴드 미적용 재집계)로 바뀌었다.
  //    재집계가 실패하면 _n 이 c.n 으로 폴백하므로 잘림 가드는 그대로 필요하다.
  assert.match(src, /!c\._poolTruncated && _n <= 5/,
    "'표본 적음' 판정이 잘림 가드를 안 거친다 — 실제로 거래 많은 단지에 없는 위험을 붙인다");
  assert.match(src, /const _n = Number\(c\.areaTotalN\) > 0 \? Number\(c\.areaTotalN\) : \(c\.n \|\| 0\)/,
    '거래 건수가 예산 밴드로 잘린 c.n 을 그대로 쓴다 — 실제보다 적게 표기된다(동탄 실측 52 vs 66)');
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
  // MULTI-REGION-2026-08-30: 콤마 구분 다중 코드를 받는다. 형식 검증(5자리)은 그대로 —
  //   화이트리스트(LAWD_CODES) 검증·중복 제거·상한(6)은 pickRegions 가 맡는다.
  assert.ok(/const _reqLawdCd = String\(input\.lawdCd/.test(src),
    'lawdCd 를 다중 코드로 받지 않는다 — 복수 지역 선택이 보고서에 전달되지 않는다');
  assert.ok(/filter\(x => \/\^\\d\{5\}\$\/\.test\(x\)\)/.test(src),
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

// ── PEAK-FLOOR-2026-08-31 (Sprint PPPPPPP) ────────────────────────────────────
// 운영자가 준 컨설팅 보고서는 단지마다 "전고점"과 층·동 조건(RR)을 함께 적었다.
// 우리도 같은 판단 근거를 주되, **말할 수 있는 것만** 말한다:
//   · 우리 DB 는 2025-05 부터라 **역대 전고점을 모른다** → "최근 6개월 최고" 로만 쓴다.
//   · 층별 가격대는 표본이 얇으면 사례 하나에 끌려간다 → 층 정보 6건 미만이면 아예 만들지 않는다.
test('보고서 최고가·층별 가격대 — 기간을 속이지 않고, 표본이 얇으면 만들지 않는다', () => {
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const rpt = fs2.readFileSync(path2.join(__dirname, '../routes/report.js'), 'utf8');
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  // ① 값이 만들어지고 응답에 실린다.
  assert.match(rpt, /c\.peak6m = stats\[0\]\.max;/, '대표 평형 최고가를 계산하지 않는다');
  assert.match(rpt, /peak6mAuk:/, '최고가를 응답에 싣지 않는다');
  assert.match(rpt, /floorBands:/, '층별 가격대를 응답에 싣지 않는다');

  // ② ⚠ "전고점" 이라고 부르지 않는다 — 16개월치 DB 로 역대 최고가를 주장할 수 없다.
  //    ⚠ 소스 문자열 창을 훑지 않는다 — 주석에 적힌 "전고점 이라고 쓰지 않는다" 를 잡아
  //      멀쩡한 코드가 실패했다. **실제 출력**을 검사한다(아래 ④ 에서 만든 문구로).
  assert.match(fe, /최근 6개월 최고/, '기간을 밝히지 않은 최고가 문구다');

  // ③ 층별 가격대 표본 하한이 있다.
  assert.match(rpt, /if \(withF\.length >= 6\)/, '층 표본 하한이 없다 — 1~2건으로 층별 시세를 만든다');
  assert.match(rpt, /g\.length >= 2 \?/, '구간별 표본 하한이 없다');
  assert.match(rpt, /if \(b1 && b3\) floorBands =/,
    '저층·고층 중 하나가 비어도 층별 가격대를 만든다 — 비교 대상이 없으면 의미가 없다');

  // ④ 실제로 실행해 확인한다.
  // ⚠ 공용 스코프로 옮기면서 들여쓰기가 사라졌다 — 앵커를 들여쓰기에 의존시키지 않는다.
  const m = fe.match(/const _peakFloorLine = \(a\) => \{[\s\S]*?\n\};/);
  assert.ok(m, '문구 빌더를 찾지 못했다');
  const fn = new Function(`${m[0]}; return _peakFloorLine;`)();
  assert.equal(fn({}), '', '값이 없는데 빈 줄을 만든다');
  const withPeak = fn({ peak6mAuk: 8.35 });
  assert.ok(withPeak.includes('8.35억') && withPeak.includes('최근 6개월 최고'), '최고가 문구가 비었다');
  // ⚠ 실제 출력에 "전고점" 이 있으면 안 된다 — 우리 DB(2025-05~)로는 알 수 없는 사실이다.
  assert.ok(!withPeak.includes('전고점'), '표시 문구가 "전고점" 을 주장한다');

  // ⑥ ⚠ 이 함수는 **화면·인쇄 두 렌더러가 공유**한다. 한쪽 함수 안에 정의하면
  //    다른 쪽에서 `_peakFloorLine is not defined` 로 보고서가 통째로 죽는다(실제로 죽었다).
  //    선언이 어느 함수 본문에도 들어가 있지 않은지 — 즉 공용 스코프인지 확인한다.
  const defIdx = fe.indexOf('const _peakFloorLine = (a) =>');
  assert.ok(defIdx > 0, '_peakFloorLine 선언을 찾지 못했다');
  const before = fe.slice(0, defIdx);
  const renderIdx = before.lastIndexOf('function _renderReport(data) {');
  const pdfIdx = before.lastIndexOf('function _downloadReportPDF()');
  assert.equal(renderIdx, -1, '_peakFloorLine 이 _renderReport 안에 갇혀 있다 — 인쇄 쪽에서 죽는다');
  assert.equal(pdfIdx, -1, '_peakFloorLine 이 _downloadReportPDF 안에 갇혀 있다 — 화면 쪽에서 죽는다');
  const full = fn({ peak6mAuk: 8.35, floorBands: { low: { upTo: 5, n: 3, auk: 7.1 }, mid: { n: 4, auk: 7.9 }, high: { from: 12, n: 3, auk: 8.2 } } });
  assert.ok(full.includes('저층(~5층) 7.1억') && full.includes('고층(12층~) 8.2억'), '층별 문구가 비었다');
  // 층 정보가 없으면 층 문구는 빠지고 최고가만 남는다.
  assert.ok(!fn({ peak6mAuk: 8.35 }).includes('층별'), '층 정보가 없는데 층별 문구를 만든다');
});

// ── WATERMARK-ID-2026-08-31 (Sprint PPPPPPP) ──────────────────────────────────
// 운영자: "워터마크는 고객의 아이디나 이런 걸로 특정할 수 있도록 해놓은 거 맞지? 제대로 하자."
// 처음 넣은 워터마크는 브랜드명("내집로그 · myhomelog")뿐이라 **어느 계정에 발급된 문서인지
// 되짚을 수 없었다.** PDF 는 캡처·재배포되기 쉬우므로 발급 대상이 남아야 한다.
// ⚠ 그렇다고 이메일 전문을 박지 않는다 — 정상적으로 공유하는 경우에도 개인정보가 그대로 노출된다.
//   마스킹된 아이디(본인 식별) + 해시 8자(운영자가 DB 대조로 특정) 조합을 쓴다.
test('워터마크 — 발급 대상을 특정할 수 있되 이메일 전문은 노출하지 않는다', () => {
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  const m = fe.match(/const _issuedTo = \(\(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(m, '발급 대상 식별자 생성 블록을 찾지 못했다');

  // 실제로 실행해 동작을 확인한다(소스 검사만으로는 부족하다).
  const run = (session) => {
    const localStorage = { getItem: () => JSON.stringify(session || {}) };
    return new Function('localStorage', `${m[0]}; return _issuedTo;`)(localStorage);
  };

  const r = run({ user: { email: 'wlsdn5968@kakao.com', id: 'fd15c0b7-6330-4bfa-a671-0aa6bcf4a2e3' } });
  assert.ok(r, '로그인 세션인데 발급 대상이 비었다');
  // ① 이메일 전문이 그대로 들어가면 안 된다.
  assert.ok(!r.label.includes('wlsdn5968'), '이메일 아이디가 마스킹되지 않았다');
  // ② 그러나 본인이 알아볼 수는 있어야 한다(앞 3자 + 도메인 유지).
  assert.ok(r.label.startsWith('wls'), '본인이 알아볼 단서가 없다');
  assert.ok(r.label.endsWith('@kakao.com'), '도메인이 사라져 식별이 어렵다');
  // ③ 운영자가 DB 와 대조할 수 있는 해시가 있어야 한다.
  assert.match(r.tag, /^[0-9a-f]{8}$/, '대조용 해시가 8자 16진수가 아니다');
  // ④ 같은 계정은 항상 같은 값이어야 대조가 된다.
  assert.equal(run({ user: { email: 'wlsdn5968@kakao.com', id: 'fd15c0b7-6330-4bfa-a671-0aa6bcf4a2e3' } }).tag, r.tag,
    '같은 계정인데 해시가 매번 달라진다 — 유출 추적이 불가능하다');
  // ⑤ 다른 계정은 달라야 한다.
  assert.notEqual(run({ user: { email: 'other@x.com', id: 'aaaaaaaa-0000-0000-0000-000000000000' } }).tag, r.tag,
    '다른 계정인데 해시가 같다');
  // ⑥ 짧은 아이디도 마스킹된다.
  assert.ok(!run({ user: { email: 'ab@x.com', id: 'u2' } }).label.startsWith('ab@'),
    '짧은 아이디가 마스킹 없이 그대로 노출된다');
  // ⑦ 비로그인/저장소 차단이면 null — 없는 사람을 지어내지 않는다.
  assert.equal(run({}), null, '세션이 없는데 발급 대상을 만들어낸다');

  // ⑧ 워터마크·하단에 실제로 쓰인다.
  assert.match(fe, /class="wmark"[^>]*><span>\$\{_issuedTo \?/, '워터마크가 발급 대상을 쓰지 않는다');
  assert.match(fe, /발급 대상 /, '하단에 발급 대상 표기가 없다');
  assert.match(fe, /제3자 공개·재배포를 삼가주세요/, '재배포 주의 문구가 없다');
});

// ── PRIMARY-SAMPLE-2026-08-31 (Sprint PPPPPPP) ────────────────────────────────
// 전국 실측(101지역·1,793건): 헤드라인 가격의 대표 평형이 거래 **1건**인 경우 **16.9%**,
//   2건 이하 29.1%. [사례] 이편한세상강동에코포레 — 단지 전체 11건인데 대표 16평은 1건,
//   그 한 건의 12.6억이 헤드라인이 됐다.
// 원인: 대표 평형을 **예산 근접만** 보고 골랐고 표본을 전혀 보지 않았다.
test('대표 평형 — 표본이 충분한 평형을 우선하되, 없으면 버리지 않는다', () => {
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① 표본 하한이 존재하고, 충분한 것들 중에서 고른다.
  assert.match(svc, /const MIN_PRIMARY_N = 3;/, '대표 평형 표본 하한이 없다');
  assert.match(svc, /const _enough = fitPyeongs\.filter\(p => \(p\.dealCount \|\| 0\) >= MIN_PRIMARY_N\)/,
    '표본이 충분한 평형을 추려내지 않는다');

  // ② ⚠ 표본이 적다고 **단지를 버리지 않는다** — 예산대에 그 평형뿐일 수 있다.
  assert.match(svc, /_pickClosest\(_enough\.length \? _enough : fitPyeongs\)/,
    '표본이 부족하면 단지가 통째로 사라진다 — 폴백이 없다');

  // ③ 표본 수를 응답에 실어 화면이 "1건 기준" 임을 밝힐 수 있게 한다.
  assert.match(svc, /priceSampleN: p\.dealCount \|\| 0,/, '표본 수를 응답에 싣지 않는다');

  // ④ 실제 선택 로직을 돌려 확인한다 — 소스 검사만으로는 동작을 보장하지 못한다.
  const m = svc.match(/const MIN_PRIMARY_N = 3;[\s\S]*?const primaryPyeong = _pickClosest\(_enough\.length \? _enough : fitPyeongs\);/);
  assert.ok(m, '대표 평형 선택 블록을 찾지 못했다');
  const run = (fitPyeongs, maxBudget) => new Function('fitPyeongs', 'maxBudget',
    `${m[0]}; return primaryPyeong;`)(fitPyeongs, maxBudget);

  //   예산 12억. 16평은 1건(12.6억, 예산에 더 가까움) · 26평은 9건(11.0억).
  //   표본을 보지 않으면 16평이 뽑힌다 — 그게 이번에 고친 결함이다.
  const picked = run([
    { pyeong: 16, avgPrice: 126000, dealCount: 1 },
    { pyeong: 26, avgPrice: 110000, dealCount: 9 },
  ], 12);
  assert.equal(picked.pyeong, 26, '1건짜리 평형이 9건짜리를 제치고 대표가 된다');

  //   충분한 표본이 하나도 없으면 종전대로 예산 근접으로 고른다(단지를 버리지 않는다).
  const only = run([
    { pyeong: 16, avgPrice: 126000, dealCount: 1 },
    { pyeong: 26, avgPrice: 90000, dealCount: 2 },
  ], 12);
  assert.equal(only.pyeong, 16, '표본이 모두 부족할 때 예산 근접 폴백이 동작하지 않는다');

  // ⑤ 화면이 표본 적음을 밝힌다.
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.match(fe, /Number\(p\.priceSampleN\) <= 2/,
    '표본 1~2건인 가격에 아무 표시가 없다 — 사용자가 시세로 읽는다');
});

// ── REPORT-DEPTH-2026-08-31 (Sprint PPPPPPP) ──────────────────────────────────
// 운영자: "예전에 받았던 컨설팅 보고서처럼 요약 총평·매매 시 주의할 점·뭘 봐야 하는지·
//          어떤 집을 피해야 하는지가 들어가면 좋겠다. 로고랑 워터마크도."
// ⚠ 참고로 받은 컨설팅 보고서에는 "상승여력 2~5억", "○○구역을 추천함" 같은 표현이 있었다.
//   그건 **옮기지 않는다** — 이 서비스의 절대 룰(매수·매도 추천 X · 미래 가격 예측 X)이 우선한다.
//   넣는 것은 매수 실무에서 **확인해야 할 항목**과 **우리가 잰 사실**뿐이다.
test('보고서 확인사항 — 실무 항목만 넣고 추천·예측 표현은 넣지 않는다', () => {
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const rpt = fs2.readFileSync(path2.join(__dirname, '../routes/report.js'), 'utf8');

  // ① 섹션이 존재하고 응답에 실린다.
  assert.match(rpt, /const cautions = \[/, '확인사항(cautions) 섹션이 없다');
  assert.match(rpt, /^\s*cautions,$/m, 'cautions 가 보고서 응답에 실리지 않는다');

  // ② ⚠ 절대 룰 — cautions 본문에 가격 예측·매수 권유 표현이 없어야 한다.
  const block = rpt.slice(rpt.indexOf('const cautions = ['), rpt.indexOf('  return {', rpt.indexOf('const cautions = [')));
  const banned = ['상승여력', '오를 것', '유망', '저평가', '추천함', '사세요', '매수하세요', '지금이 기회'];
  for (const w of banned) {
    assert.ok(!block.includes(w), `확인사항에 금지 표현이 들어갔다: "${w}" — 절대 룰(추천 X·예측 X) 위반`);
  }
  // 권유가 아니라는 점을 본문에 명시한다.
  assert.ok(/매수·매도 권유가 아니에요/.test(block),
    '확인사항이 권유가 아니라는 문장이 없다 — 조언으로 읽힐 수 있다');

  // ③ 화면·인쇄 **양쪽** 에 그려야 한다(한쪽만 그리면 PDF 와 화면이 갈린다).
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.match(fe, /const cautionsHtml =/, '인쇄 보고서가 확인사항을 그리지 않는다');
  assert.match(fe, /const _cautionsWeb =/, '화면 보고서가 확인사항을 그리지 않는다');

  // ④ 로고·워터마크 (운영자 명시 요청)
  assert.match(fe, /class="brandbar"/, '인쇄 보고서에 로고가 없다');
  assert.match(fe, /class="wmark"/, '인쇄 보고서에 워터마크가 없다');
  // 워터마크가 본문 선택·클릭을 막으면 안 된다.
  assert.match(fe, /\.wmark \{[^}]*pointer-events: none/, '워터마크가 본문 조작을 막는다');
});

// ── SAME-DONG-SPLIT-2026-08-30 (Sprint PPPPPPP) ───────────────────────────────
// 운영자 발견: "광해리드빌이 미추로 61에도 있고 주안로 171에도 있는 것 같은데?
//              이런 것들도 많을 테니 확인 잘 해."
// 전수 실측(최근 6개월 거래):
//   · 같은 이름·같은 시군구인데 **다른 동** 340건 → 집계 키에 동이 있어 이미 분리됨(안전)
//   · 같은 이름·같은 동인데 다른 apt_seq 31그룹 중 **준공년도까지 다른 것 20그룹·204거래**
//     [사례] 부천 소사본동 "주공": 400-8(1995년·평균 2.78억·43건) ↔ 407-1(2006년·평균 4.23억·6건).
//            합치면 "2.97억" 이 되어 **둘 다 틀린 값**이 된다. 최대 준공년차 30년.
//   · ⚠ apt_seq 로 나누지 않는다 — 한 단지에 여러 seq 가 붙는 11그룹까지 쪼개진다.
//     준공년도는 "다르면 확실히 별개" 라는 결정적 증거이고 과분할은 2그룹뿐이다.
test('단지 식별 — 이름·동이 같아도 준공년도가 다르면 다른 단지로 센다', () => {
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const tx = fs2.readFileSync(path2.join(__dirname, '../services/transactionService.js'), 'utf8');
  const rpt = fs2.readFileSync(path2.join(__dirname, '../routes/report.js'), 'utf8');

  // ① 추천 경로
  assert.match(tx, /const gkey = `\$\{t\.aptName\}\|\$\{t\.lawdCd \|\| ''\}\|\$\{t\.umdNm \|\| ''\}\|\$\{t\.buildYear \|\| ''\}`/,
    '거래 집계 키에 준공년도가 없다 — 1995년 단지와 2006년 단지가 한 평균으로 합쳐진다');

  // ② 보고서 경로도 **같은 정책**이어야 한다(두 경로가 갈리면 또 어긋난다).
  assert.match(rpt, /const key = `\$\{_canon\}\|\$\{t\.sigungu\}\|\$\{t\.umd_nm\}\|\$\{t\.build_year \|\| ''\}`/,
    '보고서 집계 키가 추천 경로와 다르다 — 같은 단지가 두 화면에서 다른 값을 갖는다');

  // ③ 관심도 캐시 키에도 동이 들어가야 한다(같은 구 동명 단지 340건).
  const dl = fs2.readFileSync(path2.join(__dirname, '../services/naverDatalabService.js'), 'utf8');
  assert.match(dl, /function cacheKeyFor\(name, sigungu, umd\)/,
    '관심도 캐시 키에 동이 없다 — 같은 구의 동명 단지가 뭉개진다');
  assert.ok(!/ni:\$\{normalizeAptName\(name\)\}\|\$\{String\(sigungu \|\| ''\)\.trim\(\)\}`/.test(dl),
    '옛 2단 키(이름|시군구)가 남아 있다');
});

// ── INTEREST-KEY-2026-08-30 (Sprint PPPPPPP) ──────────────────────────────────
// 캐시를 1,551건 채워놓고도 점수는 전부 중간값이었다 — **키가 양쪽에서 달랐다.**
//   채우는 쪽: apt_geocache 이름 "서동탄역파크자이아파트"
//   읽는 쪽  : MOLIT 이름 "서동탄역파크자이" + 게다가 추천 객체엔 `sigungu` 필드가 아예 없다
//              (area 로 합쳐져 있어 rec.sigungu 는 항상 undefined → 키 뒷부분이 빈 문자열)
// 캐시는 "채웠다" 와 "쓰인다" 가 다른 문제다. 채운 건수만 보고 됐다고 하면 안 된다.
test('관심도 캐시 — 이름 표기가 달라도 같은 키를 만든다', () => {
  const dl = require('../services/naverDatalabService');

  // ① 표기 차이가 키에 영향을 주면 안 된다.
  assert.equal(dl.normalizeAptName('서동탄역파크자이아파트'), '서동탄역파크자이');
  assert.equal(dl.normalizeAptName('서동탄역파크자이'), '서동탄역파크자이');
  assert.equal(dl.normalizeAptName('힐스테이트대명센트럴(101,102동)'), '힐스테이트대명센트럴');
  // 단지 번호는 이름의 일부다 — 지우면 다른 단지와 뭉개진다.
  assert.equal(dl.normalizeAptName('수원 호매실벨섬시티 14단지'), '수원 호매실벨섬시티 14단지');

  // ② propertyService 가 sigungu 를 **실제 있는 곳**에서 가져온다.
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.ok(!/aptName: rec\.aptName, sigungu: rec\.sigungu/.test(svc),
    '추천 객체에 없는 rec.sigungu 로 캐시 키를 만든다 — 키 뒷부분이 항상 비어 영원히 미스다');
  assert.match(svc, /sigungu: \(_rankedF\[i\] && _rankedF\[i\]\.sigungu\)/,
    'sigungu 를 실제 소스(_rankedF)에서 가져오지 않는다');
});

// ── INTEREST-BAND-2026-08-30 (Sprint PPPPPPP) ─────────────────────────────────
// 장기 검색 관심도(네이버 데이터랩 36개월) 구간은 **실분포로 보정**했다.
//   전국 1,551단지·103시군구 실측 분위수:
//     p10 0.0001 · p25 0.0003 · p50 0.0062 · p75 0.0224 · p90 0.0563 · p97 0.1296 · 최대 1.304
//   (초기 구간은 표본 3개로 잡은 값이었고, 그 구간에서는 45% 가 최저점을 받았다.)
test('관심도 점수 — 모름은 중간값, 측정된 최저도 0 이 아니다', () => {
  const { interestScore } = require('../utils/scoreBands');
  const MAX = 14;

  // ① ⚠ Number(null) === 0 이다. null 을 숫자로 흘리면 **모름이 최저점으로 둔갑**한다.
  for (const unknown of [null, undefined, '', 'x', NaN]) {
    const r = interestScore(unknown, MAX);
    assert.equal(r.known, false, `${String(unknown)} 를 '측정됨' 으로 취급한다`);
    assert.equal(r.score, 7, '모름이 중간값(7)을 받지 않는다 — 모름은 나쁨이 아니다');
    assert.equal(r.why, null, '모르는데 근거 문구를 지어낸다');
  }

  // ② 측정된 값은 단조 증가하고, **바닥도 0 이 아니다**.
  //    낮은 비율은 '인기 없음' 이기도 하지만 '우리 키워드가 안 맞는다' 는 신호이기도 하다
  //    (실측: "서동탄역파크자이아파트" 0.003 ↔ "서동탄역파크자이" 1.10 — 355배).
  const pts = [1.304, 0.1296, 0.0563, 0.0224, 0.0062, 0.0003, 0].map(r => interestScore(r, MAX).score);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i] <= pts[i - 1], `관심도가 낮아졌는데 점수가 올랐다 (${pts[i - 1]} → ${pts[i]})`);
  }
  assert.equal(pts[0], MAX, '최상위가 만점이 아니다');
  assert.ok(pts[pts.length - 1] > 0, '측정된 최저가 0 점이다 — 증거가 약한 쪽에 큰 벌점을 주면 안 된다');
  assert.ok(pts[pts.length - 1] < 7, '측정된 최저가 모름(중간값)보다 높거나 같다 — 변별이 사라진다');

  // ③ 구간 숫자는 scoreBands 한 곳에만 있어야 한다(소비자 복제 금지).
  const fs2 = require('node:fs'); const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.ok(!/r >= 0\.1296/.test(svc), '관심도 구간이 propertyService 에 복제돼 있다');
  assert.match(svc, /interestScore\(/, 'propertyService 가 공유 구간 함수를 쓰지 않는다');
});

// ── SCORE-ZERO-2026-08-30 (Sprint PPPPPPP) ────────────────────────────────────
// 전국 루프(121지역·2,259건) 검증 중 발각. KAPT 이름 매칭에 실패한 단지가 **0점**으로,
// scoreBreakdown·scoreWhy 도 없이 화면에 찍혔다.
//   [실측] 용산구 12억 검색 → '삼라마이다스빌2'(158세대·6개월 2건)가 0점으로 8위.
// 원인: recommendations 는 `score: 0` 으로 만들어지고 "enrichment 에서 확정" 하기로 돼 있는데,
//   KAPT 코드가 없는 갈래가 **점수 계산 없이 조기 반환**해 확정이 일어나지 않았다.
// 매칭 실패는 우리 사정이지 단지의 결함이 아니다 — 아는 만큼으로 점수를 낸다.
test('점수 — KAPT 매칭 실패 단지도 0점이 아니라 아는 만큼 받는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① KAPT 코드 없는 갈래가 점수를 확정한다.
  const branch = svc.slice(svc.indexOf('if (!kaptCode) {'), svc.indexOf('// DTL-INFO-2026-05-13'));
  assert.ok(branch.length > 0, 'KAPT 미매칭 분기를 찾지 못했다');
  assert.match(branch, /_applyFacilityToScore\(/,
    'KAPT 매칭 실패 분기가 점수를 계산하지 않는다 — 그 단지는 영원히 0점이다');
  assert.match(branch, /scoreBreakdown: _sc0\.breakdown/,
    '근거(breakdown)를 싣지 않는다 — 화면에 0점이 이유 없이 찍힌다');

  // ② 세대수를 못 구해도(건축물대장도 실패) 점수는 나와야 한다.
  //    `if (!brHh) return rec;` 로 되돌아가면 이 검사가 깨진다.
  assert.ok(!/if \(!brHh\) return rec;/.test(svc),
    '건축물대장까지 실패하면 다시 0점으로 돌아간다 — 모름은 0점이 아니다');

  // ③ 실제로 계산해 본다 — facility 가 null 이어도 0 보다 커야 한다.
  //    (교통 15 중간값 + 인프라 10 + 규모주차 중간 + 관심도 7 … 최소한 양수)
  const m = svc.match(/function _applyFacilityToScore[\s\S]*?\n\}/);
  assert.ok(m, '_applyFacilityToScore 를 찾지 못했다');
  const bands = require('../utils/scoreBands');
  const walk = require('../utils/walkBand');
  const fn = new Function('turnoverScore', 'interestScore', 'parseWalkBand', 'WALK_BAND_LABEL', 'SCORE_V2_MAX',
    `${m[0]}; return _applyFacilityToScore;`)(
    bands.turnoverScore, bands.interestScore, walk.parseWalkBand, walk.WALK_BAND_LABEL,
    { 교통: 28, 인프라: 16, 규모주차: 12, 거래: 14, 연식: 10, 평형: 6, 관심도: 14 });
  const out = fn({ total: 8, breakdown: { 연식: 6, 평형: 2 }, dealCount: 3 }, null, null);
  assert.ok(out.total > 0, `facility 가 없어도 점수가 0 이면 안 된다 (실제 ${out.total})`);
  assert.ok(Array.isArray(out.why) && out.why.length > 0, '근거 문구가 비어 있다');
});

// ── WALK-BAND-2026-08-30 (Sprint PPPPPPP) ─────────────────────────────────────
// 운영자: "서동탄역더샵파크시티는 누가봐도 도보 30분 이상인데 지하철 5분 이내는
//          무슨 소리를 하는거야;; db가 잘못된거야 뭐야."
// [실측 — 이 테스트가 고정하는 사실]
//   · KAPT 원본 kaptdWtimesub = "10~15분이내" (5분이내 아님)
//   · 카카오 도보 실측 = 1,783m / 1,606초 = 26.8분
//   · `"10~15분이내".includes("5분이내")` === true  ← **버그의 정체**
//   · 그래서 도보 10~15분 단지 2,429곳이 교통 만점(30)을 받았다.
//     만점 단지 4,357곳 중 55.7% 가 가짜였다 → 검색 상위가 통째로 뒤틀렸다.
test('도보시간 밴드 — 부분문자열 매칭 금지(10~15분이 5분이내로 읽히면 안 된다)', () => {
  const { parseWalkBand, WALK_BAND_LABEL } = require('../utils/walkBand');

  // ① 밴드가 1:1 로 정확히 갈린다. 특히 10~15 는 절대 LE5 가 아니다.
  assert.equal(parseWalkBand('5분이내'), 'LE5');
  assert.equal(parseWalkBand('5~10분이내'), 'M5_10');
  assert.equal(parseWalkBand('10~15분이내'), 'M10_15',
    '"10~15분이내" 가 5분이내로 읽힌다 — 이 버그가 2,429 단지를 교통 만점으로 올렸다');
  assert.equal(parseWalkBand('15~20분이내'), 'M15_20');
  assert.equal(parseWalkBand('20분초과'), 'GT20');

  // ② 모르는 값은 조용히 통과시키지 말고 null(=모름). 뒤에서 중간값을 받는다.
  for (const junk of ['', null, undefined, '거리없음', '해당없음']) {
    assert.equal(parseWalkBand(junk), null, `인식 못 하는 값(${junk})은 null 이어야 한다`);
  }

  // ③ ⚠ 회귀 방지의 핵심: 순진한 includes 구현이었다면 ①이 깨진다는 것을 여기서 못박는다.
  assert.ok('10~15분이내'.includes('5분이내'),
    '전제가 바뀌었다 — 이 substring 함정이 사라졌다면 위 주석을 갱신하라');

  // ④ 점수 소비자가 includes 로 되돌아가지 못하게 한다.
  const svc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../services/propertyService.js'), 'utf8');
  assert.ok(!/sub\.includes\('5분이내'\)/.test(svc),
    'propertyService 가 다시 부분문자열 매칭을 쓴다 — parseWalkBand 를 쓸 것');
  assert.ok(/parseWalkBand\(facility && facility\.walkSubwayMin\)/.test(svc),
    '지하철 도보시간이 parseWalkBand 를 거치지 않는다');
  assert.ok(/parseWalkBand\(facility && facility\.walkBusMin\)/.test(svc),
    '버스 도보시간도 같은 함정에 있다 — parseWalkBand 를 거칠 것');

  // ⑤ 라벨은 밴드마다 달라야 한다(표시가 겹치면 사용자가 구분 못 한다).
  const labels = Object.values(WALK_BAND_LABEL);
  assert.equal(new Set(labels).size, labels.length, '밴드 라벨이 중복된다');
});

// ── SCORE-V2-2026-08-30 (Sprint OOOOOOO) ──────────────────────────────────────
// 운영자: "부동산은 위치·교통(지하철 도보 몇 분)·핵심 인프라·거래 활발이 더 중요하다.
//          기존 점수표가 너무 별로다. 다시 객관화해라."
// [기존 실측] 거래량 30 · 신축 18 · 평형 8 · 세대수 8 · 주차 4 · **지하철 도보 4** · 교육 2.
//   교통이 거래량의 1/7.5 였고, 병원·마트는 추천 점수에 **아예 없었다**.
// [새 배점 — 운영자 승인] 교통 30 · 인프라 20 · 규모주차 15 · 거래 15 · 연식 12 · 평형 8 = 100
test('점수 V2 — 교통이 최대 비중이고, 모르는 것은 0이 아니라 중간값이다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const svc = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① 배점표가 한 곳에 선언되고 교통이 가장 크다(사본이 갈릴 자리를 만들지 않는다).
  const m = svc.match(/const SCORE_V2_MAX = \{([^}]+)\}/);
  assert.ok(m, '배점표 상수(SCORE_V2_MAX)가 없다 — 배점이 코드 곳곳에 흩어지면 또 갈린다');
  const max = {};
  for (const kv of m[1].split(',')) {
    const [k, v] = kv.split(':').map(x => x.trim());
    if (k) max[k] = Number(v);
  }
  assert.equal(Object.values(max).reduce((a, b) => a + b, 0), 100, '배점 합이 100 이 아니다');
  assert.equal(max['교통'], 28, '교통 배점이 28 이 아니다');
  assert.ok(max['교통'] > max['거래'], '교통이 거래량보다 작다 — 운영자 우선순위와 반대다');
  assert.ok(max['인프라'] >= 16, '생활 인프라 배점이 16 미만이다');
  // SCORE-V3-2026-08-30: 운영자 보고서 리뷰로 추가된 두 축.
  assert.ok(max['관심도'] >= 10,
    '장기 검색 관심도 배점이 없다 — 운영자가 "1년·3년 오래 검색되는 곳" 을 요구했다');

  // ②-0 거래는 **절대 건수가 아니라 세대수 대비 회전율**로 판정한다.
  //   [실측 결함] 푸른마을포스코더샵2차는 43건으로 건수 1위였지만 1,226세대라 회전율 3.51% 로 4위였다
  //   (서동탄역파크자이 6.42% · 동탄파크푸르지오 5.81% · 자연앤데시앙 4.42%).
  //   구간은 전국 분위수 실측(6개월·100세대 이상 2,981단지): p25 1.25 · p50 2.03 · p75 3.02 · p90 4.11.
  const bands = require('../utils/scoreBands');
  const hi = bands.turnoverScore(63, 982, 14);   // 6.42% — 상위 10%
  const lo = bands.turnoverScore(43, 1226, 14);  // 3.51% — 상위 25% 언저리
  assert.ok(hi.score > lo.score,
    '회전율 6.42% 가 3.51% 보다 높은 점수를 받지 않는다');
  assert.ok(lo.turnover > 3 && lo.turnover < 4, '회전율 계산이 세대수 대비가 아니다');
  // ⚠ 건수만 크고 세대수도 큰 단지가 이기면 안 된다 — 이 저장소가 실제로 겪은 결함이다.
  assert.ok(bands.turnoverScore(43, 1226, 14).score < bands.turnoverScore(20, 300, 14).score,
    '대단지의 큰 건수가 소단지의 높은 회전율을 이긴다 — 정규화가 안 된 것이다');
  // 세대수를 모를 때 0 점으로 떨어뜨리지 않는다.
  assert.ok(bands.turnoverScore(3, 0, 14).score > 0,
    '세대수 미확인 단지가 거래 0점을 받는다 — 모름은 나쁨이 아니다');
  assert.equal(bands.turnoverScore(3, 0, 14).turnover, null, '모름인데 회전율 숫자를 지어낸다');

  // ②-0-1 ⚠ **두 화면이 같은 구간을 쓴다.** 점수표가 두 벌이면 한쪽만 고쳐지고 갈린다
  //   ([[tax-law-crosscheck-2026-06-24]]: 취득세 tier 사본 2개로 3주간 과다 표기).
  const rpt = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../routes/report.js'), 'utf8');
  for (const [file, src] of [['propertyService', svc], ['report', rpt]]) {
    assert.match(src, /require\('\.\.\/utils\/scoreBands'\)/,
      `${file} 가 공유 구간 모듈을 쓰지 않는다 — 사본이 갈린다`);
  }
  assert.ok(!/tr >= 4\.11 \?/.test(svc) && !/tr >= 4\.11 \?/.test(rpt),
    '회전율 구간 숫자가 소비자 쪽에 복제돼 있다 — scoreBands 한 곳에만 두라');

  // ②-1 아파트가 아닌 유형은 추천에서 뺀다. ⚠ 단, **모름은 빼지 않는다**.
  assert.ok(bands.isExcludedAptType('도시형 생활주택(아파트)'), '도시형생활주택이 제외되지 않는다');
  assert.ok(!bands.isExcludedAptType('주상복합'),
    '주상복합까지 제외한다 — 1,261곳이고 오피스텔과 동의어가 아니다(근거 없는 배제)');
  assert.ok(!bands.isExcludedAptType(''), '유형 미상(331곳)이 통째로 제외된다');

  // ②-2 신고가 갱신은 **평형별**로 센다.
  //   [실측] 평형을 섞으면 큰 평형이 최고가를 찍은 뒤 소형 신고가가 영영 안 세진다 —
  //   푸른마을포스코더샵2차: 혼합 4회 ↔ 평형별 18회(과대가 아니라 과소였다).
  const nh = bands.countNewHighByArea([
    { date: '2026-01', amount: 50000, area: 76 },
    { date: '2026-02', amount: 90000, area: 117 },
    { date: '2026-03', amount: 60000, area: 76 },
  ]);
  assert.equal(nh, 1, '평형을 섞어 세면 76㎡ 의 신고가 갱신이 사라진다');

  // ② 지하철 접근성은 **잰 거리(1순위)** 로 매기고, KAPT 자기신고값은 **폴백**이다.
  //    TRANSIT-TRUTH-2026-08-30 실측(좌표 보유 2,778 단지, 카카오 최근접역):
  //      신고 밴드와 일치 42.6% · 두 칸 이상 어긋남 15.8%(413곳) · 과대신고 347곳.
  //      운영자 확인 사례: 동탄파크한양수자인 신고 "10~15분" ↔ 네이버 도보 3.3km / 52분.
  //    ⇒ 신고값은 **만점을 받을 수 없다**(잰 값보다 상한이 낮아야 한다).
  const distMap = svc.match(/d <= 250 \? (\d+) : d <= 450 \? (\d+) : d <= 650 \? (\d+) : d <= 900 \? (\d+) : d <= 1400 \? (\d+) : d <= 2500 \? (\d+) : (\d+)/);
  assert.ok(distMap, '최근접 역까지 **잰 거리**로 교통 점수를 매기지 않는다 — 신고값만 믿으면 안 된다');
  const dPts = distMap.slice(1, 8).map(Number);
  assert.equal(dPts[0], max['교통'], '역 250m 이내가 교통 만점이 아니다');
  for (let i = 1; i < dPts.length; i++) {
    assert.ok(dPts[i] < dPts[i - 1], `거리가 멀어졌는데 점수가 줄지 않는다(${dPts[i - 1]} → ${dPts[i]})`);
  }

  //    신고 밴드 5단계도 전부 쓰되(버리지 않는다), 상한은 잰 값보다 낮다.
  const bandMap = svc.match(/\{ LE5: (\d+), M5_10: (\d+), M10_15: (\d+), M15_20: (\d+), GT20: (\d+) \}/);
  assert.ok(bandMap, '지하철 도보 5단계 → 점수 표가 없다 — KAPT 가 5단계로 주는데 버리고 있다');
  const pts = bandMap.slice(1, 6).map(Number);
  assert.ok(pts[0] < max['교통'],
    '자기신고 "5분이내" 가 교통 만점을 받는다 — 검증된 값과 신고값이 같은 대접을 받으면 안 된다');
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i] < pts[i - 1], `도보 시간이 늘었는데 점수가 줄지 않는다(${pts[i - 1]} → ${pts[i]})`);
  }

  //    ⚠ '역 없음'(관측된 사실) 과 '조회 실패'(모름) 를 섞으면 안 된다.
  assert.match(svc, /nearM === null/,
    '반경 내 역 없음을 별도로 다루지 않는다 — 조회 실패와 섞이면 멀쩡한 단지가 최저점을 받는다');

  // ③ ⚠ 모르는 것은 **0점이 아니라 중간값**. 도보시간 미보유가 전국 26% 다 —
  //    0 처리하면 데이터 없는 단지가 부당하게 밀린다([[unknown-treated-as-value]]).
  assert.match(svc, /교통 === null\) \{ 교통 = 15;/,
    '교통 정보가 없을 때 0점을 준다 — 모름을 나쁨으로 만들면 안 된다');
  // ⚠ NULL-NOT-ZERO-2026-08-30: 카카오 조회 **실패**(null)를 0 으로 읽으면
  //   "주변에 병원이 없다" 는 사실 주장이 된다. 실제로 키워드 검색 size 상한(15)에 45 를 넘겨
  //   전건 400 이 떨어졌고, 화면엔 "종합병원 0" 이 점수엔 0점이 찍혔다(런타임 로그 실측).
  //   → 아는 항목만으로 채점해 만점으로 환산하고, 하나도 모르면 중간값.
  assert.match(svc, /const known = parts\.filter\(p => p\.v !== null/,
    '인프라가 모르는 항목을 0 으로 섞어 계산한다');
  assert.match(svc, /인프라 = Math\.round\(SCORE_V2_MAX\.인프라 \* 0\.5\)/,
    '인프라를 하나도 모를 때 0점을 준다');
  const kakao = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../services/kakaoService.js'), 'utf8');
  assert.ok(!/size: (?:[2-9]\d|1[6-9])/.test(kakao),
    '카카오 검색 size 가 상한(15)을 넘는다 — 400 이 떨어지고 결과가 전부 0 이 된다');

  // ④ 점수 근거(breakdown·why)를 함께 내보낸다 — "왜 이 순서인가" 가 보여야 신뢰가 생긴다.
  assert.ok(/scoreBreakdown: _sc\.breakdown/.test(svc), '점수 근거(breakdown)를 응답에 싣지 않는다');
  assert.ok(/scoreWhy: _sc\.why/.test(svc), '점수 근거 문구(why)를 응답에 싣지 않는다');

  // ⑤ 최종 순서가 **화면에 보이는 점수** 로 정해진다(거래량 정렬이 아니다).
  assert.match(svc, /order\.sort\(\(a, b\) => \(Number\(b\.rec\?\.score\)/,
    '최종 정렬이 표시 점수 기준이 아니다 — 98점이 3위, 69점이 1위이던 그 상태로 돌아간다');

  // ⑥ ⚠ 재정렬 시 coords·schoolsArr 도 함께 옮긴다 —
  //    downstream 이 인덱스 대응을 전제하므로 하나만 정렬하면 마커가 다른 단지에 찍힌다.
  assert.match(svc, /coords\[i\] = order\[i\]\.coord; schoolsArr\[i\] = order\[i\]\.school;/,
    '재정렬이 좌표·학군을 함께 옮기지 않는다 — 마커가 다른 단지 위치에 찍힌다');
});

// ── NOTICE-HONEST-2026-08-30 (Sprint OOOOOOO) ─────────────────────────────────
// [무엇이 있었나 — 전수조사 847건에서 발각] "조건에 맞는 단지 없음" 을 화면에
//   **"데이터 일시 조회 실패"** 라고 적고 있었다. 대형(전용 34평+) 조건에서 안내카드가 나온
//   5곳(종로·과천·구리·군포·동두천)은 전부 조회가 **성공**했고(분석 단지 70·16·134·154·62곳)
//   매칭만 0이었다. 틀린 원인을 알려주면 사용자는 "잠시 후 재시도" 를 반복하다 서비스를 불신한다 —
//   실제로 필요한 행동은 조건을 바꾸는 것이다.
test('안내 문구가 원인을 구분한다 — 조회 실패 vs 조건 미매칭', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../services/propertyService.js'), 'utf8');

  // ① 두 분기가 서로 다른 생성기를 쓴다(같은 문구를 재사용하면 다시 갈린다).
  assert.match(src, /if \(!analyzed \|\| !analyzed\.length\) \{[\s\S]{0,200}getStaticFallback/,
    '진짜 조회 실패 분기가 getStaticFallback 을 쓰지 않는다');
  assert.match(src, /if \(!matched\.length\) \{[\s\S]{0,400}getNoMatchNotice/,
    '조건 미매칭 분기가 여전히 "조회 실패" 문구를 쓴다 — 사용자에게 틀린 원인을 알려준다');

  // ② 조건 미매칭 안내는 실패라고 말하지 않는다.
  const noMatch = src.slice(src.indexOf('function getNoMatchNotice'),
    src.indexOf('function getStaticFallback'));
  assert.ok(!/조회 실패|API 응답 없음/.test(noMatch),
    '조건 미매칭 안내에 "조회 실패" 표현이 남아 있다');
  assert.ok(/_reason: 'no-match'/.test(noMatch),
    '프론트가 두 안내를 구분할 수 있는 플래그가 없다');
  assert.ok(/_notice: true/.test(noMatch),
    '_notice 플래그가 없다 — 프론트가 이 항목을 단지 1건으로 세어 "1건" 이라고 표시한다');

  // ③ 진짜 조회 실패 안내는 종전대로 실패라고 말한다(반대 방향 회귀 방지).
  const staticFb = src.slice(src.indexOf('function getStaticFallback'));
  assert.ok(/조회 실패/.test(staticFb), '진짜 실패 안내에서 실패 표현이 사라졌다');
});

// ── MULTI-REGION-2026-08-30 (Sprint OOOOOOO) ──────────────────────────────────
// 운영자: "화성시 동탄·만세구·병점구·효행구 이런식으로 복수 선택이 되면 좋겠다."
//   실제 생활권은 행정구 경계와 일치하지 않는다 — 화성시가 4개 구로 갈리면서 한 도시를 보려면
//   네 번 검색해야 했다. 복수 선택은 그 자체가 기능이지만, **조용히 잘리면** 더 나쁘다
//   (4개 골랐는데 3개만 분석하고 아무 말도 안 하는 것).
test('복수 지역 선택 — 화이트리스트·중복제거·상한을 지키고 조용히 자르지 않는다', () => {
  const { pickRegions } = require('../services/propertyService');

  // ① 고른 만큼 그대로 돌려준다(화성 4개 구).
  const four = pickRegions('경기', 6, '', '41597,41591,41593,41595');
  assert.deepEqual(four.map(r => r.lawdCd), ['41597', '41591', '41593', '41595'],
    '복수 선택이 조용히 잘렸다 — 사용자가 고른 지역이 분석에서 빠진다');
  // name 이 광역 이름이면 보고서가 "해석 실패"로 보고 광역으로 내려간다.
  assert.ok(!four.some(r => ['서울', '경기', '인천', '지방'].includes(r.name)),
    'name 이 광역 이름이다 — 보고서 경로가 지역 해석 실패로 처리한다');

  // ② 중복은 제거하고, LAWD_CODES 에 없는 코드는 버린다(임의 코드로 조회를 열지 않는다).
  const dedup = pickRegions('경기', 6, '', '41597,41597,99999,41595');
  assert.deepEqual(dedup.map(r => r.lawdCd), ['41597', '41595'],
    '중복 제거 또는 화이트리스트 검증이 동작하지 않는다');

  // ③ 상한 6 — 지역 수만큼 실거래·단지목록 조회가 늘어 무제한이면 타임아웃.
  const many = pickRegions('서울', 9, '', '11110,11140,11170,11200,11215,11230,11260');
  assert.equal(many.length, 6, '복수 선택 상한(6)이 지켜지지 않는다');

  // ④ 단일 선택은 종전과 동일(회귀 방지).
  assert.deepEqual(pickRegions('경기', 6, '', '41597').map(r => r.lawdCd), ['41597']);

  // ⑤ 코드가 하나도 유효하지 않으면 문자열 해석으로 내려간다(빈 결과를 돌려주지 않는다).
  const fallback = pickRegions('경기 분당', 9, '', '99999,88888');
  assert.ok(fallback.length > 0, '유효 코드가 없을 때 빈 배열을 돌려준다 — 검색이 통째로 죽는다');
  assert.equal(fallback[0].lawdCd, '41135', '문자열 폴백이 분당을 해석하지 못한다');
});

// 프론트 칩이 실제로 다중 선택을 보내는지 — 백엔드만 고치고 프론트가 단일이면 기능이 없는 것과 같다.
test('프론트 지역 칩이 다중 선택을 보낸다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  // getRegionLawdCd 가 **모든** 선택 칩을 모아 콤마로 잇는다(querySelector 단건이 아니다).
  assert.match(html, /function getRegionLawdCd\(\)\{[\s\S]{0,240}querySelectorAll\('#ch-r-sub \.chip\.on'\)/,
    'getRegionLawdCd 가 칩 하나만 읽는다 — 복수 선택이 백엔드에 전달되지 않는다');
  assert.match(html, /getRegionLawdCd\(\)[\s\S]{0,80}join\(','\)|join\(','\)/,
    '선택된 코드를 콤마로 잇지 않는다');
  // cpSub 가 형제 칩을 전부 끄지 않는다(단일 선택 강제 제거).
  assert.doesNotMatch(html, /function cpSub\(el\)\{[\s\S]{0,200}parentNode\.querySelectorAll\('\.chip'\)\.forEach\(c=>c\.classList\.remove\('on'\)\)/,
    'cpSub 가 여전히 단일 선택을 강제한다');
});

// ── JIBUN-MATCH-2026-08-30 (Sprint OOOOOOO) ───────────────────────────────────
// [무엇이 있었나] 군포 4.4억 무필터 결과 15곳이 **전부 500세대 이상**인데 500세대+ 필터는 0건이었다.
//   MOLIT 거래명과 KAPT 등록명은 접두·어순이 달라("충무주공(872)" ↔ 산본주공충무1) 이름으로는 안 붙는다.
//   전국 실측: 이름 정확일치 2,588/16,466(15.7%) vs 동+지번 본번 10,104(61.4%).
// [왜 테스트로 묶나] 지번 매칭은 **오매칭 시 남의 단지 세대수·주차를 카드에 띄운다**. 한 필지에
//   여러 KAPT 단지가 있는 경우가 전국 지번키의 6.9% 라, 모호할 때 포기하는지를 기계로 못박는다.
test('지번 매칭 — 유일할 때만 채택하고 모호하면 포기한다', () => {
  const { buildJibunIndex, lookupByJibun } = require('../services/propertyService');

  const idx = buildJibunIndex([
    { kaptCode: 'A1', kaptName: '산본주공충무1', as3: '금정동', jibunBon: '849', kaptUsedate: '19920101' },
    { kaptCode: 'B1', kaptName: '한필지단지A',   as3: '겹친동', jibunBon: '100', kaptUsedate: '19900101' },
    { kaptCode: 'B2', kaptName: '한필지단지B',   as3: '겹친동', jibunBon: '100', kaptUsedate: '20150101' },
    { kaptCode: 'C1', kaptName: '연도같은A',     as3: '연도동', jibunBon: '200', kaptUsedate: '20100101' },
    { kaptCode: 'C2', kaptName: '연도같은B',     as3: '연도동', jibunBon: '200', kaptUsedate: '20100101' },
    { kaptCode: 'D1', kaptName: '지번없음',      as3: '없음동', jibunBon: '',    kaptUsedate: '20000101' },
  ]);

  // ① 이름이 완전히 달라도 동+본번이 유일하면 붙는다 — 이 기능의 존재 이유.
  assert.equal(lookupByJibun(idx, { umdNm: '금정동', jibun: '849', buildYear: 1992 }), 'A1',
    '동+본번이 유일한데도 매칭되지 않는다');
  // 부번이 달라도 본번이 같으면 같은 단지다(대단지는 필지가 여러 개).
  assert.equal(lookupByJibun(idx, { umdNm: '금정동', jibun: '849-3', buildYear: 1992 }), 'A1',
    '부번 차이로 매칭이 깨진다 — 본번까지만 비교해야 한다');

  // ② 한 필지에 여러 단지 → 준공연도가 유일하게 맞을 때만 채택.
  assert.equal(lookupByJibun(idx, { umdNm: '겹친동', jibun: '100', buildYear: 2015 }), 'B2',
    '연도로 가려낼 수 있는데 포기했다');
  assert.equal(lookupByJibun(idx, { umdNm: '겹친동', jibun: '100', buildYear: 1990 }), 'B1',
    '연도로 가려낼 수 있는데 포기했다');

  // ③ ⚠ 연도로도 못 가르면 **포기**해야 한다 — 여기서 아무거나 고르면 남의 단지 정보가 카드에 실린다.
  assert.equal(lookupByJibun(idx, { umdNm: '연도동', jibun: '200', buildYear: 2010 }), null,
    '모호한데도 하나를 골랐다 — 오매칭으로 남의 세대수·주차가 표시된다');
  assert.equal(lookupByJibun(idx, { umdNm: '겹친동', jibun: '100', buildYear: 0 }), null,
    '실거래 준공연도를 모르는데 중복 필지에서 하나를 골랐다');

  // ⑤ EUPMYEON-FALLBACK-2026-08-30: 군(郡)·읍면은 표기 단위가 다르다 —
  //    MOLIT "와부읍 덕소리"(읍/면+리) vs KAPT "와부읍"(읍/면 단독). 동등 비교는 전건 실패한다.
  //    [실측] 이 폴백만으로 거래 매칭률 76.3% → 81.3% (846단지·9,144거래 추가).
  //    ⚠ 지번 본번까지 함께 맞아야 채택되므로 읍/면으로 넓혀도 오매칭 위험은 커지지 않는다.
  {
    const idx2 = buildJibunIndex([
      { kaptCode: 'E1', kaptName: '덕소한강', as3: '와부읍', jibunBon: '410', kaptUsedate: '20050101' },
      { kaptCode: 'E2', kaptName: '다른읍단지', as3: '오남읍', jibunBon: '410', kaptUsedate: '20050101' },
    ]);
    assert.equal(lookupByJibun(idx2, { umdNm: '와부읍 덕소리', jibun: '410-2', buildYear: 2005 }), 'E1',
      '읍/면+리 표기가 읍/면 단독 등록과 매칭되지 않는다 — 군 지역이 통째로 빠진다');
    // 읍/면이 다르면 본번이 같아도 붙으면 안 된다(다른 읍의 같은 번지는 다른 땅이다).
    assert.equal(lookupByJibun(idx2, { umdNm: '진접읍 금곡리', jibun: '410', buildYear: 2005 }), null,
      '다른 읍/면인데 본번만 같다고 매칭했다 — 남의 단지 정보가 붙는다');
    // 공백 없는 일반 동은 폴백을 타지 않는다(기존 동작 불변).
    assert.equal(lookupByJibun(idx2, { umdNm: '와부읍', jibun: '410', buildYear: 2005 }), 'E1');
  }

  // ④ 입력이 없으면 조용히 null (예외 금지)
  assert.equal(lookupByJibun(idx, { umdNm: '금정동', jibun: '', buildYear: 1992 }), null);
  assert.equal(lookupByJibun(idx, { umdNm: '', jibun: '849', buildYear: 1992 }), null);
  assert.equal(lookupByJibun(idx, { umdNm: '없음동', jibun: '999', buildYear: 2000 }), null);
  assert.equal(lookupByJibun(new Map(), { umdNm: '금정동', jibun: '849' }), null);

  // ⑤ 지번 없는 KAPT 행은 색인에 들어가지 않는다(빈 키로 오매칭 방지)
  assert.ok(!idx.has('없음동|'), '지번 없는 행이 색인에 들어갔다');
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
    // MENU-EMPTY-2026-08-30: 운영 환경에서는 **실거래 0건 시군구**(실측: 인천 옹진군 하나)를 뺀다.
    //   테스트 환경엔 DB 자격증명이 없어 그 조회가 실패하고 **fail-open**(전체 노출)으로 떨어진다 —
    //   즉 여기서 검증되는 것은 "열화 시에도 목록이 비지 않는다" 이고, 그게 이 가드의 목적이다.
    //   목록을 조용히 비우는 사고는 이미 겪었다([[degraded-response-cached-at-edge]]).
    assert.equal(j.filtered, false, "DB 없이도 filtered=true 면 fail-open 이 깨진 것이다");
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

// ── BR-PRESERVE-BEHAVIORAL-2026-09-02 (감사 후속: 테스트 행위화) ─────────────
//   [왜] backfillFacilityByKaptCode 는 facility 를 **통째로 교체**한다. 건축물대장 보강값(`_br`)을
//     살려두지 않으면 empty 재시도(14일 주기)마다 세대수가 지워져 "채웠는데 며칠 뒤 다시 미상" 이
//     되고, 원인을 사후에 찾기가 대단히 어렵다.
//   [무엇이 바뀌었나] 종전에는 소스에서 `_empty: true, _br: prevBr` 같은 **문자열 모양**을 봤다.
//     그건 리팩터링 한 번이면 의미 없이 깨지고, 반대로 모양이 남아도 앞단 분기가 바뀌면 통과한다.
//     이제 함수를 **실제로 실행**해 DB 에 쓰려던 payload 를 그대로 확인한다.
//     외부 의존은 require.cache 스텁으로 끊는다(이 파일의 결제 테스트와 같은 방식).
test('_br 보존 — 백필을 실제로 실행해 건축물대장 값이 payload 에 남는지 확인한다', async () => {
  const facPath = require.resolve('../services/aptFacilityService');
  const clientPath = require.resolve('../db/client');
  const dgkPath = require.resolve('../services/dataGoKrClient');
  const aptInfoPath = require.resolve('../services/aptInfoService');

  // apt_master 한 행만 흉내내는 최소 목 — update 로 넘어온 payload 를 기록한다
  const makeAdmin = (prevFacility) => {
    const seen = { updates: [], tables: [], selects: [] };
    const upChain = (patch) => {
      // 실패 sentinel 경로가 `.then(()=>{},()=>{})` 로 호출하므로 thenable 이어야 한다
      const c = { eq: () => c, then: (r, j) => Promise.resolve({ error: null }).then(r, j) };
      seen.updates.push(patch);
      return c;
    };
    const mk = () => {
      const s = {
        select: (c) => { seen.selects.push(String(c)); return s; },
        eq: () => s,
        maybeSingle: async () => ({ data: prevFacility === undefined ? null : { facility: prevFacility }, error: null }),
        update: upChain,
      };
      return s;
    };
    return { client: { from: (tb) => { seen.tables.push(tb); return mk(); } }, seen };
  };

  const run = async ({ prevFacility, apiOk, detail }) => {
    const paths = [facPath, clientPath, dgkPath, aptInfoPath];
    const saved = {};
    for (const q of paths) saved[q] = require.cache[q];
    const savedKey = process.env.APT_INFO_API_KEY;
    const { client, seen } = makeAdmin(prevFacility);
    const stub = (q, exp) => { require.cache[q] = { id: q, filename: q, loaded: true, exports: exp }; };
    stub(clientPath, { getSupabaseAdmin: () => client });
    stub(dgkPath, { get: async () => {
      if (!apiOk) throw new Error('네트워크 없음');
      return { data: { response: { header: { resultCode: '00' },
        body: { item: { kaptName: '테스트단지', kaptCode: 'A1', kaptdaCnt: 500 } } } } };
    } });
    stub(aptInfoPath, { getAptListBySgg: async () => [], getAptDtlInfo: async () => detail || null });
    // APT_INFO_KEY 는 모듈 로드 시 상수라 env 를 먼저 세우고 다시 require 해야 한다
    process.env.APT_INFO_API_KEY = 'xxxxxxxx-test-only';
    delete require.cache[facPath];
    try {
      const { backfillFacilityByKaptCode } = require(facPath);
      const res = await backfillFacilityByKaptCode('A1');
      return { res, updates: seen.updates, selects: seen.selects };
    } finally {
      for (const q of paths) { if (saved[q]) require.cache[q] = saved[q]; else delete require.cache[q]; }
      if (savedKey === undefined) delete process.env.APT_INFO_API_KEY;
      else process.env.APT_INFO_API_KEY = savedKey;
    }
  };

  const BR = { hhldCnt: 300, src: 'building_register' };

  // ① KAPT 실패 → 실패 sentinel 을 쓰는데, 여기서 _br 을 버리면 안 된다
  //   (주석이 지적하듯 **오히려 이쪽이** 건축물대장 값이 꼭 필요한 단지다)
  const a = await run({ prevFacility: { _br: BR, kaptName: '옛값' }, apiOk: false });
  assert.equal(a.res.reason, 'no-basisinfo', 'KAPT 실패 경로를 타지 않았다 — 스텁이 안 먹었다');
  assert.equal(a.updates.length, 1, 'sentinel 을 한 번 써야 한다');
  assert.equal(a.updates[0].facility._empty, true, 'sentinel 표식이 없다 — 무한 재시도로 돌아간다');
  assert.deepEqual(a.updates[0].facility._br, BR,
    '실패 sentinel 이 건축물대장 값을 지웠다 — 14일 주기 재시도마다 세대수가 미상으로 되돌아간다');
  assert.ok(a.selects.includes('facility'), '기존 facility 를 읽지 않으면 애초에 보존할 수 없다');

  // ② KAPT 성공 → 새 값으로 갈아끼우되 _br 은 남긴다 (buildFacility 가 3순위로 쓴다)
  const b = await run({ prevFacility: { _br: BR }, apiOk: true, detail: { kaptdPcnt: 400 } });
  assert.equal(b.res.ok, true, 'KAPT 성공 경로가 실패했다');
  assert.deepEqual(b.updates[0].facility._br, BR, '성공 경로가 건축물대장 값을 지웠다');
  assert.deepEqual(b.updates[0].facility._dtl, { kaptdPcnt: 400 }, '상세정보가 병합되지 않았다');
  assert.equal(b.updates[0].facility.kaptName, '테스트단지', 'KAPT 응답이 반영되지 않았다');

  // ③ 보존할 값이 없으면 _br 키를 만들지 않는다 (없는 값을 지어내지 않는다)
  const c = await run({ prevFacility: { kaptName: '옛값' }, apiOk: false });
  assert.deepEqual(c.updates[0].facility, { _empty: true }, '보존할 _br 이 없는데 키가 생겼다');

  // ④ 기존 행이 아예 없어도 죽지 않고 정상 저장한다
  const d = await run({ prevFacility: undefined, apiOk: true, detail: null });
  assert.equal(d.res.ok, true, '기존 행이 없을 때 백필이 실패한다');
  assert.equal('_br' in d.updates[0].facility, false, '없던 _br 이 생겼다');
});

// ── CRON-MISS-2026-08-17 (Sprint MMMMMMM-24) ──────────────────────────────────
// Vercel 공식 문서로 확정한 사실: cron 전달은 best effort 라 회차가 통째로 누락될 수 있고,
// 그때 런타임 로그조차 안 남으며, 실패해도 재시도하지 않는다. 따라서 알림 job 은
// "한 회차 걸러도 다음 회차가 따라잡는" 창을 가져야 한다. 그 창을 여기서 고정한다.
// ── PUSH-WINDOW-BEHAVIORAL-2026-09-02 (감사 후속: 테스트 행위화) ─────────────
//   [왜] 알림 조회 창이 좁아지면 사용자는 관심단지 거래를 놓치고, **놓쳤다는 사실조차 모른다**.
//     종전 테스트는 소스에서 `NOTIFY_FLOOR_MS = 72 * 3600 * 1000` 이라는 **글자**를 봤다.
//     상수가 그대로여도 뒤에서 floorTs 를 덮어쓰면 통과하고, 상수를 다른 식으로 쓰면(예: 3일)
//     동작이 같은데도 실패한다 — 둘 다 틀린 신호다.
//   [무엇이 바뀌었나] run() 을 실제로 실행하고, 조회에 넘어간 `gte(ingested_at, ...)` 값을
//     관측해 **계산된 창**을 확인한다. 외부 의존은 require.cache 스텁으로 끊는다.
//     (web-push 는 VAPID env 가 있을 때만 지연 로드되므로 스텁이 필요 없다 — 발송은 일어나지 않는다)
test('pushNotify — 조회 창을 실제로 계산시켜 확인한다 (72h 바닥 · 워터마크 · 정렬)', async () => {
  const jobPath = require.resolve('../jobs/pushNotify');
  const clientPath = require.resolve('../db/client');
  const txPath = require.resolve('../services/transactionService');
  const kakaoPath = require.resolve('../services/kakaoMemoService');

  const makeAdmin = (pushRows) => {
    const seen = { gte: [], order: [], tables: [] };
    const mk = (table) => {
      const s = {
        select: () => s,
        limit: async () => ({ data: table === 'push_subscriptions' ? pushRows : [], error: null }),
        in: () => s,
        gte: (col, val) => { seen.gte.push([col, val]); return s; },
        order: (col, opt) => { seen.order.push([col, opt && opt.ascending]); return s; },
        range: async () => ({ data: [], error: null }),   // 거래 0건 → 발송 경로는 타지 않는다
        update: () => ({ eq: async () => ({ error: null }), in: async () => ({ error: null }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      };
      return s;
    };
    return { client: { from: (tb) => { seen.tables.push(tb); return mk(tb); } }, seen };
  };

  const runJob = async (pushRows) => {
    const paths = [jobPath, clientPath, txPath, kakaoPath];
    const saved = {};
    for (const q of paths) saved[q] = require.cache[q];
    const { client, seen } = makeAdmin(pushRows);
    const stub = (q, exp) => { require.cache[q] = { id: q, filename: q, loaded: true, exports: exp }; };
    stub(clientPath, { getSupabaseAdmin: () => client });
    stub(txPath, { getAliasCanonicalMap: async () => new Map() });
    stub(kakaoPath, { isKakaoConfigured: () => false, sendKakaoMemo: async () => ({}), refreshKakaoToken: async () => null });
    delete require.cache[jobPath];
    try {
      const { run } = require(jobPath);
      const res = await run();
      return { res, seen };
    } finally {
      for (const q of paths) { if (saved[q]) require.cache[q] = saved[q]; else delete require.cache[q]; }
    }
  };

  const H = 3600 * 1000;
  const now = Date.now();
  const sub = (id, agoMs) => ({
    id, endpoint: 'https://example.invalid/' + id, p256dh: 'k', auth: 'a', fail_count: 0,
    items: [{ lawdCd: '11680', name: '테스트단지' }],
    last_notified_at: agoMs == null ? null : new Date(now - agoMs).toISOString(),
  });
  const windowH = (seen) => {
    const g = seen.gte.find(([c]) => c === 'ingested_at');
    assert.ok(g, '거래 조회에 ingested_at 하한이 없다 — 창 자체가 사라졌다');
    return (now - new Date(g[1]).getTime()) / H;
  };

  // ① 워터마크가 없으면 바닥까지 훑는다. 72h = cron 2회 연속 누락 내성
  //    (Vercel cron 은 best effort 라 회차가 통째로 빠질 수 있고 재시도도 없다).
  const a = await runJob([sub(1, null)]);
  assert.ok(Math.abs(windowH(a.seen) - 72) < 0.2,
    `조회 창이 72h 가 아니다(${windowH(a.seen).toFixed(1)}h) — cron 이 이틀 연속 누락되면 그 사이 거래가 영구히 안 나간다`);

  // ② 모두 최근에 받았으면 가장 오래된 워터마크까지만 — 매번 72h 를 재훑지 않는다
  const b = await runJob([sub(1, 10 * H), sub(2, 20 * H)]);
  assert.ok(Math.abs(windowH(b.seen) - 20) < 0.2,
    `가장 오래된 워터마크(20h)를 따르지 않는다(${windowH(b.seen).toFixed(1)}h)`);

  // ③ 아주 오래 못 받은 구독이 있어도 바닥에서 멈춘다 — 전수 재훑기로 번지지 않는다
  const c = await runJob([sub(1, 200 * H), sub(2, 5 * H)]);
  assert.ok(Math.abs(windowH(c.seen) - 72) < 0.2,
    `오래된 워터마크가 바닥을 넘어 확장됐다(${windowH(c.seen).toFixed(1)}h)`);

  // ④ 정렬은 **내림차순**이어야 한다. 안전캡(5,000행)에 걸릴 때 오름차순이면 최신이 잘린다 —
  //    "새 실거래 알림" 에서 최신을 버리는 것은 정확히 반대 동작이다. 2차 키(id)도 같은 방향.
  assert.deepEqual(a.seen.order, [['ingested_at', false], ['id', false]],
    '거래 조회 정렬이 바뀌었다 — 오름차순이면 캡에 걸릴 때 최신 거래가 잘린다');

  // ⑤ 발송 게이트가 꺼진 상태에서도 죽지 않고 이유를 밝힌다(관측 가능해야 한다)
  assert.equal(a.res.webGate, 'off(VAPID/pkg)', '웹푸시 게이트 상태를 보고하지 않는다');
  assert.equal(a.res.kakaoGate, 'off(env)', '카카오 게이트 상태를 보고하지 않는다');

  // ⑥ 캡·상한에 닿으면 침묵하지 않는다 — 조용히 잘리면 건수가 틀린 채로 발송된다.
  //    (경고 자체는 로그 경로라 소스로 확인한다)
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../jobs/pushNotify.js'), 'utf8');
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

// ── STATIC-SEC-HEADERS-2026-09-02 (감사 P0-3) ────────────────────────────────
//   [왜] vercel.json 상 `/`·`/billing`·법적 페이지는 Express 를 거치지 않아 helmet 이 붙지 않는다.
//     그래서 같은 index.html 인데 **루트에만** CSP·X-Frame-Options 가 없었다(라이브 헤더 실측).
//     헤더를 vercel.json 에 복제해 해결했는데, 복제는 곧 **드리프트 위험**이다 —
//     server.js CSP 에 외부 호스트를 추가하고 vercel.json 을 잊으면 정적 경로에서만 조용히 차단된다.
//   [무엇을 고정하나] server.js helmet CSP 에 등장하는 모든 외부 출처가
//     vercel.json 의 정적 라우트 CSP 에도 존재해야 한다(부분집합 관계).
test('보안 헤더: vercel.json 정적 라우트 CSP 가 server.js helmet CSP 의 상위집합이다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const vercel = JSON.parse(fs2.readFileSync(path2.join(__dirname, '../../vercel.json'), 'utf8'));
  const srv = fs2.readFileSync(path2.join(__dirname, '../server.js'), 'utf8');

  // helmet CSP 블록만 잘라낸다 (다른 곳의 URL 문자열을 섞지 않기 위해)
  const from = srv.indexOf('contentSecurityPolicy');
  const to = srv.indexOf('crossOriginEmbedderPolicy');
  assert.ok(from > 0 && to > from, 'server.js 에서 helmet CSP 블록을 찾지 못했다 — 테스트를 갱신할 것');
  const block = srv.slice(from, to);
  const hosts = [...new Set((block.match(/'(?:https|wss):\/\/[^']+'/g) || []).map(s => s.slice(1, -1)))];
  assert.ok(hosts.length >= 10, `helmet CSP 호스트 추출 실패(${hosts.length}건) — 정규식을 갱신할 것`);

  const staticRoutes = vercel.routes.filter(r => r.headers && (r.headers['Content-Security-Policy'] || r.headers['Content-Security-Policy-Report-Only']));
  assert.ok(staticRoutes.length >= 5, `정적 라우트 CSP 가 ${staticRoutes.length}개뿐이다 — 헤더가 빠졌다`);

  for (const r of staticRoutes) {
    const csp = r.headers['Content-Security-Policy'] || r.headers['Content-Security-Policy-Report-Only'];
    const missing = hosts.filter(h => csp.indexOf(h) < 0);
    assert.deepEqual(missing, [], `${r.src} CSP 에 server.js 의 호스트가 빠졌다: ${missing.join(', ')}`);
  }
});

test('보안 헤더: 모든 정적 라우트에 클릭재킹·MIME 방어 헤더가 붙는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const vercel = JSON.parse(fs2.readFileSync(path2.join(__dirname, '../../vercel.json'), 'utf8'));
  // Express 로 가는 라우트는 helmet 이 담당하므로 제외한다.
  const EXPRESS_DESTS = ['/api/index.js'];
  const staticHtml = vercel.routes.filter(r => typeof r.dest === 'string'
    && r.dest.indexOf('/frontend/') === 0 && r.dest.endsWith('.html'));
  assert.ok(staticHtml.length >= 5, `정적 HTML 라우트가 ${staticHtml.length}개 — 라우트 구조가 바뀌었다`);
  const bad = [];
  for (const r of staticHtml) {
    const h = r.headers || {};
    if (h['X-Frame-Options'] !== 'SAMEORIGIN') bad.push(r.src + ': X-Frame-Options');
    if (h['X-Content-Type-Options'] !== 'nosniff') bad.push(r.src + ': X-Content-Type-Options');
    if (!h['Referrer-Policy']) bad.push(r.src + ': Referrer-Policy');
    if (!h['Content-Security-Policy'] && !h['Content-Security-Policy-Report-Only']) bad.push(r.src + ': CSP');
  }
  assert.deepEqual(bad, [], `정적 HTML 라우트에 보안 헤더 누락:\n  ${bad.join('\n  ')}`);
  assert.ok(EXPRESS_DESTS.length === 1);
});

// ── SHARE-ZERO-2026-09-02 (감사 P0-5) ──────────────────────────────────────
//   [왜] `/share?apt=...` 로 들어온 신규 방문자에게 "현재 평균가 0.00억 · 가격 범위 0.0~0.0억" 이
//     떴다(라이브 실측). handleShareUrl 이 실거래 조회에 실패하면 **그냥 return** 해서
//     avgPrice:0 stub 이 화면에 남았고, 렌더러는 `(p.minPrice||0).toFixed(1)` 로 그 0 을 값으로 찍었다.
//     공유 링크는 첫인상이라 0 원 표기의 파급이 크다. [[unknown-treated-as-value]] 의 전형.
//   [무엇을 고정하나] "모름"을 0 으로 찍던 raw 패턴의 재유입과, 실패 경로의 조용한 return.
test('공유 링크: 가격 미확인 상태를 0 으로 표시하지 않는다 (raw 패턴 재유입 차단)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  // ① 유효성 게이트가 존재해야 한다 (avgPrice 가 0 이하면 숫자 대신 상태 문구)
  assert.ok(html.indexOf('!(Number(p.avgPrice) > 0)') >= 0,
    '가격 유효성 게이트가 사라졌다 — 0 원이 다시 값으로 표시된다');

  // ② 0 을 가격 범위로 찍던 raw 패턴이 돌아오면 실패
  const RAW_RANGE = '(p.minPrice||0).toFixed(1)}~${(p.maxPrice||0).toFixed(1)}억';
  assert.equal(html.indexOf(RAW_RANGE), -1, `0 원 가격범위 raw 패턴이 재유입됐다: ${RAW_RANGE}`);

  // ③ 공유 텍스트도 0 을 내보내면 안 된다
  assert.equal(html.indexOf('평균 ${(currentDetail.avgPrice||0).toFixed(2)}억'), -1,
    '외부 공유 문구가 다시 "평균 0.00억" 을 내보낸다');
});

test('공유 링크: 실거래 조회 실패 경로가 조용히 return 하지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  const from = html.indexOf('async function handleShareUrl()');
  assert.ok(from > 0, 'handleShareUrl 을 찾지 못했다 — 테스트를 갱신할 것');
  const body = html.slice(from, from + 3000);

  // 실패 3경로(지역 미해석·거래 0건·예외)가 전부 화면을 다시 그려야 한다
  assert.equal(body.indexOf('if(!lawdCd)return;'), -1, '지역 미해석 시 조용히 return 하고 있다');
  assert.equal(body.indexOf('if(!items.length)return;'), -1, '거래 0건일 때 조용히 return 하고 있다');
  assert.equal(body.indexOf('조용히 실패 — stub 유지'), -1, 'catch 가 여전히 조용히 삼킨다');
  // 호출 3곳(지역 미해석·거래 0건·예외). 정의는 `_reshow=` 라 이 정규식에 잡히지 않는다.
  const reshow = (body.match(/_reshow\(\{/g) || []).length;
  assert.ok(reshow >= 3, `실패 경로 재렌더가 ${reshow}회뿐 — 3경로 모두 다시 그려야 한다`);
  assert.ok(body.indexOf('const _reshow=') >= 0, '_reshow 헬퍼 정의가 사라졌다');
});

// ── NULL-NOT-ZERO-2026-09-02 (감사 P0-2) ─────────────────────────────────────
//   [왜] 카카오 주변시설 카운트가 **키 없음·예외 시 0** 을 돌려줬다. 소비자는 그 0 을
//     "반경 안에 0곳" 이라는 사실로 읽어 점수를 최저 밴드로 떨어뜨리고 화면에 "지하철역 0곳" 을 찍었다.
//     같은 병을 키워드 검색(countNearbyKeyword)은 2026-08-30 에 고쳤는데 카테고리 검색은 남아 있었고,
//     소비자(propertyService 인프라 채점)는 이미 "실패는 null" 을 전제로 하드닝돼 있어 **생산 함수만 어긋나** 있었다.
//   [함정] `Number(null) === 0` 이라 `Number.isFinite(Number(x))` 만으로는 null 이 그대로 통과한다.
//   [무엇을 고정하나] 실패는 null 이고, 채점은 아는 항목만으로 하며, null 이 0 점 취급되지 않는다.
test('주변시설: 카카오 키가 없으면 0 이 아니라 null(모름) 을 돌려준다', async () => {
  const kakao = require('../services/kakaoService');
  const saved = process.env.KAKAO_REST_API_KEY;
  delete process.env.KAKAO_REST_API_KEY;   // isKeyMissing 은 호출 시점에 env 를 읽는다 → 네트워크 없음
  try {
    assert.equal(await kakao.countNearby(37.5, 127.0, 'SC4', 1200), null,
      'countNearby 가 키 없음에 0 을 돌려준다 — "학교 0곳" 이라는 사실 주장이 된다');
    assert.equal(await kakao.countNearbyKeyword(37.5, 127.0, '종합병원', 2000), null,
      'countNearbyKeyword 가 키 없음에 0 을 돌려준다');
    const amen = await kakao.getNearbyAmenities(37.5, 127.0);
    assert.ok(amen && typeof amen === 'object', 'getNearbyAmenities 가 객체를 돌려줘야 한다');
    for (const k of ['school', 'mart', 'hospital', 'subway', 'cvs', 'park']) {
      assert.equal(amen[k], null, `amenities.${k} 가 null 이 아니다(${amen[k]}) — 모름이 값으로 샌다`);
    }
  } finally {
    if (saved === undefined) delete process.env.KAKAO_REST_API_KEY;
    else process.env.KAKAO_REST_API_KEY = saved;
  }
});

test('추천 점수: 주변시설 null 은 0 곳으로 채점되지 않는다 (Number(null)===0 함정)', () => {
  const { _applyFacilityToScore } = require('../services/propertyService');
  const base = { breakdown: {} };
  // 교통 근거가 하나도 없는 단지 — facility 신고값도 없다.
  const facility = {};
  const unknown = _applyFacilityToScore(base, facility, { school: null, mart: null, hospital: null, subway: null, cvs: null, park: null });
  const zero = _applyFacilityToScore(base, facility, { school: 0, mart: 0, hospital: 0, subway: 0, cvs: 0, park: 0 });

  // ① 모름(null)과 실제 0 곳은 **다른 점수**여야 한다. 같아지면 조회 실패가 최저점으로 둔갑한다.
  assert.notEqual(unknown.breakdown.교통, zero.breakdown.교통,
    `모름과 0곳이 같은 교통 점수(${unknown.breakdown.교통})다 — null 이 0 으로 읽히고 있다`);
  assert.ok(unknown.breakdown.교통 > zero.breakdown.교통,
    '모름이 실제 0곳보다 낮게 채점됐다 — 모름을 나쁨으로 만들면 안 된다');

  // ② 모름일 때 근거 문구에 "0곳" 같은 사실 주장이 들어가면 안 된다.
  const whyText = (unknown.why || []).join(' ');
  assert.equal(/지하철역\s*0\s*곳/.test(whyText), false, `모름인데 근거에 "0곳" 이 적혔다: ${whyText}`);

  // ③ 인프라도 마찬가지 — 전부 모르면 아는 항목이 없으니 카카오 기반 점수를 매기지 않는다.
  assert.notEqual(unknown.breakdown.인프라, 0,
    '전부 모름인데 인프라가 0 점이다 — 조회 실패가 감점이 된다');
});

// ── REPORT-SUBWAY-NULL-2026-09-02 (감사 P0-2, 회귀 주입으로 발견한 무커버리지) ─────────
//   [왜] report.js 의 null 가드를 지우고 테스트를 돌렸더니 **136 pass 로 그냥 통과**했다.
//     즉 그 가드는 아무도 지키지 않고 있었다 — 다음 리팩터에서 조용히 사라질 수 있었다.
//   [무엇을 고정하나] 카카오 조회 실패(null)가 "반경 1.2km 지하철역 0곳" 이라는 사실 주장으로
//     둔갑하지 않고, 역세권·교통 점수를 최저 밴드로 깎지도 않는다.
test('보고서 점수: amenities.subway 가 null 이면 역세권 근거·점수를 만들지 않는다', () => {
  const { applyObjectiveScore } = require('../routes/report');
  const mk = (subway) => ({
    score: 0, sigungu: '강남구', lawd_cd: '11680', households: null, build_year: null,
    amenities: { subway, school: null, mart: null, hospital: null, park: null, cvs: null },
    scoreBreakdown: { priority_역세권: 10, priority_교통: 10 },
  });

  const unknown = mk(null);
  applyObjectiveScore(unknown, true);
  const zero = mk(0);
  applyObjectiveScore(zero, true);

  // ① 모름은 기존 우선순위 점수를 건드리지 않는다(코드 주석의 "모르는 것을 0 으로 바꾸지 않는다").
  assert.equal(unknown.scoreBreakdown.priority_역세권, 10,
    `조회 실패(null)인데 역세권 점수가 ${unknown.scoreBreakdown.priority_역세권} 로 덮어써졌다`);
  assert.equal(unknown.scoreBreakdown.priority_교통, 10,
    `조회 실패(null)인데 교통 점수가 ${unknown.scoreBreakdown.priority_교통} 로 덮어써졌다`);

  // ② 실제 0 곳은 반대로 반영돼야 한다 — 그래야 ①이 "그냥 아무것도 안 함" 이 아님이 증명된다.
  assert.equal(zero.scoreBreakdown.priority_역세권, 2,
    '실제 0곳인데 최저 밴드가 적용되지 않았다 — 테스트 전제가 깨졌다');

  // ③ 모름일 때 "0곳" 이라는 사실 주장 문구가 생기면 안 된다.
  assert.equal(unknown.scoreBreakdown._역세권_근거, undefined,
    `조회 실패인데 근거 문구가 붙었다: ${unknown.scoreBreakdown._역세권_근거}`);
  assert.ok(/0\s*곳/.test(String(zero.scoreBreakdown._역세권_근거 || '')),
    '실제 0곳일 때는 근거에 0곳이 적혀야 한다(대조군)');
});

// ── SENTRY-IGNORE-2026-09-02 (감사 P0-4) ─────────────────────────────────────
//   [왜] Anthropic 크레딧 부족 에러가 error 로 36건 쌓여 운영자의 위험 신호
//     ("Sentry 신규 오류 0건")를 상시 오염시켰다. 실측 태그 `mechanism: auto.ai.anthropic`,
//     `handled: no` — Sentry 의 자동 계측이 우리 try/catch 보다 먼저 잡은 것이다.
//     보고서는 그 상황에서도 데이터판으로 정상 열화하므로 **결함이 아니라 설계된 경로**다.
//   [무엇을 고정하나] ① 그 문구가 실제로 걸러지는가 ② 필터가 **과도하게 넓어져** 진짜 장애를
//     삼키지 않는가. ②가 이 테스트의 진짜 목적이다 — 무시 목록은 조용히 넓어지기 쉽다.
test('Sentry 무시 목록: 예상된 AI 열화만 걸러내고 진짜 장애는 통과시킨다', () => {
  const { IGNORED_ERROR_PATTERNS } = require('../sentry');
  assert.ok(Array.isArray(IGNORED_ERROR_PATTERNS), "sentry.js 가 IGNORED_ERROR_PATTERNS 를 export 하지 않는다");

  // Sentry 의 ignoreErrors 는 문자열이면 부분일치, 정규식이면 test 로 매칭한다.
  const ignored = (msg) => IGNORED_ERROR_PATTERNS.some((pat) =>
    (typeof pat === 'string' ? msg.includes(pat) : pat.test(msg)));

  // ① 예상된 열화는 걸러진다
  const credit = 'Error: 400 {"type":"error","error":{"type":"invalid_request_error",'
    + '"message":"Your credit balance is too low to access the Anthropic API."}}';
  assert.ok(ignored(credit), '크레딧 부족 에러가 여전히 Sentry 로 올라간다 — 신규 오류 감시가 오염된다');

  // ② 진짜 장애는 반드시 통과해야 한다 (필터가 넓어지면 여기서 걸린다)
  const mustReport = [
    'Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    'Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    'Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens is too large"}}',
    'TypeError: Cannot read properties of undefined (reading \'score\')',
    'AbortError: The operation was aborted due to timeout',
    'PostgrestError: permission denied for table molit_transactions',
  ];
  const swallowed = mustReport.filter(ignored);
  assert.deepEqual(swallowed, [],
    `Sentry 무시 목록이 너무 넓다 — 진짜 장애를 삼킨다:\n  ${swallowed.join('\n  ')}`);
});

test('보고서 AI 열화는 Sentry 대신 degrade 카운터로 관측된다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../routes/report.js'), 'utf8');
  // Sentry 에서 걸러내는 대신 관측 경로를 남겨야 한다 — 둘 다 없으면 크레딧 소진이 무성지대가 된다.
  assert.ok(/observeDegrade\(`report-ai-/.test(src),
    'AI 열화 지점에 observeDegrade 기록이 없다 — Sentry 에서 걸러내면 관측 수단이 사라진다');
});

// ── REG-NONSEOUL-2026-09-02 (감사 P1-9) ──────────────────────────────────────
//   [왜] 보고서의 규제 판정은 **서울만** 하고 비서울은 무조건 미확인이었다. 그 사이 2026.6.30 로
//     화성 동탄구·용인 기흥구·구리시가 규제지역에 추가됐는데 보고서는 한 글자도 반영하지 못했고,
//     같은 서비스의 지역 대시보드(routes/region.js)는 이미 정확히 판정하고 있었다 —
//     **같은 서비스가 서로 다른 사실을 말하는** 상태였다(절대룰 ②).
//   [무엇을 고정하나] 이름 문자열이 아니라 lawd_cd 집합으로 판정하고, 손으로 고른 몇 건이 아니라
//     **전 코드 전수 스윕**으로 양방향(누락·오탐)을 확인한다.
//     (이 저장소는 "케이스를 손으로 골라 중구를 빠뜨린" 사고를 겪었다 — 그래서 전수다.)
test('보고서 규제 판정: 규제 lawd_cd 집합 전수 — 누락도 오탐도 없다', async () => {
  const { getRegulatedLawdCodes } = require('../services/regulationsService');
  const { LAWD_CODES } = require('../services/transactionService');
  const getRegulationPenalty = _reportFn('getRegulationPenalty');
  const { codes, seoulRegulated, unmatched } = await getRegulatedLawdCodes();

  // 전제: 스냅샷(또는 폴백)이 실제로 해석된다. 미매핑이 있으면 그 지역은 조용히 빠진다.
  assert.deepEqual(unmatched, [], `규제지역 이름이 lawd_cd 로 해석되지 않았다: ${unmatched.join(', ')}`);
  assert.ok(codes.size >= 40, `규제 코드가 ${codes.size}개뿐 — 스냅샷 해석이 깨졌다`);

  const byCode = new Map();
  for (const [name, code] of Object.entries(LAWD_CODES)) if (!byCode.has(String(code))) byCode.set(String(code), name);

  // ① 누락 없음 — 규제 집합의 모든 코드가 규제로 판정돼야 한다
  const missed = [];
  for (const code of codes) {
    const name = byCode.get(String(code)) || code;
    const sgg = name.replace(/^(서울|경기|인천|부산|대구|대전|광주|울산|세종)\s*/, '') || name;
    const r = getRegulationPenalty(sgg, code, seoulRegulated, codes);
    if (r.status === '미확인') missed.push(`${code}(${name})`);
  }
  assert.deepEqual(missed, [],
    `규제지역인데 '미확인' 으로 빠진 코드:\n  ${missed.join('\n  ')}`);

  // ② 오탐 없음 — 규제 집합 밖의 코드는 절대 규제로 판정되면 안 된다(동명 구 오판 차단)
  const falsePos = [];
  for (const [name, code] of Object.entries(LAWD_CODES)) {
    const c = String(code);
    if (codes.has(c)) continue;
    const sgg = name.replace(/^(서울|경기|인천|부산|대구|대전|광주|울산|세종)\s*/, '') || name;
    const r = getRegulationPenalty(sgg, c, seoulRegulated, codes);
    if (r.status !== '미확인') falsePos.push(`${c}(${name}) → ${r.status}`);
  }
  assert.deepEqual(falsePos, [],
    `비규제 지역이 규제로 잘못 판정됐다:\n  ${falsePos.join('\n  ')}`);
});

test('보고서 규제 판정: 2026.6.30 신규 지정 3곳이 실제로 반영된다', async () => {
  const { getRegulatedLawdCodes } = require('../services/regulationsService');
  const getRegulationPenalty = _reportFn('getRegulationPenalty');
  const { codes, seoulRegulated } = await getRegulatedLawdCodes();
  // 화성시 동탄구 41597 · 용인시 기흥구 41463 · 구리시 41310 (LAWD_CODES 실값)
  for (const [sgg, code] of [['동탄구', '41597'], ['기흥구', '41463'], ['구리시', '41310']]) {
    const r = getRegulationPenalty(sgg, code, seoulRegulated, codes);
    assert.equal(r.status, '조정대상지역', `${sgg}(${code}) 가 규제로 판정되지 않는다 — 2026.6.30 지정 누락`);
    assert.ok(r.bonus < 0, `${sgg} 규제 감점이 반영되지 않았다`);
  }
});

test('보고서 규제 판정: 서울 해제가 경기 판정을 흔들지 않는다 (독립성)', async () => {
  const { getRegulatedLawdCodes } = require('../services/regulationsService');
  const getRegulationPenalty = _reportFn('getRegulationPenalty');
  const { codes } = await getRegulatedLawdCodes();
  // 서울이 해제된 스냅샷을 가정 — 서울은 미확인으로 떨어지고, 경기는 그대로 규제여야 한다.
  assert.equal(getRegulationPenalty('강남구', '11680', false, codes).status, '미확인',
    '서울 해제 스냅샷인데 서울이 여전히 규제로 표시된다');
  assert.equal(getRegulationPenalty('동탄구', '41597', false, codes).status, '조정대상지역',
    '서울 해제가 경기 규제 판정까지 꺼버렸다 — 두 판정은 독립이어야 한다');
});

test('보고서 규제 판정: 코드 집합을 못 받으면 비서울은 미확인 (실패를 비규제로 단정하지 않는다)', () => {
  const getRegulationPenalty = _reportFn('getRegulationPenalty');
  // 조회 실패(regulatedCodes=null) 시 종전 동작 유지 — 하위호환이자 보수적 폴백.
  assert.equal(getRegulationPenalty('동탄구', '41597', true, null).status, '미확인',
    '집합 조회 실패인데 비서울을 단정했다');
  assert.equal(getRegulationPenalty('강남구', '11680', true, null).status, '투기과열·토허구역 일부',
    '집합이 없어도 서울 판정은 종전대로 동작해야 한다');
});

// ── REG-TABLE-DYNAMIC-2026-09-02 (감사 P1-9 프론트) ─────────────────────────────
//   [왜] 규제 요약 모달의 표가 2025.10.15 수치를 리터럴로 박아둔 정적 HTML 이었다.
//     regulations_snapshot 이 갱신돼도 이 표만 옛 값을 말한다(재배포 없는 갱신이 설계 의도였는데).
//     DB 와 대조한 실측 차이: 생애최초 비규제 80% 행 없음 · 2주택 이상 행 없음 ·
//     생애최초 규제의 15/25억 구간 캡 생략(20억 매수 시 실제 4억인데 표에는 "6억 한도") · 처분조건부 단서 누락.
//   [무엇을 고정하나] index.html 에 실제로 들어간 렌더 IIFE 를 **그대로 꺼내 실행**해서
//     ① 스냅샷이 있으면 그 값으로 그리고 ② 없으면 정적 표로 떨어지고 ③ 값이 이스케이프되는지 확인한다.
test('규제 요약 표: 스냅샷으로 그리되, 미로드 시 정적 표로 떨어진다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  assert.ok(html.indexOf('window.__REG_FULL = d;') >= 0,
    '규제 스냅샷 전문을 보존하지 않는다 — 표를 동적으로 그릴 데이터가 없어진다');

  const marker = html.indexOf('REG-TABLE-DYNAMIC-RENDER');
  assert.ok(marker > 0, '규제 표 동적 렌더러가 사라졌다 — 정적 표로 되돌아갔다');
  const startTok = '${(() => {';
  const s = html.lastIndexOf(startTok, marker);
  const e = html.indexOf('})()}', marker);
  assert.ok(s > 0 && e > s, '렌더러 IIFE 범위를 찾지 못했다 — 테스트를 갱신할 것');
  const body = html.slice(s + startTok.length, e);

  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const run = (regFull) => new Function('window', '_escHtml', '"use strict"; return (() => {' + body + '})();')({ __REG_FULL: regFull }, esc);

  // ① 스냅샷 기반 렌더 — DB 실측 구조(regulations_snapshot.housing_loan_2025.ltvTable)
  const ltvTable = [
    { condition: '무주택 — 규제지역', ltv: 40, cap: [{ under: 15, max: 6 }, { under: 25, max: 4 }, { over: 25, max: 2 }] },
    { condition: '생애최초 — 규제지역', ltv: 70, note: '6개월 이내 전입 의무', cap: [{ under: 15, max: 6 }, { under: 25, max: 4 }, { over: 25, max: 2 }] },
    { condition: '생애최초 — 비규제', ltv: 80, cap: null },
    { condition: '2주택 이상', ltv: 0, cap: null, note: '규제지역·수도권 구입 불가' },
  ];
  const dyn = run({ ltvTable });
  assert.equal((dyn.match(/<tr>/g) || []).length, 4, '스냅샷 행 수만큼 그려지지 않았다');
  for (const need of ['25억↑ 2억', '생애최초 — 비규제', '2주택 이상', '6개월 이내 전입 의무']) {
    assert.ok(dyn.indexOf(need) >= 0, `표에 "${need}" 가 없다 — 스냅샷 값이 반영되지 않는다`);
  }

  // ② 미로드·빈 스냅샷 → 정적 표 fallback (빈 표를 만들지 않는다)
  for (const empty of [null, undefined, {}, { ltvTable: [] }]) {
    const fb = run(empty);
    assert.ok((fb.match(/<tr>/g) || []).length >= 4, `스냅샷 미로드(${JSON.stringify(empty)})에서 표가 비었다`);
    assert.ok(fb.indexOf('무주택') >= 0, '정적 fallback 내용이 사라졌다');
  }

  // ③ 스냅샷 값은 DB 문자열이다 — 이스케이프 없이 innerHTML 에 들어가면 안 된다
  const evil = run({ ltvTable: [{ condition: '<img src=x onerror=alert(1)>', ltv: 40, cap: null, note: '<b>x</b>' }] });
  assert.equal(evil.indexOf('<img'), -1, '규제 표가 DB 문자열의 태그를 그대로 렌더한다 (XSS)');
  assert.equal(evil.indexOf('<b>x</b>'), -1, 'note 가 이스케이프되지 않는다');
});

// ── BILLING-REPAIR-2026-09-02 (감사 P1-6) ──────────────────────────────────────
//   [왜] confirm·webhook 은 ① payments CAS ② user_billing upsert 를 별개 await 로 한다.
//     ①만 되고 ②가 안 되면 **결제는 됐는데 이용권이 없다**. 게다가 ②의 error 를 아무도 확인하지
//     않아 크래시 없이도 같은 증상이 났고, 재시도는 "이미 처리됨" 조기반환에 걸려 ②를 영영 안 했다.
//   [왜 무조건 보정하면 안 되나] 그 지점에서 그냥 채워주면 **지난달 주문서로 confirm 을 다시 부르는
//     것만으로 30일이 공짜 연장**된다. 그래서 approved_at 과 user_billing.updated_at 을 비교한다
//     (updated_at 은 trg_user_billing_updated 트리거가 갱신 — 프로덕션 실측).
test('billing/confirm — captured 인데 이용권이 없으면 보정한다', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'captured', plan: 'pro',
    approved_at: new Date(Date.now() - 60 * 1000).toISOString() };
  // user_billing 행이 아예 없다 = 지급이 한 번도 반영되지 않았다.
  await _withBillingStub2({ payRow, casRows: [], tossKey: 'test', billingRow: null }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')(
      { body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => { assert.fail(`next(err): ${e && e.message}`); });
    assert.equal(res.statusCode, 200, '멱등 응답이어야 한다');
    const up = seen.upserts.find((u) => u.table === 'user_billing');
    assert.ok(up, '이용권이 비어 있는데 보정 upsert 가 없다 — 결제됐는데 플랜이 없는 상태가 영구히 남는다');
    assert.equal(up.row.plan, 'pro');
    assert.equal(up.row.status, 'active');
  });
});

test('billing/confirm — 옛 주문 재요청은 보정하지 않는다 (무료 연장 차단)', async () => {
  // 승인은 30일 전, 이용권은 그 직후 정상 반영(=updated_at 이 approved_at 보다 뒤).
  const approved = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const updated = new Date(approved.getTime() + 1000);
  const payRow = { order_id: 'oOld', user_id: 'u1', amount: 9900, status: 'captured', plan: 'pro',
    approved_at: approved.toISOString() };
  const billingRow = { plan: 'pro', status: 'active', current_period_end: new Date(Date.now() - 1000).toISOString(),
    updated_at: updated.toISOString() };
  await _withBillingStub2({ payRow, casRows: [], tossKey: 'test', billingRow }, async (seen) => {
    const res = _mockRes();
    await _billingHandler('/confirm')(
      { body: { paymentKey: 'pk', orderId: 'oOld', amount: 9900 }, user: { id: 'u1' } }, res, () => {});
    const up = seen.upserts.find((u) => u.table === 'user_billing');
    assert.equal(up, undefined,
      '이미 반영된 옛 결제인데 이용권을 다시 연장했다 — 주문서 재사용만으로 30일이 공짜가 된다');
  });
});

test('billing/confirm — user_billing 저장 실패를 성공으로 응답하지 않는다', async () => {
  const payRow = { order_id: 'o1', user_id: 'u1', amount: 9900, status: 'requested', plan: 'pro' };
  const axiosImpl = { post: async () => ({ data: { orderId: 'o1', status: 'DONE', totalAmount: 9900, method: '카드', approvedAt: new Date().toISOString() } }) };
  await _withBillingStub2({ payRow, casRows: [{ order_id: 'o1' }], tossKey: 'test', axiosImpl,
    upsertError: { message: 'db down' } }, async (seen) => {
    const res = _mockRes();
    let passedErr = null;
    await _billingHandler('/confirm')(
      { body: { paymentKey: 'pk', orderId: 'o1', amount: 9900 }, user: { id: 'u1' } }, res, (e) => { passedErr = e; });
    assert.ok(passedErr, '이용권 저장이 실패했는데 오류로 처리되지 않았다 — 사용자는 성공으로 알고 떠난다');
    assert.notEqual(res.body && res.body.status, 'captured',
      '저장 실패인데 captured 성공 응답을 돌려줬다');
  });
});

// ── SEO-LINKGRAPH-2026-09-02 (감사 P1-8) ──────────────────────────────────────
//   [왜] 사이트맵에 단지 URL 이 15,954개인데 **어떤 페이지도 /apt/* 로 링크하지 않았다**(전수 grep: 앱 0 · SSR 0).
//     내부 링크가 없는 URL 은 크롤 우선순위가 낮다 — 구글 색인이 1페이지에 머문 구조적 이유다.
//     그리고 robots.txt 가 `/share` 를 Disallow 해서, OG 메타를 동적 치환하는 그 라우트를
//     정작 카카오톡·X 링크 미리보기 크롤러가 못 읽었다(운영자 SNS 자동화와 직결).
//   [무엇을 고정하나] 링크 그래프가 다시 끊기는 회귀. 수치가 아니라 **구조**를 본다.
test('SEO: 지역 페이지가 단지 페이지로 내부 링크를 만든다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../routes/regionPage.js'), 'utf8');
  assert.ok(src.indexOf('/apt/') >= 0, '지역 페이지에 /apt 링크가 없다 — 단지 페이지가 링크 그래프 밖으로 나간다');
  assert.ok(/molit_apt_index/.test(src), '단지 목록 조회가 사라졌다');
  // 죽은 링크 방지: /apt 라우트가 받는 형식만 링크해야 한다
  assert.ok(src.indexOf('d{5}-') >= 0, 'apt_seq 형식 필터가 없다 — /apt 가 404 로 거부하는 링크를 뿌릴 수 있다');
});

test('SEO: /share 는 크롤 가능하되 색인은 막는다 (링크 미리보기 유지 + 중복 색인 방지)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const robots = fs2.readFileSync(path2.join(__dirname, '../../frontend/robots.txt'), 'utf8');
  const share = fs2.readFileSync(path2.join(__dirname, '../routes/share.js'), 'utf8');

  // robots.txt 의 "Disallow: /share" 는 주석(#)이 아닌 실제 지시문일 때만 문제다.
  const active = robots.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'));
  const blocked = active.some((l) => /^\s*Disallow:\s*\/share/i.test(l));
  assert.equal(blocked, false, 'robots.txt 가 /share 를 다시 막았다 — 카카오톡·X 링크 미리보기가 깨진다');

  assert.ok(/noindex,\s*follow/.test(share),
    '/share 가 noindex 를 내려주지 않는다 — 크롤 허용과 함께라면 SPA 중복 색인이 생긴다');
});

// ── INTRO-KEY-SYNC-2026-09-02 (감사 P1-7) ──────────────────────────────────────
//   [왜] 랜딩을 벗어나는 두 경로(_landingDismiss·_landingCTA)는 mhl_landing_seen 과 mhl_hero_dismissed 를
//     함께 세팅해 소개 메시지의 중복 노출을 막고 있었다. 그런데 dismissHero 만 반대가 비어 있었다 —
//     공유링크·UTM 으로 들어와 랜딩을 건너뛴 사용자가 히어로만 닫으면 다음 방문에 **랜딩 전면이 다시** 떴다.
//     라이브 실측으로 재현: dismissHero() 호출 후 mhl_hero_dismissed=1 이지만 mhl_landing_seen 은 null.
test('진입 소개: 히어로를 닫으면 랜딩도 본 것으로 기록한다 (같은 메시지 재노출 차단)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  const i = html.indexOf('function dismissHero()');
  assert.ok(i > 0, 'dismissHero 를 찾지 못했다 — 테스트를 갱신할 것');
  const body = html.slice(i, i + 900);
  assert.ok(body.indexOf("setItem('mhl_hero_dismissed', '1')") >= 0, 'dismissHero 가 히어로 키를 남기지 않는다');
  assert.ok(body.indexOf("setItem('mhl_landing_seen', '1')") >= 0,
    'dismissHero 가 mhl_landing_seen 을 남기지 않는다 — 히어로만 닫은 사용자에게 랜딩이 다시 뜬다');
});

test('진입 소개: 제거된 온보딩 모달(OB)을 기다리는 죽은 코드가 없다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  // id="OB" 는 OB-REMOVE-2026-07-17 에 사라졌다 — 그걸 참조하는 **코드**가 남으면 도달 불가 분기다.
  // ⚠ 단순 문자열 검색은 **이 수정의 설명 주석**까지 잡는다(실제로 한 번 오탐이 났다).
  //   실제 마크업만 보도록 태그 문맥을 요구한다.
  assert.equal(/<[a-zA-Z][^>]*sid="OB"/.test(html), false, 'OB 모달 엘리먼트가 되살아났다 — 이 테스트의 전제를 갱신할 것');
  const i = html.indexOf('function _maybeShowHero()');
  assert.ok(i > 0, '_maybeShowHero 를 찾지 못했다');
  const body = html.slice(i, i + 1600);
  // 주석 줄은 제외하고 실제 코드만 본다(제거 사유를 주석으로 남겨뒀다).
  const code = body.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal(/getElementById\(['\"]OB['\"]\)/.test(code), false,
    '_maybeShowHero 가 다시 OB 를 참조한다 — 항상 null 이라 그 분기는 실행되지 않는다');
  assert.equal(/setInterval/.test(code), false,
    '_maybeShowHero 에 도달 불가 폴링이 되살아났다');
});

test('보고서 점수: 데이터가 없다는 이유로 순위가 밀리지 않는다 (모름 ≠ 최하위)', () => {
  const { applyObjectiveScore } = require('../routes/report');
  const mk = (over) => Object.assign({
    score: 0, sigungu: '수지구', lawd_cd: '41465', households: 1200, build_year: new Date().getFullYear() - 3,
    kaptInfo: { parking: 1500 }, amenities: null, scoreBreakdown: {},
  }, over);

  const known = mk({}); applyObjectiveScore(known, true, null);
  // 세대수만 모르는 단지 vs 확인된 소형(250세대)
  const unknownHh = mk({ households: null, kaptInfo: { parking: null } }); applyObjectiveScore(unknownHh, true, null);
  const smallHh = mk({ households: 250, kaptInfo: { parking: 100 } }); applyObjectiveScore(smallHh, true, null);

  assert.ok(unknownHh.scoreBreakdown['객관_세대수'] > 0,
    '세대수를 모른다는 이유로 0 점을 받았다 — 확인된 최하위와 구별되지 않는다');
  assert.ok(unknownHh.scoreBreakdown['객관_세대수_미확인'] === true,
    '미확인 표시가 없다 — 화면이 추정값을 사실처럼 보여줄 수 있다');
  // 보너스가 0 이면 breakdown 키 자체가 생기지 않는다(undefined) — 비교 전에 0 으로 보정한다.
  assert.ok(unknownHh.scoreBreakdown['객관_세대수'] > (smallHh.scoreBreakdown['객관_세대수'] || 0),
    '모름이 확인된 소형보다 낮거나 같다 — 모름을 나쁨으로 만들고 있다');
  assert.ok(unknownHh.scoreBreakdown['객관_세대수'] < known.scoreBreakdown['객관_세대수'],
    '모름이 확인된 대단지와 같은 점수다 — 모름을 좋음으로 만들고 있다');

  // 준공년도도 같은 규칙
  const unknownAge = mk({ build_year: null }); applyObjectiveScore(unknownAge, true, null);
  assert.ok(unknownAge.scoreBreakdown['객관_노후도'] > 0, '준공년도 미상이 0 점이다');
  assert.equal(unknownAge.scoreBreakdown['객관_노후도_미확인'], true, '노후도 미확인 표시가 없다');
});

// ── QUOTA-NEAR-ONLY-2026-09-02 (감사 P1-7, 운영자 승인) ───────────────────────────
//   [왜] 헤더의 "오늘 남은 검색 5/5 · 채팅 30/30" 이 admin 이 아니면 상시 노출이라,
//     서비스를 처음 연 사람이 가장 먼저 읽는 숫자가 무료 한도였다 — 첫인상이 "제한된 체험판" 이 된다.
//     한도에 근접했을 때만 보이게 바꿨다. 임계값은 새로 만들지 않고 코드에 이미 있던 amber 경고선
//     (검색 잔여 ≤2 · 채팅 ≤3)을 그대로 재사용한다.
//   [무엇을 고정하나] 4가지 상태(여유·검색임박·채팅임박·둘다) + 무제한에서의 표시 조합.
//     한쪽만 보일 때 구분점("·")이 홀로 남는 시각 버그도 함께 막는다.
test('헤더 한도: 근접했을 때만 보이고, 한쪽만 보일 때 구분점이 남지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  // 항목별 토글이 가능하려면 id 가 있어야 한다(종전엔 wrap 하나뿐이라 개별 제어 자체가 불가능했다).
  for (const id of ['huSearchItem', 'huChatItem', 'huDot', 'huDimLabel']) {
    assert.ok(html.indexOf('id="' + id + '"') > 0, `헤더 한도 항목 id 가 없다: ${id}`);
  }

  // 실제 _syncHUsage 를 꺼내 stub DOM 으로 실행한다.
  const i = html.indexOf('function _syncHUsage()');
  assert.ok(i > 0, '_syncHUsage 를 찾지 못했다 — 테스트를 갱신할 것');
  const end = html.indexOf('function updateQuota(usage){', i);
  assert.ok(end > i, '_syncHUsage 범위를 찾지 못했다');
  const src = html.slice(i, end);

  const run = (unlimited, search, chat) => {
    const els = {};
    for (const id of ['hUsage', 'huSearchItem', 'huChatItem', 'huDot', 'huDimLabel']) els[id] = { style: {} };
    const win = { _quotaUnlimited: unlimited, _quotaNear: { search, chat } };
    const doc = { getElementById: (id) => els[id] || null };
    new Function('document', 'window', src + '; _syncHUsage();')(doc, win);
    const vis = (e) => e.style.display !== 'none';
    return { wrap: vis(els.hUsage), s: vis(els.huSearchItem), c: vis(els.huChatItem), dot: vis(els.huDot), dim: vis(els.huDimLabel) };
  };

  // ① 여유 상태(신규 방문자) — 아무것도 보이지 않는다
  assert.deepEqual(run(false, 5, 30), { wrap: false, s: false, c: false, dot: false, dim: false },
    '한도가 넉넉한데 헤더에 숫자가 노출된다 — 첫인상이 무료 한도가 된다');

  // ② 검색만 임박(잔여 2) — 검색만, 구분점은 숨김
  assert.deepEqual(run(false, 2, 30), { wrap: true, s: true, c: false, dot: false, dim: true },
    '검색 임박인데 표시가 틀렸다(구분점이 홀로 남았을 수 있다)');

  // ③ 채팅만 임박(잔여 3) — 채팅만
  assert.deepEqual(run(false, 5, 3), { wrap: true, s: false, c: true, dot: false, dim: true },
    '채팅 임박인데 표시가 틀렸다');

  // ④ 둘 다 임박 — 구분점 표시
  assert.deepEqual(run(false, 1, 1), { wrap: true, s: true, c: true, dot: true, dim: true },
    '둘 다 임박인데 구분점이 없다');

  // ⑤ 무제한(운영자·관리자) — 종전과 동일하게 숨김
  assert.deepEqual(run(true, null, null), { wrap: false, s: false, c: false, dot: false, dim: false },
    '무제한인데 한도 표시가 뜬다');

  // ⑥ 경계 — 검색 3 은 아직 여유, 2 부터 표시 (amber 임계값과 같은 수)
  assert.equal(run(false, 3, 30).s, false, '검색 잔여 3 은 아직 여유여야 한다');
  assert.equal(run(false, 2, 30).s, true, '검색 잔여 2 부터 보여야 한다');
  assert.equal(run(false, 5, 4).c, false, '채팅 잔여 4 는 아직 여유여야 한다');
  assert.equal(run(false, 5, 3).c, true, '채팅 잔여 3 부터 보여야 한다');
});

// ── PWA-SHORTCUT-2026-09-02 (감사 P2-11) ──────────────────────────────────────
//   [왜] manifest.json 의 바로가기 2개가 `/?view=report`·`/?view=chat` 를 가리키는데
//     `view` 파라미터를 읽는 코드가 **한 줄도 없었다**(전수 grep 0건). 홈 화면에 추가한 사용자가
//     바로가기를 눌러도 그냥 기본 화면이 떴다 — 기능이 있는 척만 하던 상태.
//   [무엇을 고정하나] manifest 가 가리키는 값과 코드가 처리하는 값이 **다시 어긋나지 않게**.
test('PWA 바로가기: manifest 의 view 값을 코드가 실제로 처리한다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const manifest = JSON.parse(fs2.readFileSync(path2.join(__dirname, '../../frontend/manifest.json'), 'utf8'));
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  const shortcuts = manifest.shortcuts || [];
  assert.ok(shortcuts.length > 0, 'PWA 바로가기가 사라졌다 — 이 테스트의 전제를 갱신할 것');

  // 파서가 존재해야 한다
  const i = html.indexOf('function handleViewParam()');
  assert.ok(i > 0, 'view 파라미터 파서가 없다 — manifest 바로가기가 아무 동작도 하지 않는다');
  const fnEnd = html.indexOf(String.fromCharCode(10) + '}', i);
  const body = html.slice(i, fnEnd > i ? fnEnd : i + 1200);

  // 파서가 실제로 호출돼야 한다(정의만 있고 부르지 않는 죽은 코드 방지)
  const callCount = (html.match(/handleViewParam\s*[,(]/g) || []).length;
  assert.ok(callCount >= 2, `handleViewParam 이 호출되지 않는다(출현 ${callCount}회) — 정의만 있는 죽은 코드다`);

  // manifest 의 모든 view 값이 파서에서 다뤄져야 한다
  const unhandled = [];
  for (const s of shortcuts) {
    const m = String(s.url || '').match(/[?&]view=([A-Za-z0-9_-]+)/);
    if (!m) continue;
    const v = m[1];
    const handled = v === 'chat'
      ? body.indexOf("'chat'") >= 0
      : body.indexOf('VIEW_DISPLAY') >= 0;   // 그 외는 VIEW_DISPLAY 화이트리스트로 처리
    if (!handled) unhandled.push(v);
  }
  assert.deepEqual(unhandled, [],
    `manifest 바로가기의 view 값을 코드가 처리하지 않는다: ${unhandled.join(', ')}`);

  // 임의 문자열로 sv() 를 부르지 않는다(화이트리스트 게이트 유지)
  assert.ok(body.indexOf('VIEW_DISPLAY') >= 0,
    'view 값 화이트리스트 검사가 사라졌다 — 임의 파라미터가 sv() 로 들어간다');
});

test('죽은 코드: 호출되지 않던 함수 3종이 되살아나지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const html = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  // 정의가 다시 생기면(=주석이 아니라 실제 function 선언) 실패한다.
  for (const fn of ['_pannMinZoom', 'renderLegacyPriceBars', 'currentYm']) {
    const re = new RegExp('function\\s+' + fn + '\\s*\\(');
    assert.equal(re.test(html), false, `${fn} 정의가 되살아났다 — 호출 0회였던 죽은 함수다`);
  }
});

test('죽은 서비스: 참조 0이던 schoolClusterService 가 되살아나지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const svc = path2.join(__dirname, '../services/schoolClusterService.js');
  const data = path2.join(__dirname, '../data/schoolClusters.js');
  assert.equal(fs2.existsSync(svc), false,
    'schoolClusterService 가 돌아왔다 — 학군 권역은 절대룰②(공식 출처)로 2026-08-19 퇴역했다');
  assert.equal(fs2.existsSync(data), false, 'schoolClusters 데이터가 돌아왔다');
});

// ── ACQ-REG-CALC-2026-09-02 (감사 후속: 한 화면에 취득세 두 값) ─────────────────
//   [왜] 다주택 취득세 중과는 **조정대상지역** 기준인데(지방세법 §13-2), 실투자금 계산기는
//     2주택+ 를 지역과 무관하게 항상 8% 로 계산했다. 같은 단지 상세 화면의 세금 시뮬레이션 카드는
//     이미 지역을 보고 계산하고 있어서, 비조정지역 단지에서 **같은 화면에 서로 다른 취득세**가 떴다.
//   [무엇을 고정하나] ① 비조정지역이 확인되면 기본세율 ② 모르면(undefined) 종전대로 중과 8%
//     — 모를 때 낮게 안내하면 과소 안내가 된다 ③ 프론트·백엔드가 같은 규칙을 쓴다.
test('취득세: 2주택+ 중과는 조정대상지역일 때만 (모르면 보수적으로 중과 유지)', () => {
  const { calcTotalCost } = require('../services/analysisService');
  const rate = (price, isRegulated) => calcTotalCost(price, 3, '2주택+', false, undefined, isRegulated).taxRate;

  // ① 조정대상지역 확인 → 중과 8%
  assert.equal(rate(7, true), 8, '조정대상지역 2주택+ 가 중과 8% 가 아니다');

  // ② 지역을 모름(undefined) → 종전대로 8% (과소 안내 금지)
  assert.equal(rate(7, undefined), 8, '지역을 모르는데 중과를 풀었다 — 세금을 낮게 안내하면 안 된다');

  // ③ 비조정지역 확인 → 기본세율(무주택 tier 와 같은 값)
  //    5억 1% · 7억 누진 · 10억 3% — 무주택 결과와 정확히 같아야 한다(사본이 갈리지 않았다는 증거).
  for (const px of [5, 6, 6.5, 7, 9, 10]) {
    const basic = calcTotalCost(px, 3, '무주택', false).taxRate;
    assert.equal(rate(px, false), basic,
      `비조정지역 2주택+(${px}억) 세율이 기본세율과 다르다: ${rate(px, false)} vs ${basic}`);
  }

  // ④ 중과와 기본세율이 실제로 다른 값이어야 한다(테스트가 무의미해지지 않게)
  assert.notEqual(rate(7, true), rate(7, false), '조정/비조정 결과가 같다 — 분기가 동작하지 않는다');
});

test('취득세: 프론트 계산기도 같은 지역 규칙을 쓴다 (사본 드리프트 차단)', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  const be = fs2.readFileSync(path2.join(__dirname, '../services/analysisService.js'), 'utf8');

  // 두 사본 모두 isRegulated 인자를 받아야 한다
  assert.ok(/function calcTotalCostHTML\([^)]*isRegulated/.test(fe),
    '프론트 계산기가 isRegulated 를 받지 않는다 — 지역을 알아도 반영할 수 없다');
  assert.ok(/function calcTotalCost\([^)]*isRegulated/.test(be),
    '백엔드 계산기가 isRegulated 를 받지 않는다');

  // 두 사본 모두 `=== false` 로만 중과를 푼다(truthy 판정이면 undefined 가 새어 들어간다)
  const feHits = (fe.match(/isRegulated\s*===\s*false/g) || []).length;
  const beHits = (be.match(/isRegulated\s*===\s*false/g) || []).length;
  assert.ok(feHits >= 2, `프론트의 isRegulated === false 검사가 ${feHits}회뿐 — tier·폴백 양쪽에 있어야 한다`);
  assert.ok(beHits >= 2, `백엔드의 isRegulated === false 검사가 ${beHits}회뿐`);

  // 단지 상세 호출부가 실제로 지역을 넘겨야 한다(안 넘기면 화면이 여전히 갈린다)
  assert.ok(fe.indexOf('calcTotalCostHTML(pr,loanAmt,houseS,isF,_costIsReg)') >= 0,
    '단지 상세 계산기 호출부가 지역을 넘기지 않는다 — 같은 화면의 세금 카드와 값이 갈린다');
});

// ── SCOPE-GATE-TRUTH-2026-09-02 (감사 P2) ────────────────────────────────────────
//   [왜] 이 저장소에서 **프로덕션을 세 번 죽인** 결함 클래스는 "매달린 참조"다 — 선언 범위 밖에서
//     식별자를 쓰는 것. 문법검사·계약테스트를 전부 통과하고 런타임에서만 죽는다.
//     그 목적으로 만들어져 있던 scripts/check-inline-scope.js 는 정규식이 `'\b'`(백스페이스 문자)라
//     **한 번도 매치한 적 없는 no-op** 이었다(실측: 선언만 개명해 미선언 상태를 만들어도 0건 보고).
//     실제로 잡는 것은 eslint no-undef 였다(같은 실측에서 사용처 2곳을 정확히 지적).
//   [무엇을 고정하나] 그 lint 배선이 끊기면 이 방어가 통째로 사라진다 — 배선 자체를 계약으로 건다.
test('품질 게이트: 프론트 인라인 JS 가 lint(no-undef)를 실제로 통과하도록 배선돼 있다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const root = path2.join(__dirname, '../..');
  const pkg = JSON.parse(fs2.readFileSync(path2.join(root, 'package.json'), 'utf8'));
  const ci = fs2.readFileSync(path2.join(root, '.github/workflows/ci.yml'), 'utf8');
  const eslintCfg = fs2.readFileSync(path2.join(root, 'eslint.config.mjs'), 'utf8');

  // ① lint 스크립트가 인라인 JS 를 추출해서 eslint 에 넣어야 한다
  const lint = String(pkg.scripts && pkg.scripts.lint || '');
  assert.ok(lint.indexOf('extract-inline-js') >= 0, 'lint 가 인라인 JS 를 추출하지 않는다 — 프론트가 검사 사각지대가 된다');
  assert.ok(/eslint[^&]*\.lint-tmp/.test(lint), 'lint 가 추출된 .lint-tmp 를 검사하지 않는다');

  // ② CI 가 그 스크립트를 실제로 실행해야 한다
  assert.ok(/run:\s*npm run lint/.test(ci), 'CI 에 npm run lint 스텝이 없다 — 로컬에서만 도는 게이트는 게이트가 아니다');

  // ③ no-undef 규칙이 켜져 있어야 한다(이게 매달린 참조를 잡는 실체다)
  assert.ok(/['\"]no-undef['\"]\s*:\s*['\"]error['\"]/.test(eslintCfg),
    'eslint no-undef 가 error 로 켜져 있지 않다 — 런타임에서만 죽는 스코프 오류를 아무도 못 잡는다');

  // ④ 추출기가 index.html 을 실제로 대상에 넣는지(파일명 하드코딩 회귀 방지)
  const ext = fs2.readFileSync(path2.join(root, 'scripts/extract-inline-js.js'), 'utf8');
  assert.ok(ext.indexOf('index') >= 0, '추출기가 index.html 을 대상에서 빠뜨렸다');
});

test('품질 게이트: no-op 로 판명된 스코프 검사기가 되살아나지 않는다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const root = path2.join(__dirname, '../..');
  assert.equal(fs2.existsSync(path2.join(root, 'scripts/check-inline-scope.js')), false,
    'check-inline-scope.js 가 돌아왔다 — 정규식이 백스페이스 문자라 항상 0건을 보고하는 no-op 이었다. '
    + '되살리려면 반드시 \'선언만 개명해 미선언 상태를 만들었을 때 실패하는가\' 를 먼저 실측할 것.');
});

// ── SCHEMA-SNAPSHOT-2026-09-02 (감사 후속) ─────────────────────────────────────
//   [왜] supabase/migrations 만으로는 프로덕션을 재현할 수 없다 — CREATE TABLE 이 어느 파일에도
//     없는 테이블이 9개, 시퀀스 없는 파일이 7개, "이미 적용된 걸 나중에 커밋" 이 8개다.
//     이 저장소는 이미 "파일 존재 ≠ 프로덕션 적용" 으로 3개월짜리 미적용 제약을 겪었다.
//     그래서 pg_catalog 를 직접 읽은 **현재 상태 스냅샷**(supabase/schema.sql)을 뒀다.
//   [무엇을 고정하나] 스냅샷은 방치되면 즉시 거짓말이 된다. 그래서 "코드가 실제로 부르는
//     테이블·RPC 가 스냅샷에 전부 있는가" 를 건다 — 스냅샷이 **중요한 방향으로** 낡으면 깨진다.
//     (2026-09-02 실측: 테이블 28/28, RPC 10/10 일치)
test('스키마 스냅샷: 코드가 참조하는 테이블·RPC 가 supabase/schema.sql 에 전부 선언돼 있다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const root = path2.join(__dirname, '../..');
  const schemaPath = path2.join(root, 'supabase/schema.sql');
  assert.ok(fs2.existsSync(schemaPath), 'supabase/schema.sql 이 사라졌다 — 마이그레이션만으로는 프로덕션을 재현할 수 없다');
  const schema = fs2.readFileSync(schemaPath, 'utf8');

  // 스냅샷이 선언하는 것들
  const declaredTables = new Set();
  for (const m of schema.matchAll(/^create (?:table|materialized view)(?: if not exists)? public\.([a-zA-Z0-9_]+)/gm)) declaredTables.add(m[1]);
  const declaredFns = new Set();
  for (const m of schema.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-zA-Z0-9_]+)/gm)) declaredFns.add(m[1]);
  assert.ok(declaredTables.size >= 27, `스냅샷 테이블이 비정상적으로 적다(${declaredTables.size}) — 덤프가 잘렸을 수 있다`);

  // 코드가 실제로 부르는 것들 (backend + api 전 소스)
  const srcFiles = [];
  const walk = (dir) => {
    if (!fs2.existsSync(dir)) return;
    for (const e of fs2.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.lint-tmp') continue;
      const fp = path2.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) srcFiles.push(fp);
    }
  };
  walk(path2.join(root, 'backend'));
  walk(path2.join(root, 'api'));
  const usedTables = new Map();
  const usedFns = new Map();
  for (const fp of srcFiles) {
    const src = fs2.readFileSync(fp, 'utf8');
    for (const m of src.matchAll(/\.from\(\s*['"`]([a-zA-Z0-9_]+)/g)) {
      if (!usedTables.has(m[1])) usedTables.set(m[1], fp);
    }
    for (const m of src.matchAll(/\.rpc\(\s*['"`]([a-zA-Z0-9_]+)/g)) {
      if (!usedFns.has(m[1])) usedFns.set(m[1], fp);
    }
  }
  assert.ok(usedTables.size >= 20, `테이블 참조 수집이 실패했다(${usedTables.size}) — 정규식이 깨졌을 수 있다`);

  const missT = [...usedTables.keys()].filter((x) => !declaredTables.has(x));
  const missF = [...usedFns.keys()].filter((x) => !declaredFns.has(x));
  assert.deepEqual(missT, [], `코드가 쓰는데 스냅샷에 없는 테이블: ${missT.map((x) => x + '(' + usedTables.get(x) + ')').join(', ')} — 스냅샷을 다시 뽑을 것`);
  assert.deepEqual(missF, [], `코드가 쓰는데 스냅샷에 없는 RPC: ${missF.map((x) => x + '(' + usedFns.get(x) + ')').join(', ')} — 스냅샷을 다시 뽑을 것`);
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

// ── OG-IMAGE-DYNAMIC-2026-09-02 (Sprint RRRRRRR) ────────────────────────────────
//   단지별 링크 미리보기 이미지. 카카오톡·X 에서 이 카드가 사실상 유일한 광고면이라
//   ① 틀린 숫자를 그리면 안 되고 ② 추천·예측 표현이 들어가면 절대 룰 위반이며
//   ③ 렌더가 실패해도 링크 미리보기 자체는 살아 있어야 한다.
test('OG 카드 문구 — 실거래 사실만 싣고, 없는 숫자를 지어내지 않는다', () => {
  const { buildCard } = require('../routes/ogImage');

  const withStat = buildCard({
    region: '서울 성동구', aptName: 'e편한세상옥수파크힐스', umd: '옥수동', buildYear: 2016,
    stat: { dealCount: 63, avgPriceAuk: '19.2', medianPrice: 189000, minPrice: 154000, maxPrice: 231000, recentDeal: '2026-08-20' },
  });
  assert.equal(withStat.title, 'e편한세상옥수파크힐스');
  assert.equal(withStat.eyebrow, '서울 성동구 · 옥수동');
  const joined = withStat.lines.join(' | ');
  assert.match(joined, /최근 24개월 63건/, '거래 건수가 카드에 없다');
  assert.match(joined, /평균 19.2억/, '평균가가 카드에 없다');
  assert.match(joined, /중앙값 18.9억/, '중앙값이 만원→억 변환을 안 거쳤다');
  assert.match(joined, /15.4억~23.1억/, '가격 범위가 없다');
  assert.ok(withStat.lines.length <= 2, '줄이 3개 이상이면 630px 안에서 답답해진다');
  assert.match(withStat.footer, /국토교통부/, '출처가 이미지에 박히지 않는다');

  // ★ 통계가 없으면 숫자를 만들어내지 않는다 (0 건·0 억 같은 거짓 사실 금지)
  const noStat = buildCard({ region: '부산 해운대구', aptName: '테스트', umd: '', buildYear: null, stat: null });
  const nj = noStat.lines.join(' ');
  assert.equal(/[0-9]+건|[0-9.]+억/.test(nj), false, `통계가 없는데 숫자를 그렸다: ${nj}`);

  // ★ 절대 룰 — 추천·예측·권유 표현 금지
  const BANNED = ['추천', '유망', '전망', '오를', '내릴', '매수', '매도', '투자하', '지금이 기회', '저평가'];
  for (const card of [withStat, noStat]) {
    const all = [card.eyebrow, card.title, ...card.lines, card.footer].join(' ');
    for (const w of BANNED) {
      assert.equal(all.includes(w), false, `OG 카드에 금지 표현이 들어갔다: "${w}" in "${all}"`);
    }
  }
});

test('OG 폰트 — 실제 단지명이 서브셋으로 전부 덮인다 (두부 글자 0)', () => {
  const { pickFonts, titleSize } = require('../services/ogImageService');

  // 실제 단지명에서 뽑은 표본 — 영문 혼용·중점·㎡·물결까지 포함한다
  const SAMPLES = [
    'e편한세상옥수파크힐스 서울 성동구 · 옥수동',
    '래미안원베일리 최근 24개월 128건 · 평균 21.7억',
    '경희궁자이2단지 중앙값 18.9억 · 15.4억~23.1억 · 최근 거래 2026-08-20',
    '국토교통부 실거래가 공개시스템 · 층·향 보정 없음',
    'MYHOMELOG 전용 84㎡ 2016년 준공',
  ];
  for (const s of SAMPLES) {
    const r = pickFonts(s, 400, 'T');
    assert.ok(r.fonts.length > 0, `서브셋을 하나도 못 골랐다: ${s}`);

    // ★ FONT-FAMILY-DISTINCT: 서브셋마다 이름이 달라야 satori 가 폴백 체인을 탄다.
    //   같은 이름으로 넘겼다가 한글 대부분이 두부(□)로 그려진 적이 있다.
    const names = r.fonts.map((f) => f.name);
    assert.equal(new Set(names).size, names.length,
      '서브셋 폰트 이름이 겹친다 — satori 가 하나만 쓰고 나머지 글자를 □ 로 그린다');
    assert.equal(r.family, names.join(', '), 'fontFamily 폴백 목록이 폰트 목록과 다르다');
  }

  // 이름이 길수록 글자를 줄인다(넘치면 카드 밖으로 나간다)
  assert.ok(titleSize('파크뷰') > titleSize('e편한세상옥수파크힐스'), '긴 이름이 줄어들지 않는다');
  assert.ok(titleSize('아'.repeat(30)) <= 40, '아주 긴 이름이 충분히 줄지 않는다');
});

test('OG 렌더 — 1200x630 PNG 를 실제로 만든다', async () => {
  const { renderCard, W, H } = require('../services/ogImageService');
  const png = await renderCard({
    eyebrow: '서울 성동구 · 옥수동', title: 'e편한세상옥수파크힐스',
    lines: ['최근 24개월 63건 · 평균 19.2억'], footer: '국토교통부 실거래가 공개시스템',
  });
  assert.ok(Buffer.isBuffer(png) && png.length > 5000, `PNG 가 비정상적으로 작다(${png && png.length})`);
  // PNG 시그니처 + IHDR 에서 실제 픽셀 크기를 읽는다 (헤더만 믿지 않는다)
  assert.equal(png.slice(1, 4).toString('latin1'), 'PNG', 'PNG 시그니처가 아니다');
  assert.equal(png.readUInt32BE(16), W, `가로가 ${W} 가 아니다`);
  assert.equal(png.readUInt32BE(20), H, `세로가 ${H} 가 아니다`);
});

test('OG 라우트 — 실패·미존재는 정적 이미지로 떨어지고 절대 캐시되지 않는다', async () => {
  // 열화된 응답을 엣지에 굳히면 장애가 캐시 수명만큼 지속된다(이 저장소의 실제 사고).
  const router = require('../routes/ogImage');
  const layer = router.stack.find((l) => l.route);
  assert.ok(layer, 'ogImage 라우터에 라우트가 없다');
  const handle = layer.route.stack[0].handle;

  const mkRes = () => {
    const r = { headers: {}, redirected: null, sent: null, code: 200 };
    r.set = (k, v) => { r.headers[k] = v; return r; };
    r.status = (c) => { r.code = c; return r; };
    r.redirect = (c, url) => { r.code = c; r.redirected = url; return r; };
    r.send = (b) => { r.sent = b; return r; };
    return r;
  };

  // ① 형식이 틀린 코드 — 이름으로 조회하지 않는다(동명 단지가 남의 시세를 끌어온다)
  const bad = mkRes();
  await handle({ params: { aptSeq: '반포자이' } }, bad, () => {});
  assert.equal(bad.redirected, '/og.png', '잘못된 코드인데 정적 이미지로 떨어지지 않았다');
  assert.equal(bad.headers['Cache-Control'], 'no-store', '열화 응답에 캐시가 붙었다');
  assert.equal(bad.headers['X-Og-Fallback'], 'bad-seq', '폴백 사유를 남기지 않아 라이브에서 원인을 못 본다');

  // ② 사실 조회가 null (DB 미설정 환경) — 여기서도 캐시 금지
  const none = mkRes();
  await handle({ params: { aptSeq: '11200-1234' } }, none, () => {});
  assert.equal(none.redirected, '/og.png', '데이터가 없는데 정적 이미지로 떨어지지 않았다');
  assert.equal(none.headers['Cache-Control'], 'no-store', '열화 응답에 캐시가 붙었다');
});

test('OG 배선 — 단지 페이지가 사실을 한 곳에서만 만들고, 얇은 페이지엔 동적 이미지를 안 건다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../routes/aptPage.js'), 'utf8');

  // ① 사실 생성은 loadAptFacts 한 곳 — 카드와 페이지가 다른 숫자를 말하면 안 된다
  assert.equal(typeof require('../routes/aptPage').loadAptFacts, 'function',
    'loadAptFacts 가 내보내져 있지 않다 — OG 라우트가 사실을 따로 계산하게 된다');
  // ⚠ 주석에도 이 이름이 나오므로 **호출 형태**(svc.analyzeTransactions()) 로 좁혀 센다.
  assert.equal((src.match(/svc\.analyzeTransactions\(/g) || []).length, 1,
    'analyzeTransactions 호출이 2곳 이상이다 — 사실 계산이 다시 사본이 됐다');

  // ② 거래가 없는 얇은 페이지는 그릴 숫자가 없으므로 기본 이미지를 쓴다
  assert.match(src, /image: thin \? null :/,
    '얇은 페이지에도 동적 이미지를 걸고 있다 — 빈 카드가 공유된다');
});

//   OG-FONT-BUNDLE-2026-09-02: 폰트를 어떻게 함수 번들에 싣느냐로 **배포가 한 번 죽었다.**
//     ① @fontsource 패키지(55MB)를 excludeFiles 로 잘라내려 했더니 그 값이 256자를 넘어
//        Vercel 이 vercel.json 스키마 검증에서 배포를 통째로 거부했다(빌드 로그조차 없다).
//     ② 설령 통과했어도 node_modules 안의 폰트는 런타임 fs 읽기라 파일 추적이 못 잡는다 —
//        배포는 성공하는데 프로덕션에서만 폰트를 못 찾아 카드가 조용히 폴백으로 돌았을 것이다.
//     → 필요한 서브셋만 저장소에 벤더링하고 includeFiles 로 명시한다.
test('OG 폰트 번들 — 벤더 폰트가 함수 번들에 실리고, vercel.json 이 스키마 한도를 지킨다', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const root = path2.join(__dirname, '../..');
  const vj = JSON.parse(fs2.readFileSync(path2.join(root, 'vercel.json'), 'utf8'));
  const fn = (vj.functions || {})['api/index.js'] || {};

  // ① 배포를 죽인 바로 그 한도. 넘으면 빌드가 아니라 **배포 자체**가 거부된다.
  for (const k of ['includeFiles', 'excludeFiles']) {
    const v = String(fn[k] || '');
    assert.ok(v.length <= 256,
      `vercel.json 의 ${k} 가 ${v.length}자 — Vercel 스키마 한도(256)를 넘어 배포가 거부된다`);
  }

  // ② 벤더 폰트가 번들에 포함돼야 한다. 빠지면 배포·테스트는 통과하는데 카드만 폴백으로 돈다.
  assert.match(String(fn.includeFiles || ''), /backend\/assets\/fonts/,
    'includeFiles 에 벤더 폰트 경로가 없다 — 프로덕션에서 폰트를 못 찾아 카드가 조용히 기본 이미지로 떨어진다');
  assert.match(String(fn.includeFiles || ''), /frontend\/index\.html/,
    'includeFiles 에서 index.html 이 빠졌다 — 기존 동작이 깨진다');

  // ③ 벤더 파일이 실제로 있어야 한다(패키지 의존을 끊었으므로 저장소가 유일한 출처다)
  const dir = path2.join(root, 'backend/assets/fonts/noto-sans-kr');
  assert.ok(fs2.existsSync(path2.join(dir, 'index.json')), '폰트 인덱스가 없다');
  assert.ok(fs2.existsSync(path2.join(dir, 'LICENSE.txt')), 'OFL 라이선스 사본이 없다 — 재배포 조건 위반');
  const idx = JSON.parse(fs2.readFileSync(path2.join(dir, 'index.json'), 'utf8'));
  for (const w of ['400', '700']) {
    assert.ok(Array.isArray(idx[w]) && idx[w].length > 50, `가중치 ${w} 인덱스가 비었거나 너무 작다`);
    for (const [file] of idx[w]) {
      assert.ok(fs2.existsSync(path2.join(dir, file)), `인덱스가 가리키는 폰트 파일이 없다: ${file}`);
    }
  }

  // ④ 런타임이 npm 패키지에 다시 기대지 않는다(그 경로는 파일 추적이 못 잡는다)
  const svc = fs2.readFileSync(path2.join(root, 'backend/services/ogImageService.js'), 'utf8');
  assert.equal(/require\(['"]@fontsource/.test(svc), false,
    'ogImageService 가 다시 @fontsource 패키지를 require 한다 — 프로덕션에서 폰트를 못 찾는다');
  const pkg = JSON.parse(fs2.readFileSync(path2.join(root, 'package.json'), 'utf8'));
  assert.equal('@fontsource/noto-sans-kr' in (pkg.dependencies || {}), false,
    '@fontsource 의존이 되살아났다 — 55MB 가 함수 번들에 실린다');
});

//   한글 커버리지는 **실행**으로 확인한다 — 인덱스가 있어도 글자를 못 덮으면 두부(□)가 그려진다.
test('OG 폰트 — 한글 음절 전 구간을 서브셋이 덮는다 (표본 실행)', () => {
  const { pickFonts } = require('../services/ogImageService');
  // 가·힣 양끝 + 중간을 고르게 뽑은 표본 + 실제 단지명에 흔한 글자
  const chars = [];
  for (let cp = 0xac00; cp <= 0xd7a3; cp += 97) chars.push(String.fromCodePoint(cp));
  const sample = chars.join('') + '가힣아파트단지동호실거래평균억건년준공전용㎡·~→';
  for (const w of [400, 700]) {
    const r = pickFonts(sample, w, 'X');
    assert.ok(r.fonts.length > 0, `가중치 ${w} 에서 서브셋을 하나도 못 골랐다`);
    // 못 덮는 글자가 있으면 pickFonts 가 경고를 남기지만, 여기서는 커버 자체를 직접 센다
    const idx = require('node:fs').existsSync ? null : null;
    const covered = [...new Set([...sample])].filter((ch) => {
      const one = pickFonts(ch, w, 'Y');
      return one.fonts.length > 0;
    });
    assert.equal(covered.length, new Set([...sample]).size,
      `가중치 ${w} 에서 못 덮는 글자가 있다 — 카드에 □ 로 그려진다`);
  }
});

// ── TOUCH-TARGET-2026-09-02 (감사 후속: 모바일) ───────────────────────────────
//   [실측] 라이브 375x812 보고서 화면의 조작 요소 18개가 전부 44px 미만이었다(.chip 61개가 39px).
//     오터치는 곧 잘못된 조건 입력이고, 그러면 보고서 결과 자체가 달라진다.
//   [왜 소스 검사인가] CSS 규칙은 "코드의 형태" 자체가 요구사항이라 정규식이 옳은 도구다
//     (실행 대조가 필요한 계산 로직과 다르다).
test('모바일 탭 타깃 — 44px 하한이 모바일에서만, 그리고 .chips 안에만 걸린다', () => {
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const i = html.indexOf('TOUCH-TARGET-2026-09-02');
  assert.ok(i > 0, '모바일 탭 타깃 규칙이 사라졌다');
  const block = html.slice(i, i + 1600);

  // ① 모바일 전용이어야 한다 — 전역으로 키우면 칩이 많은 화면이 불필요하게 길어진다
  assert.match(block, /@media\(max-width:700px\){/,
    '모바일 미디어쿼리 안이 아니다');

  // ② ★ .chip 전역이 아니라 .chips 안만. 전역이면 칩 모양 배지까지 눌린 모양이 된다
  assert.match(block, /\.chips \.chip{[^}]*min-height:44px/,
    '.chips 안 칩에 44px 하한이 없다');
  assert.equal(/^\s*\.chip{/m.test(block), false,
    '.chip 을 전역으로 키우고 있다 — 배지가 세로로 쪼개진다(라이브 검증에서 실제로 재현됐다)');

  // ③ ★ 도움말(.wi)에 좌우 여백을 주면 margin-left:auto 때문에 제목을 밀어 줄바꿈시킨다
  const wi = block.match(/\.wchead \.wi[^{]*{([^}]*)}/);
  assert.ok(wi, '.wi 규칙을 찾지 못했다');
  assert.match(wi[1], /padding:8px 0/,
    '.wi 에 좌우 여백이 들어갔다 — 제목이 줄바꿈되고 필수 배지가 세로로 쪼개진다');
});

// ── KST-TIME-2026-09-05 (감사 G-8: '하루' 경계는 호스트 TZ 가 아니라 KST) ─────────────────
test('KST 하루 경계 — 호스트 TZ 와 무관하게 KST 자정을 계산한다', () => {
  const { nextKstMidnight, kstDate } = require('../utils/kstTime');
  // 2026-09-05 12:00 KST(=03:00Z) → 다음 KST 자정 = 2026-09-06 00:00 KST = 2026-09-05T15:00Z
  assert.equal(nextKstMidnight(Date.parse('2026-09-05T03:00:00Z')), Date.parse('2026-09-05T15:00:00Z'));
  assert.equal(nextKstMidnight(Date.parse('2026-09-05T14:59:00Z')), Date.parse('2026-09-05T15:00:00Z'));
  // 자정 정각은 그 날의 시작 → 다음 자정은 하루 뒤
  assert.equal(nextKstMidnight(Date.parse('2026-09-05T15:00:00Z')), Date.parse('2026-09-06T15:00:00Z'));
  assert.equal(kstDate(Date.parse('2026-09-05T15:00:00Z')), '2026-09-06');
  assert.equal(kstDate(Date.parse('2026-09-05T14:59:59Z')), '2026-09-05');
});

test('카카오 일일 카운터 — KST 자정 리셋 (호스트 TZ setHours 금지)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../services/geocodeCacheService.js'), 'utf8');
  const code = src.split(/\r?\n/).map(l => l.split('//')[0]).join('\n'); // 주석은 제외 — 주석이 정규식에 잡힌 사고 4회
  assert.equal(/setHours\(24/.test(code), false, '호스트 TZ 자정으로 되돌아갔다 — 프로덕션(UTC)에서는 KST 09시 리셋');
  assert.match(src, /_kakaoCountResetAt = nextKstMidnight\(now\)/);
});

// ── TXWINDOW-KST-2026-09-05 (감사 G-8) ────────────────────────────────────────────
//   [실측] 옛 구현은 두 가지가 틀렸다: setMonth 오버플로(7/31 → 3/1) · 호스트 TZ 의존(KST 로컬 09시 이전 = 전월 말일).
test('txWindowStart — 31일 오버플로와 KST 달 경계 (옛 코드는 둘 다 틀렸다)', () => {
  const { txWindowStart } = require('../utils/txWindow');
  // 7/31 19:00 KST: 6개월 창은 2월부터. 옛 코드는 "2/31" 오버플로로 3/1 을 냈다.
  assert.equal(txWindowStart(6, Date.parse('2026-07-31T10:00:00Z')), '2026-02-01');
  // 8/31 16:00Z = 9/1 01:00 KST → KST 로는 이미 9월 → 4월부터. 옛 코드(UTC 호스트)는 8월로 보고 3/1 을 냈다.
  assert.equal(txWindowStart(6, Date.parse('2026-08-31T16:00:00Z')), '2026-04-01');
  // 8/31 14:00Z = 8/31 23:00 KST → 아직 8월 → 3월부터
  assert.equal(txWindowStart(6, Date.parse('2026-08-31T14:00:00Z')), '2026-03-01');
  assert.equal(txWindowStart(6, Date.parse('2026-09-05T03:00:00Z')), '2026-04-01');
  assert.equal(txWindowStart(24, Date.parse('2026-09-05T03:00:00Z')), '2024-10-01');
  assert.match(txWindowStart(6), /^\d{4}-\d{2}-01$/, '기본 인자(now 생략)도 달 경계를 돌려줘야 한다');
});

// ── PYEONG-SSOT-2026-09-05 (감사 P2-11: 평↔㎡ 계수 사본 통합) ─────────────────────
test('평↔㎡ 계수 — 코드의 리터럴 3.3058 은 utils/pyeong.js 한 곳에만', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(__dirname, '..');
  const hits = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      if (f === 'node_modules' || f === 'test') continue;
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!f.endsWith('.js')) continue;
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
        const code = line.split('//')[0];                 // 줄 주석은 제외 — 주석 속 설명 숫자는 사본이 아니다
        if (/(?<![\w.])3\.3058\b/.test(code)) hits.push(path.relative(root, p).replace(/\\/g, '/') + ':' + (i + 1));
      });
    }
  })(root);
  assert.deepEqual(hits.map(h => h.split(':')[0]), ['utils/pyeong.js'],
    '평형 계수 리터럴이 다른 파일에 생겼다 — 한쪽만 고치면 화면마다 평당가가 갈린다: ' + hits.join(', '));
  const { PYEONG_M2, toPyeong } = require('../utils/pyeong');
  assert.equal(PYEONG_M2, 3.3058);
  assert.equal(toPyeong(84.97).toFixed(2), '25.70');
  assert.equal(toPyeong('abc'), null);
});

// ── ESC-SERVER-VALUES-2026-09-05 (감사 H-LOW) ─────────────────────────────────────
test('서버 통제값도 이스케이프 — 청약 sido · 지역 칩 label', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.equal((html.match(/\$\{d\.sido\}/g) || []).length, 0, '청약 sido 가 생으로 삽입된다');
  assert.equal((html.match(/\$\{_escHtml\(d\.sido\)\}/g) || []).length, 2);
  assert.ok(html.includes('onclick="cpSub(this)">${_escHtml(g.label)}</span>'), '지역 칩 label 이 생으로 삽입된다');
});

// ── A11Y-LABELS-2026-09-05 (감사 E 접근성: 이름 없는 입력 19개 → 0) ─────────────────
//   [왜 소스 검사인가] "입력에 이름이 있는가"는 마크업의 형태 자체가 요구사항이다.
test('접근성 — 이름 없는 입력 요소 0개 (aria-label · label[for] · 부모 label 중 하나)', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const labelFor = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map(m => m[1]));
  const re = /<(input|select|textarea)\b([^>]*)>/g;
  const bad = []; let m;
  while ((m = re.exec(html))) {
    const attrs = m[2];
    const type = (attrs.match(/\btype="([^"]+)"/) || [])[1] || '';
    if (['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(type)) continue;
    if (/\baria-label(ledby)?=/.test(attrs) || /\btitle=/.test(attrs)) continue;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (id && labelFor.has(id)) continue;
    const before = html.slice(Math.max(0, m.index - 400), m.index);
    if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue; // 부모 <label> 로 감싸짐
    bad.push(html.slice(0, m.index).split('\n').length + ':' + m[1] + '#' + (id || '?'));
  }
  assert.deepEqual(bad, [], '이름 없는 입력이 생겼다 — 스크린리더가 "편집 가능 텍스트"라고만 읽는다');
});

// ── WEBHOOK-TSE-2026-09-05 (감사 H-LOW) ───────────────────────────────────────────
test('Toss 웹훅 정적 시크릿 — 상수 시간 비교 (길이 선검사 + timingSafeEqual)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../routes/billing.js'), 'utf8');
  assert.equal(src.includes('got !== expectedSecret'), false, '문자열 !== 비교로 되돌아갔다');
  assert.match(src, /_gotBuf\.length !== _expBuf\.length \|\| !require\('crypto'\)\.timingSafeEqual\(_gotBuf, _expBuf\)/);
});

// ── FACILITY-STORE-LOG-2026-09-05 (감사 G-6) ──────────────────────────────────────
test('facility 갱신 저장 실패는 기록된다 (fire-and-forget 금지)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../services/aptFacilityService.js'), 'utf8');
  assert.equal(src.includes(".eq('kapt_code', m.kapt_code).then(() => {}, () => {})"), false, '저장 실패가 다시 삼켜진다');
  assert.match(src, /'facility 갱신 저장 실패'/);
});

// ── ENV-GATE-2026-09-05 (감사 M) ──────────────────────────────────────────────────
test('CI — .env.example 드리프트 검사는 차단 게이트다 (|| true 금지)', () => {
  const ci = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  const i = ci.indexOf('scripts/check-env-example.js');
  assert.ok(i > 0, 'env.example 검사 스텝이 사라졌다');
  const line = ci.slice(ci.lastIndexOf('\n', i) + 1, ci.indexOf('\n', i));
  assert.equal(/\|\|\s*true/.test(line), false, '.env.example 검사가 다시 비차단이 됐다: ' + line.trim());
});

// ── ROBOTS-OG-ALLOW-2026-09-05 ────────────────────────────────────────────────────
//   [실측] Search Console 이 "robots.txt 에 의해 차단됨" 1건을 보고했다. 동적 OG 이미지가 /api/og/ 아래에 있는데
//   robots.txt 가 /api/ 전체를 막고 있어, robots.txt 를 존중하는 스크래퍼는 카드 이미지를 못 가져간다.
test('robots.txt — /api/ 는 막되 /api/og/ 는 허용 (Allow 가 Disallow 보다 앞)', () => {
  const txt = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/robots.txt'), 'utf8');
  const star = txt.slice(txt.indexOf('User-agent: *'), txt.indexOf('User-agent: GPTBot'));
  const allow = star.indexOf('Allow: /api/og/'), dis = star.indexOf('Disallow: /api/');
  assert.ok(allow >= 0, 'OG 이미지 경로 허용이 사라졌다 — 카카오톡·X 카드 이미지가 막힌다');
  assert.ok(dis >= 0, '/api/ 차단이 사라졌다');
  assert.ok(allow < dis, '단순 파서(첫 매치 우선)를 위해 Allow 가 Disallow 보다 앞에 있어야 한다');
});

// ── MASCOT-HIDDEN-2026-09-05 (감사 E·J) ───────────────────────────────────────────
test('브리핑 — "(캐릭터 준비 중)" 플레이스홀더는 사용자에게 보이지 않는다', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../frontend/index.html'), 'utf8');
  const i = html.indexOf('MASCOT-HIDDEN-2026-09-05');
  assert.ok(i > 0, '집킴이 코너 숨김 마커가 사라졌다');
  assert.match(html.slice(i, i + 800), /<div style="margin-top:12px;display:none;/, '집킴이 코너가 다시 보인다(캐릭터 원화 도착 전)');
});

// ── DEAD-ENDPOINTS-2026-09-05 (감사 P2-11: 프론트 호출 0건 엔드포인트 4 + legal 라우터 제거) ─────────
//   [왜 소스 검사인가] "그 경로가 존재하지 않는다" 는 부재 계약이다 — 정규식이 옳은 도구.
test('죽은 엔드포인트는 되살아나지 않는다 — /analysis/total-cost · /properties/info · /regulations/ltv · /api/legal', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  assert.equal(/router\.post\('\/total-cost'/.test(read('../routes/analysis.js')), false, 'POST /total-cost 가 되살아났다(프론트 호출 0건)');
  assert.equal(/router\.get\('\/info'/.test(read('../routes/properties.js')), false, 'GET /properties/info 가 되살아났다(/api/search/facility 가 대체)');
  assert.equal(/router\.get\('\/ltv'/.test(read('../routes/regulations.js')), false, 'GET /regulations/ltv 가 되살아났다');
  assert.equal(fs.existsSync(path.join(__dirname, '../routes/legal.js')), false, 'routes/legal.js 가 되살아났다');
  assert.equal(fs.existsSync(path.join(__dirname, '../services/legalCorpusService.js')), false, 'legalCorpusService 가 되살아났다');
  const server = read('../server.js');
  assert.equal(/\/api\/legal'/.test(server), false, 'server.js 가 /api/legal 을 다시 마운트한다');
  assert.equal(/routes\/legal'/.test(server), false, 'server.js 가 routes/legal 을 다시 require 한다');
  // 오라클은 남긴다 — 프론트 취득세 사본과의 1,620조합 대조가 이 함수를 쓴다
  assert.equal(typeof require('../services/analysisService').calcTotalCost, 'function');
});
