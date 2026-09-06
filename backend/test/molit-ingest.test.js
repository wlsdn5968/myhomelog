/**
 * backend/test/molit-ingest.test.js
 *
 * characterization.test.js(Plan 066, 10,056줄·327 test 단일 파일)를 도메인별로 분할한 조각.
 * 동작을 하나도 바꾸지 않는 이동이다 — 테스트 이름·개수·본문은 원본과 동일하다.
 * 공용 목/스텁 유틸은 ./_helpers 에서 가져온다. 새 테스트는 이 파일의 주제와 맞으면 여기에,
 * 아니면 backend/test/README.md 규칙대로 새 도메인 파일을 만든다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _NO_PROMO, _adminWithIlikeChainTracker, _mockAptAdmin, _recentDealDate, _requireRouterWithAdmin } = require('../testSupport/_helpers');



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



test('molitParse.isCanceled — cdealType 유/무/공백 판정', () => {
  const { isCanceled } = require('../utils/molitParse');
  assert.equal(isCanceled({ cdealType: 'O' }), true);
  assert.equal(isCanceled({ cdealType: 1 }), true);   // 숫자로 와도 해제로 판정
  assert.equal(isCanceled({ cdealType: '' }), false);
  assert.equal(isCanceled({ cdealType: '  ' }), false);
  assert.equal(isCanceled({}), false);
  assert.equal(isCanceled(null), false);
});



// ── 완전 무결과 + 공백 제안 (Step 5 세 번째 원칙) ────────────────────────────────────
test('AI 도우미 시세 — molit·apt_master 둘 다 0건이면 그제서야 찾지 못했다고 답한다', async () => {
  const admin = _mockAptAdmin({ molit_apt_index: [], apt_master: [], molit_transactions: [] });
  const { router, restore } = _requireRouterWithAdmin(admin);
  try {
    const { reply } = await router.route('아무개단지구백구백 시세', null);
    assert.match(reply, /찾지 못했어요/);
    assert.equal(_NO_PROMO.test(reply), false);
  } finally { restore(); }
});



test('_market — "찾지 못했어요" 는 molit·apt_master 둘 다 0건인 분기에만 있다 (Plan 051 완료기준)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../services/chatDataRouter.js'), 'utf8');
  const start = src.indexOf('async function _market(');
  assert.ok(start >= 0, '_market 함수를 찾지 못했다');
  // 중괄호 카운팅으로 함수 본문만 추출 — 다음 핸들러(_rates 등)의 문구까지 섞이면 오탐한다.
  let depth = 0, i = src.indexOf('{', start), bodyEnd = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  assert.ok(bodyEnd > start, '_market 함수의 닫는 중괄호를 찾지 못했다');
  const body = src.slice(start, bodyEnd)
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n'); // 설명 주석 제거 — 자기 충돌 방지
  const hits = body.split('찾지 못했어요').length - 1;
  assert.equal(hits, 1,
    `_market 안에 "찾지 못했어요" 가 ${hits}번 있다(1번이어야 한다) — apt_master 히트 분기로 샜을 수 있다`);
});



// ══════════════════════════════════════════════════════════════════════════
// Plan 059 (2026-09-06) — 지역 분리 재시도에서 같은 단지를 두 번 세지 않는다.
//   [왜] 057 배포 뒤 프로덕션 라이브 실측: "대치 은마 시세" → "은마(강남구) · 은마(강남구)"
//   같은 단지가 두 번 나열되며 되물었다. DB 실측상 molit_apt_index 1행 + apt_master 1행,
//   실제로는 한 단지다 — rRanked.length + rAm.length 로 단순 합산해 세는 게 결함이었다.
//   [범위] chatDataRouter._market 의 지역 분리 재시도 결과 처리 블록(CAND-DEDUP-2026-09-06)만.
//   _regionSplitRetry 의 조회 구성·_buildRanked/_buildAmCandidates 내부 로직·051 원 질의
//   경로(amCandidates.length>=2 분기)는 손대지 않았다.
// ══════════════════════════════════════════════════════════════════════════

test('AI 도우미 시세 — 같은 단지가 두 출처(molit_apt_index·apt_master)에 하나씩 있으면 되묻지 않고 실거래를 답한다 (Plan 059 핵심, 운영자 재현 "대치 은마 시세")', async () => {
  const { admin, tracker } = _adminWithIlikeChainTracker({
    molit_apt_index: [
      { apt_name: '은마', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1979, deal_count: 51 },
    ],
    apt_master: [
      { apt_name: '은마', lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', kapt_code: 'A13583507', molit_aliases: null },
    ],
    molit_transactions: [
      { apt_name: '은마', sigungu: '강남구', umd_nm: '대치동', deal_amount: 250000, deal_date: _recentDealDate(10), exclu_use_ar: 84.4 },
    ],
  });
  const { router, restore } = _requireRouterWithAdmin(admin);
  try {
    const { reply, suggestions } = await router.route('대치 은마 시세', null);
    assert.equal(/혹시 이 중에 있나요/.test(reply), false,
      'Plan 059 이전엔 여기서 되물었다(같은 단지가 두 출처에 있어 합계가 2로 셈) — 재현이 안 되면 STOP 대상');
    assert.equal(/찾지 못했어요/.test(reply), false);
    assert.match(reply, /거래 1건/, '되묻지 않고 실거래 데이터로 바로 답해야 한다');
    assert.match(reply, /은마 \(강남구 대치동\)/);
    assert.equal(tracker.doubleIlikeChains, 3, '1라운드(3조회)에서 성공해 멈춰야 한다 — 왕복 상한 불변(Plan 059 는 조회 구성을 건드리지 않는다)');
    assert.equal(_NO_PROMO.test(reply), false);
    assert.ok(Array.isArray(suggestions));
  } finally { restore(); }
});
