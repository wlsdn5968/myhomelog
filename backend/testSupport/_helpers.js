/**
 * backend/test/_helpers.js
 *
 * characterization.test.js(10,056줄·327 test) 분할(Plan 066)로 뽑아낸 공용 테스트 유틸리티.
 * 전부 목/스텁/픽스처 생성 함수이며 실제 assertion(test())은 없다 — `node --test` 는 이 파일을
 * 테스트로 잡지 않는다(파일명이 *.test.js 가 아니고, node:test 러너는 등록된 test() 콜백이 있는
 * 파일만 실행 대상으로 삼는다; 실행 후 "tests 0" 로 실측 확인했다).
 *
 * 각 test 파일은 필요한 이름만 구조분해로 가져다 쓴다:
 *   const { _mockRes, _mockAdmin } = require('./_helpers');
 */
'use strict';

const assert = require('node:assert/strict');



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


// ── Plan 035 (2026-09-06): /share 치환 문자열의 $ 패턴 확장 차단 ──────────
//   [왜] backend/routes/share.js 의 OG 메타 치환 8+1개가 String.replace 에 **문자열**
//   replacement 를 줬다. JS 는 문자열 replacement 안의 특수 패턴(매치 전체·매치 앞부분·
//   매치 뒷부분·리터럴 달러)을 다시 확장하는데, 이 값은 요청 쿼리에서 오고 치환이 커지는
//   문자열 위에서 연쇄되므로 증폭이 곱으로 쌓인다. 실측(계획 작성 시): 확장 패턴 20자
//   입력 → 응답 43배(35,784,867자). 40자(=apt 상한 60자 이내)면 V8 문자열 상한을 넘겨
//   RangeError. /share 는 인증·레이트리밋이 없고, 결제·인증·cron 과 같은 서버리스 함수
//   인스턴스를 공유한다(vercel.json 의 api/index.js). 수정은 replacement 를 함수(lit())로
//   바꿔 재스캔 자체를 원리적으로 막는다 — 치환 결과 문자열의 의미는 바뀌지 않는다.
//   [이 테스트가 고정하는 것] 확장 패턴을 담은 입력이 응답 길이를 원본 HTML + 4,096자
//   넘게 부풀리지 못한다(?apt=, ?cmp= 두 분기 모두). 정상 입력의 치환은 여전히 동작한다.
//   ⚠ 확장 패턴 문자열은 문자 코드로 조립한다 — 소스에 리터럴로 두면 정적 검사가 자기
//   자신을 잡는 자충수(이 저장소에서 6회 재발)가 생긴다.
function _shareHandler() {
  const router = require('../routes/share');
  const layer = router.stack.find((l) => l.route && l.route.path === '/');
  assert.ok(layer, "share 라우터에서 '/' 를 찾지 못했다 (경로 변경 시 이 테스트도 갱신할 것)");
  return layer.route.stack[layer.route.stack.length - 1].handle;
}


function _shareMockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    set() { return this; },
    type() { return this; },
    redirect(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
  };
}


// 확장 패턴("매치 앞부분 전체" 로 확장되는 두 글자, $ 와 백틱)을 문자 코드로 조립한다.
const _SHARE_EXPAND_PAIR = String.fromCharCode(36) + String.fromCharCode(96);


// ══════════════════════════════════════════════════════════════════════════════
// REC-BEHAVIORAL-2026-09-06 (Plan 039): 추천 엔진 계약을 소스 문자열이 아니라 **실행 값**으로 고정한다.
//
//   [왜] 위 REC-BROAD-ALL·BUDGET-CAP·REC-RANK-PROV·TRANSIT-STAGE·MULTI-LENS 테스트는 전부
//   assert.match(src, …) 다 — 소스가 "그렇게 생겼는지"만 보고, 실제로 그렇게 **동작하는지**는
//   보지 않는다. 이 저장소는 그 한계를 실측했다 — 취득세의 조정지역 분기를 뒤집었더니 1,620개
//   조합 중 468개가 갈렸는데 모양 검사는 전부 초록이었다([[regex-contract-tests-miss-branch-flips]]).
//   정규식 계약 테스트는 "앞단 분기 반전" 과 "인자 교체" 를 원리적으로 잡지 못한다.
//
//   [방식] 프로덕션 코드는 한 줄도 바꾸지 않는다 — require.cache 에 고정 픽스처를 심어
//   외부 의존(DB·공공API·카카오·Redis)만 대체하고, propertyService 자신은 실제 소스 그대로
//   다시 로드해 돌린다(getAIRecommendations 는 파일 마지막 줄에 이미 export 돼 있다).
//     ⚠ ./transactionService 는 통째로 대체하지 않는다 — 실제 모듈을 펼친 뒤 네트워크 함수
//       (getRegionRecentTransactions)만 덮어쓴다. 통째로 바꾸면 LAWD_CODES 등 상수가 사라져
//       지역 판정이 무너진다.
//     ⚠ ./aptFacilityService 도 실제 모듈을 펼친다 — verifyCandidate·bonbun 은 DB 호출이 없는
//       순수 함수라 사본을 새로 만들지 않고 그대로 재사용한다(연도 허용오차 로직을 베끼면
//       드리프트 위험만 생긴다). getFacilitiesByKaptCodes·getAptListByLawdFromDb·resolveFacility
//       세 개만 고정 픽스처로 덮어쓴다.
//     ⚠ ./regulationsService 는 건드리지 않는다 — 지역 판정이 실제 스냅샷/폴백 로직을 타야
//       의미가 있다(DB 미설정 환경에선 하드코딩 FALLBACK_BY_KEY 로 정상 동작한다 — 네트워크 호출 없음).
//     ⚠ ../cache(node-cache)는 실제 모듈을 그대로 쓰되, 시작 시 'rec:' 로 시작하는 키를 지운다.
//       지우지 않으면 앞선 테스트가 남긴 최대 3시간짜리 결과 캐시에 맞아 스텁이 무시된 채
//       통과하는 위양성 초록이 나온다(characterization.test.js 의 'rent:' 청소와 같은 패턴).
//
//   [복원] require.cache 교체는 반드시 try/finally 로 원복한다 — 빠뜨리면 그 뒤 수천 줄의
//   테스트가 오염된 스텁으로 통과한다(실패가 아니라 위양성 초록이라 아무도 못 알아챈다).
//   finally 안에서 복원이 실제로 성사됐는지까지 단언한다.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * getAIRecommendations 의 외부 의존을 고정 픽스처로 바꾼 뒤 fn(propertyService) 을 실행하고,
 * 무슨 일이 있어도(예외 포함) require.cache 를 원래대로 되돌린다.
 *
 * @param {object} fixture
 *   - lawdCd, sigungu, umdNm: 대상 지역 기본값(개별 complex 에서 override 가능)
 *   - complexes: [{ name, buildYear, excluUseAr, price|prices, n, households, matched, parkingRatio }]
 *       · price(+n) 또는 prices(배열) 중 하나로 6개월 raw 거래를 생성한다(동일 평형 1개로 묶인다).
 *       · households: 세대수(확인). **undefined 로 두면** KAPT/DB 목록에서 그 단지를 아예 빼서
 *         "이름 매칭 실패 → 세대수 미확인" 을 재현한다(0 이 아니라 정말 모르는 상태).
 *       · matched: false 를 주면 households 가 있어도 매칭 목록에서 제외한다.
 *   - coordsByName / subwayByName: 특정 단지에만 좌표·최근접 역 거리를 주고 싶을 때(이름 키).
 *     기본은 전부 좌표 미해결(null) — 대부분의 계약(예산·게이트)엔 좌표가 필요 없다.
 *   - getNearbyAmenitiesFixed: getNearbyAmenities 가 항상 돌려줄 값(기본 null = 중간값 경로).
 * @param {(ps: typeof import('../services/propertyService')) => Promise<any>} fn
 */
async function _withRecStubs(fixture, fn) {
  const txPath = require.resolve('../services/transactionService');
  const facPath = require.resolve('../services/aptFacilityService');
  const aptInfoPath = require.resolve('../services/aptInfoService');
  const geoPath = require.resolve('../services/geocodeCacheService');
  const schoolPath = require.resolve('../services/schoolService');
  const brPath = require.resolve('../services/buildingRegisterService');
  const kakaoPath = require.resolve('../services/kakaoService');
  const naverPath = require.resolve('../services/naverDatalabService');
  const redisPath = require.resolve('../services/redisCache');
  const propPath = require.resolve('../services/propertyService');

  // ⚠ 통째로 대체하지 않는다 — require.cache 를 건드리기 전에 실제 모듈을 먼저 읽는다
  //   (LAWD_CODES·verifyCandidate·bonbun 등 상수/순수함수를 보존하기 위함).
  const realTx = require(txPath);
  const realFac = require(facPath);
  const recCache = require('../cache');

  const rawTx = [];
  const aptList = [];
  const facMap = new Map();
  (fixture.complexes || []).forEach((c, idx) => {
    const lawdCd = c.lawdCd || fixture.lawdCd;
    const prices = c.prices || Array.from({ length: c.n || 2 }, () => c.price);
    prices.forEach((price, i) => {
      rawTx.push({
        aptName: c.name, sigungu: c.sigungu || fixture.sigungu, umdNm: c.umdNm || fixture.umdNm,
        excluUseAr: c.excluUseAr || 84.9, buildYear: c.buildYear,
        floor: 3 + (i % 20), dealYear: 2026, dealMonth: 1, dealDay: (i % 28) + 1,
        dealAmount: price, lawdCd, aptSeq: `${lawdCd}-${idx}`, jibun: '',
      });
    });
    // households 가 undefined 면 이 단지는 아예 목록에 없다 — "KAPT 미등록/이름 매칭 실패" 를
    // 정직하게 재현한다(0을 넣어 '확인된 소형'으로 둔갑시키지 않는다 — [[unknown-treated-as-value]]).
    const matched = c.matched !== false && c.households !== undefined;
    if (matched) {
      const kaptCode = `K${String(idx).padStart(8, '0')}`;
      aptList.push({
        kaptCode, kaptName: c.name, as3: c.umdNm || fixture.umdNm, as4: '',
        jibunBon: '', kaptUsedate: `${c.buildYear}0101`,
      });
      if (c.households != null) {
        facMap.set(kaptCode, {
          kaptdaCnt: c.households, kaptUsedate: `${c.buildYear}0101`, kaptAddr: '',
          ...(c.parkingRatio ? { kaptdPcnt: Math.round(c.households * c.parkingRatio), kaptdPcntu: 0 } : {}),
        });
      }
    }
  });

  const coordsByName = fixture.coordsByName || {};
  const subwayByName = fixture.subwayByName || {};
  const coordKeyToName = new Map(); // resolveCoordBatch 가 만든 좌표를 nearestSubway 가 역추적한다

  const stubs = {
    [txPath]: {
      ...realTx,
      // ⚠ 네트워크/DB 함수만 덮어쓴다 — LAWD_CODES·LAWD_CODE_TO_NAME·RETIRED_LAWD_CODES 는 실값 그대로.
      getRegionRecentTransactions: async (lawdCd) => rawTx.filter(t => t.lawdCd === lawdCd),
    },
    [facPath]: {
      ...realFac, // verifyCandidate·bonbun 은 순수 함수라 실제 구현을 그대로 재사용한다(사본 금지)
      getFacilitiesByKaptCodes: async (codes) => {
        const m = new Map();
        for (const c of codes || []) if (facMap.has(c)) m.set(c, facMap.get(c));
        return m;
      },
      getAptListByLawdFromDb: async () => aptList,
      resolveFacility: async () => null, // 이름 매칭 실패 단지는 이 폴백도 실패해야 "미확인" 이 유지된다
    },
    [aptInfoPath]: {
      getAptListBySgg: async () => [], // DB(getAptListByLawdFromDb)가 1순위 소스 — 라이브 목록은 비워도 무방
      getAptBasisInfo: async () => null,
      getAptDtlInfo: async () => null,
      findAptByRoadName: async () => null,
    },
    [geoPath]: {
      resolveCoordBatch: async (inputs) => inputs.map((inp) => {
        const c = coordsByName[inp.aptName];
        if (!c) return null;
        coordKeyToName.set(`${c.lat},${c.lng}`, inp.aptName);
        return c;
      }),
      resolveCoord: async () => null, resolveCoordFromCacheOnly: () => null, getKakaoUsageStats: () => ({}),
      kakaoGeocode: async () => null, kakaoAddressGeocode: async () => null, markGeoFail: () => {},
      filterOutGeoFailed: (x) => x, buildKey: () => '', saveToDb: async () => {},
      NON_APT_PATTERNS: [], NON_APT_CATEGORY: new Set(), AMBIGUOUS_SGG: new Set(),
    },
    [schoolPath]: {
      resolveSchools: async () => [],
      resolveSchoolsBatch: async (inputs) => inputs.map(() => []),
      getCachedSchoolsBatch: async (inputs) => inputs.map(() => []), // 전부 히트(빈 배열) → 2차 조회가 안 걸린다
    },
    [brPath]: {
      getBuildingTitle: async () => null, // 건축물대장 보강도 실패해야 "미확인" 이 끝까지 유지된다
      parseJibun: () => null, resolveBjdong: async () => null, resolveJibun: async () => null, fetchRecapOnly: async () => null,
    },
    [kakaoPath]: {
      getCarMinutes: async () => null, getTransitMinutes: async () => null,
      countNearby: async () => null, countNearbyKeyword: async () => null,
      getNearbyAmenities: async () => (fixture.getNearbyAmenitiesFixed != null ? fixture.getNearbyAmenitiesFixed : null),
      keywordToCoord: async () => null,
      // 단지별로 다른 거리를 주는 결정적 함수 — 좌표(coordsByName)가 있는 단지만 조회되므로
      // 좌표→이름 역맵으로 그 단지에 지정된 값을 돌려준다(지정 없으면 "역 정보 없음"=null).
      nearestSubway: async (lat, lng) => {
        const nm = coordKeyToName.get(`${lat},${lng}`);
        const s = nm ? subwayByName[nm] : undefined;
        return s === undefined ? null : s;
      },
    },
    [naverPath]: {
      normalizeAptName: (s) => s, getCachedInterest: async () => new Map(), warmInterest: async () => ({}),
      hasKeys: () => false, keyShape: () => null, ANCHOR: '', fetchBatch: async () => ({}), median: () => 0,
    },
    [redisPath]: {
      rget: async () => null, // 항상 미스 — 픽스처가 실제로 실행되도록 강제한다(캐시 우회 방지)
      rset: async () => {},
    },
  };

  const saved = new Map();
  for (const [p, exp] of Object.entries(stubs)) {
    saved.set(p, require.cache[p]);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
  }
  saved.set(propPath, require.cache[propPath]);
  delete require.cache[propPath]; // propertyService 자신은 다시 읽어 top-level require 가 위 스텁을 보게 한다

  // 이전 테스트가 남긴 'rec:' 결과 캐시(최대 3h)에 맞아 스텁이 무시된 채 통과하는 위양성을 막는다.
  for (const k of recCache.keys()) if (k.startsWith('rec:')) recCache.del(k);

  try {
    const ps = require(propPath);
    return await fn(ps);
  } finally {
    for (const [p, prev] of saved) {
      if (prev) require.cache[p] = prev; else delete require.cache[p];
    }
    // 복원 확인 — 여기서 어긋나면 이후 수천 줄이 오염된 스텁으로 통과한다(위양성 초록이라 아무도 못 잡는다).
    for (const [p, prev] of saved) {
      assert.equal(require.cache[p], prev, `require.cache 복원 실패: ${p}`);
    }
  }
}


// ── Plan 047 (2026-09-06): KST 하루 경계 SSOT 단일화 — 남은 사본 3벌 + monthsWindow ──────────
//   왜 추가하나: utils/kstTime.js 가 SSOT 라고 선언했지만 dailyLimit·account·briefingService 가
//   각자 +9h 계산을 사본으로 들고 있었다(임포트 0). 사본을 SSOT 호출로 치환했고(Step 0 에서
//   치환 전/후 값이 KST 자정·연말·월말 경계에서 전부 일치함을 실측 대조 완료), 이 테스트가 그
//   계약을 고정한다 — 셋 중 하나라도 다시 SSOT 없이 자체 계산을 들이면 여기서 잡힌다.
//   ⚠ 절대 날짜는 "고정 입력"으로만 쓴다(Date.now() 에 의존하는 단언 금지) — 입력·기대값 둘 다 고정.
//   ⚠ Date.now 만 모킹하면 `new Date()`(무인자) 는 영향받지 않는다(V8 이 내부 시계를 직접 참조) —
//   briefingService.kstDayString() 의 무인자 분기를 검증하려면 생성자 자체를 모킹해야 한다.
// GATE-ASYNC-MOCK-2026-09-06 (Plan 060 ⑦): `try { return fn(); } finally { global.Date = OrigDate; }` 는
//   fn 이 동기면 문제없지만, fn 이 **async** 면 `fn()` 호출이 첫 await 에서 즉시 pending Promise 를
//   반환하고 그 순간 finally 가 실행돼 Date 를 원복해 버린다 — fn 내부의 첫 await **뒤** 코드는
//   이미 원래 Date 로 돌아간 채 실행된다(감사자 실측). account.js:351 이 첫 await **앞**에서 연도를
//   계산해 지금은 우연히 통과할 뿐이다 — `await Promise.resolve();` 한 줄만 그 앞에 넣으면(프로덕션
//   동작은 동일) 그 즉시 실패로 드러난다(fail-loud 이지 위양성 초록은 아니다. 다만 의미 보존
//   리팩터가 이유 없는 실패를 만든다는 점에서 이 헬퍼 자체가 결함이다). `await fn()` 으로 고쳐
//   finally 가 fn 의 프라미스가 실제로 끝난 뒤에만 실행되게 한다.
async function _withMockedDate(ts, fn) {
  const OrigDate = global.Date;
  class MockDate extends OrigDate {
    constructor(...args) {
      if (args.length === 0) super(ts);
      else super(...args);
    }
    static now() { return ts; }
  }
  global.Date = MockDate;
  try {
    return await fn();
  } finally {
    global.Date = OrigDate;
  }
}


function _mkRecordsRes() {
  const r = { headers: {}, code: 200, body: null };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}



// ══════════════════════════════════════════════════════════════════════════
// Plan 051 — 챗이 apt_master(정식 KAPT 등록명)를 보게 하고, 국토부에 A/B 로 분리
//   등록된 한 단지를 합산해 답한다. 운영자 재현: "공릉 풍림아이원 시세"가 "찾지 못했어요"로
//   끝났다(그 단지는 DB 에 있다 — molit 원본만 풍림아파트A/B 로 나뉘어 있었다).
// ══════════════════════════════════════════════════════════════════════════

// 아래 두 헬퍼는 이 섹션의 통합 테스트가 공유한다 — PostgREST 쿼리 빌더를 흉내 낸
// 최소 스텁(체이닝 메서드는 상태만 기록, then() 에서 필터를 실제로 적용).
function _mockPgTable(rows) {
  const state = { filters: [], order: null, limitN: null, range: null };
  const applyOne = (r, f) => {
    const v = r[f.col];
    if (f.op === 'eq') return v === f.val;
    if (f.op === 'is') return f.val === null ? (v === null || v === undefined) : v === f.val;
    if (f.op === 'gte') return String(v) >= String(f.val);
    if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(v);
    if (f.op === 'ilike') {
      const raw = String(f.val);
      const lead = raw.startsWith('%'), trail = raw.endsWith('%');
      const core = raw.replace(/^%/, '').replace(/%$/, '').toLowerCase();
      const hay = String(v == null ? '' : v).toLowerCase();
      if (lead && trail) return hay.includes(core);
      if (trail) return hay.startsWith(core);
      if (lead) return hay.endsWith(core);
      return hay === core;
    }
    return true;
  };
  const s = {
    select() { return s; },
    eq(col, val) { state.filters.push({ op: 'eq', col, val }); return s; },
    ilike(col, val) { state.filters.push({ op: 'ilike', col, val }); return s; },
    is(col, val) { state.filters.push({ op: 'is', col, val }); return s; },
    gte(col, val) { state.filters.push({ op: 'gte', col, val }); return s; },
    in(col, val) { state.filters.push({ op: 'in', col, val }); return s; },
    order(col, opts) { state.order = { col, asc: !(opts && opts.ascending === false) }; return s; },
    limit(n) { state.limitN = n; return s; },
    range(a, b) { state.range = [a, b]; return s; },
    then(resolve) {
      let data = rows.filter(r => state.filters.every(f => applyOne(r, f)));
      if (state.order) {
        const { col, asc } = state.order;
        data = [...data].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (state.range) data = data.slice(state.range[0], state.range[1] + 1);
      if (state.limitN != null) data = data.slice(0, state.limitN);
      resolve({ data, error: null });
    },
  };
  return s;
}


function _mockAptAdmin(tables) {
  return { from: (t) => _mockPgTable((tables && tables[t]) || []) };
}


// 챗 라우터를 DB 스텁과 함께 새로 불러온다 — db/client 를 require.cache 에서 갈아치운 뒤
// chatDataRouter 자신도 캐시에서 지워야 새 destructure 가 스텁을 집는다(이 파일의 기존 관례).
function _requireRouterWithAdmin(admin) {
  const clientPath = require.resolve('../db/client');
  const routerPath = require.resolve('../services/chatDataRouter');
  const saved = { client: require.cache[clientPath], router: require.cache[routerPath] };
  require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: { getSupabaseAdmin: () => admin, hasAdminEnv: () => true } };
  delete require.cache[routerPath];
  const router = require('../services/chatDataRouter');
  return {
    router,
    restore() {
      if (saved.client) require.cache[clientPath] = saved.client; else delete require.cache[clientPath];
      if (saved.router) require.cache[routerPath] = saved.router; else delete require.cache[routerPath];
    },
  };
}


const _NO_PROMO = /사세요|파세요|매수하세요|추천드려요|오를 겁니다|떨어질 겁니다/;



// ── Plan 056 (2026-09-06): 프론트 사본 3종 — 등급 라벨 · 필드명 · 주석 드리프트 ──────────
//   [왜 추가하나] Plan 041 이 backend/services/analysisService.js 의 조건 카드에서 지운 등급 표현이
//     frontend/index.html 의 pctHtml(가격 위치)·gapHtml(전세가율) 렌더 사본에는 그대로 남아 있었다 —
//     같은 화면에서 사용자가 중립화된 조건 카드 바로 아래에서 등급 라벨을 다시 보는 상태였다.
//     RULE-DETERMINISTIC-FRONT-2026-09-06 로 정리했다. 아래 테스트는 등급 라벨이 되살아나면 fail 하고,
//     수치·red 위험 고지·pop 경로는 건드리지 않았는지도 함께 고정한다.
//   [방식] 이 저장소의 확립된 패턴대로 index.html 에서 실제 렌더 블록을 문자열로 그대로 꺼내
//     new Function 으로 실행한다(정규식 매칭이 아니라 진짜 실행 결과를 본다).
function _plan056Html() {
  if (!_plan056Html._cache) {
    const fs2 = require('node:fs');
    const path2 = require('node:path');
    _plan056Html._cache = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');
  }
  return _plan056Html._cache;
}



function _plan056Extract(startTok, endTok) {
  const html = _plan056Html();
  const s = html.indexOf(startTok);
  if (s < 0) throw new Error('Plan 056 테스트: 시작 토큰을 못 찾았다 — 렌더 코드가 옮겨졌다: ' + startTok);
  const e = html.indexOf(endTok, s);
  if (e < 0) throw new Error('Plan 056 테스트: 끝 토큰을 못 찾았다 — 렌더 코드가 옮겨졌다: ' + endTok);
  return html.slice(s, e);
}



function _plan056RunPct(pct, extraD) {
  const block = _plan056Extract("let pctHtml=''", '// ─ 월별 거래량 차트');
  const d = Object.assign({
    percentile: pct,
    percentileLow: Math.max(0, pct - 5),
    percentileHigh: Math.min(100, pct + 5),
    percentileN: 40,
    filteredTxCount: 40,
    txCount: 40,
    anomalyCount: 0,
  }, extraD);
  return new Function('d', 'reliability', block + '\nreturn pctHtml;')(d, 'HIGH');
}



function _plan056RunGap(jeonseRate, extraG, extraD) {
  const block = _plan056Extract("let gapHtml=''", '// ─ 실투자금 계산기');
  const _escHtml = (x) => String(x == null ? '' : x)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const g = Object.assign({ jeonseRate, gap: 3.5, avgSale: 8.5, avgJeonse: 5 }, extraG);
  const d = Object.assign({
    aptName: '테스트단지', jeonseCount: 12, jeonseReliability: 'HIGH',
    recentJeonseTx: [], molitAvailable: true, gapData: g,
  }, extraD);
  return new Function('d', '_escHtml', block + '\nreturn gapHtml;')(d, _escHtml);
}



function _plan056RunSheetMeta(p, kind) {
  const block = _plan056Extract('const meta=[(p.buildYear', "document.getElementById('msName')").trimEnd();
  return new Function('p', 'kind', block + '\nreturn meta;')(p, kind);
}



// ── Plan 052 (2026-09-06): 검색창 자동완성 — 공백 제거 변형 조회 ──────────────────
//   [왜] 운영자 재현 "공릉 풍림아이원" → 0건. molit_apt_index 이름의 0.8%(189개)·apt_master
//   이름의 15.4%(2,251개)가 공백을 포함하는데, 기존 qApt 는 끝 "아파트" 접미사만 제거하고
//   중간 공백은 그대로 둬서 `%공백 포함 질의%` ILIKE 가 원리적으로 0건이 됐다.
//   [방식] billing 테스트의 require.cache 스텁 패턴을 그대로 써서 db/client 를 목으로 갈아치우고
//   search.js 의 실제 '/apt' 핸들러를 꺼내 호출한다 — 정규식 형태 검사가 아니라 실제 실행 결과로
//   "조건부로만 조회가 추가되는지" · "실패해도 500 이 안 되는지" · "추가 결과가 실제로 반영되는지"를 본다.
//   프로덕션 코드는 바꾸지 않는다.
function _searchAdminStub(routes) {
  const seen = { calls: [] };
  function makeChain(table) {
    let col = null, pattern = null;
    const c = {
      select: () => c,
      ilike: (cCol, cPattern) => { col = cCol; pattern = cPattern; return c; },
      order: () => c,
      limit: () => c,
      abortSignal: () => c,
      then: (resolve, reject) => {
        seen.calls.push({ table, col, pattern });
        const match = (routes || []).find((r) => r.table === table && r.col === col && r.pattern === pattern);
        if (match && match.reject) {
          return Promise.reject(match.error || new Error('stub-fail')).then(resolve, reject);
        }
        const out = match ? match.result : { data: [], error: null };
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return c;
  }
  return { client: { from: (table) => makeChain(table) }, seen };
}


// db/client·search.js 를 require.cache 스텁으로 갈아치우고 '/apt' 핸들러를 꺼내 fn 에 넘긴다.
//   ⚠ search.js 는 모듈 로드 시 `const { getSupabaseReadonly } = require('../db/client')` 로
//   구조분해하므로, db/client 스텁을 심은 **뒤** search.js 캐시를 지워 재로드해야 스텁이 반영된다
//   (billing 테스트의 `_withBillingStub` 과 같은 이유·같은 순서).
async function _withSearchDbStub(routes, fn) {
  const clientPath = require.resolve('../db/client');
  const searchPath = require.resolve('../routes/search');
  // 분할 후 순서의존 수정(Plan 066): search.js 는 로드 시 geocodeCacheService·schoolService 등을
  //   즉시(top-level) require 하고, 그 서비스들은 각자 module-load 시점에 db/client.hasAdminEnv()
  //   를 호출한다. 이 파일이 실행되는 첫 테스트에서 그 서비스들이 아직 한 번도 로드된 적이
  //   없으면, 아래에서 심는 축약 스텁(getSupabaseAdmin 등만 있고 hasAdminEnv 가 없다)이 그
  //   최초 로드 시점에 걸려 "hasAdminEnv is not a function" 으로 죽는다(단일 파일이던 시절엔
  //   더 앞쪽 다른 테스트가 실제 db/client 로 search.js 를 먼저 로드해 둔 덕에 드러나지 않았다).
  //   실제 환경으로 한 번 미리 로드해 그 자식 모듈들의 top-level 상수를 실제 db/client 기준으로
  //   먼저 캐시시켜 둔다 — 아래에서 search.js 자신의 캐시만 지우므로 이미 로드된 자식은 안전하다.
  require('../routes/search');
  const saved = { c: require.cache[clientPath], s: require.cache[searchPath] };
  const { client, seen } = _searchAdminStub(routes);
  require.cache[clientPath] = {
    id: clientPath, filename: clientPath, loaded: true,
    exports: { getSupabaseAdmin: () => client, getSupabaseReadonly: () => client, getUserScopedClient: () => client },
  };
  delete require.cache[searchPath];
  try {
    const router = require('../routes/search');
    const layer = router.stack.find((l) => l.route && l.route.path === '/apt');
    assert.ok(layer, "search 라우터에서 '/apt' 를 찾지 못했다(경로 변경 시 이 테스트도 갱신할 것)");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    return await fn(handler, seen);
  } finally {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.s) require.cache[searchPath] = saved.s; else delete require.cache[searchPath];
  }
}



// ══════════════════════════════════════════════════════════════════════════
// Plan 057 (2026-09-06) — "지역 + 단지명" 질의를 지역으로 좁혀 찾는다.
//   [왜] 운영자 재현: "대치 은마 시세"가 051 배포 후에도 "찾지 못했어요"였다. 051 은 공백만
//   지워 "대치은마"로 붙이는데, MOLIT·apt_master 는 "은마"로만 저장해 붙인 문자열은 원리적으로
//   0건이다. 지역 토큰(대치)을 분리해 이름(은마)만 남기면 찾을 수 있다(DB 실측, 계획서 참조).
//   [범위] aptNameMatch.splitRegionName(신설, 순수 함수) + chatDataRouter._market 의 실패
//   직전 재시도 경로만. _regionMarket·_resolveRegionRows·classifyIntent 는 손대지 않았다.
// ══════════════════════════════════════════════════════════════════════════

// 이중 ilike 체인 추적기 — REGION-SPLIT-2026-09-06 재시도 쿼리(.ilike(지역%).ilike(%이름%))만
//   갖는 고유 시그니처다(기존 _market 쿼리는 전부 ilike 를 체인 안에서 1번만 쓴다). 이 카운터로
//   "성공 경로에서 재시도 조회가 실제로 0번 실행됐는지"를 총 호출 수 추측 없이 직접 잰다.
function _adminWithIlikeChainTracker(tables) {
  const base = _mockAptAdmin(tables);
  const tracker = { doubleIlikeChains: 0, fromCalls: 0 };
  const admin = {
    from(t) {
      tracker.fromCalls++;
      const table = base.from(t);
      let ilikeCount = 0;
      const origIlike = table.ilike;
      table.ilike = function (col, val) {
        ilikeCount++;
        const res = origIlike.call(table, col, val);
        if (ilikeCount === 2) tracker.doubleIlikeChains++;
        return res;
      };
      return table;
    },
  };
  return { admin, tracker };
}


// 절대 날짜 하드코딩 금지(레포 교훈 test-absolute-date-rot) — "지금부터 N일 전"으로 계산.
const _recentDealDate = (daysAgo) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); return d.toISOString().slice(0, 10); };



// ── MV-STALE-WATCH-2026-09-06 (Plan 058) ──────────────────────────────────────────────────────
// [실측 배경] 2026-09-06 라이브: molit_apt_index(검색 색인) 최신 거래일 2026-08-14 vs
//   molit_transactions(원본) 2026-09-04 — 21일 지연, 418개 단지가 검색에서 사라졌다. 원인은
//   health.crons.mvRefreshError 에 매일 정직하게 남아 있었지만("8초 statement timeout") 경보가
//   없어 아무도 보지 않았다. 이 계획은 DB 를 고치지 않는다(운영자 승인 대기) — 같은 실패가 또
//   조용히 지나가지 않도록 ① 실패를 경보로 ② 낡음 자체를 숫자로 남긴다.
//
// [실행 방식] cron.js 의 handleMolitIngest 는 GET/POST 양쪽에 같은 함수가 물려 있다. authorizeCron
//   미들웨어는 router.use 레이어라 라우트 핸들러를 직접 뽑아 호출하면 우회된다(인증은 이미 별도
//   계약 테스트가 고정한다) — 이 파일의 기존 'OG 라우트' 테스트와 같은 기법이다. db/client·
//   jobs/molitIngest·@sentry/node·services/cronStats 를 require.cache 로 갈아치운 뒤 cron.js 자신의
//   캐시만 지워 다시 불러온다(이 파일의 require.cache 스텁 관례 그대로).
function _mockCronAdmin({ rpcError, mvDate, txDate, mvErr, txErr } = {}) {
  const mkQuery = (row, err) => {
    const q = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: err ? null : row, error: err || null }),
    };
    return q;
  };
  return {
    rpc: () => ({ abortSignal: () => Promise.resolve({ error: rpcError || null }) }),
    from: (table) => {
      if (table === 'molit_apt_index') return mkQuery({ recent_deal_date: mvDate }, mvErr);
      if (table === 'molit_transactions') return mkQuery({ deal_date: txDate }, txErr);
      return mkQuery(null, null);
    },
  };
}


function _requireCronMolitHandler(admin) {
  const dbPath = require.resolve('../db/client');
  const jobPath = require.resolve('../jobs/molitIngest');
  const sentryPath = require.resolve('@sentry/node');
  const statsPath = require.resolve('../services/cronStats');
  const cronPath = require.resolve('../routes/cron');
  const saved = {
    db: require.cache[dbPath], job: require.cache[jobPath],
    sentry: require.cache[sentryPath], stats: require.cache[statsPath], cron: require.cache[cronPath],
  };
  const sentryCalls = [];
  const statsCalls = [];
  require.cache[sentryPath] = { id: sentryPath, filename: sentryPath, loaded: true, exports: {
    captureMessage: (msg, opts) => sentryCalls.push({ msg, opts }),
    captureException: () => {},
  } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => admin } };
  require.cache[jobPath] = { id: jobPath, filename: jobPath, loaded: true, exports: {
    runMolitIngest: async () => ({ ok: 5, err: 0, skipped: 0, elapsedMs: 10, monthsRange: 'test' }),
    molitErrReason: () => null,
  } };
  require.cache[statsPath] = { id: statsPath, filename: statsPath, loaded: true, exports: {
    recordCronRun: (name, summary) => { statsCalls.push({ name, summary }); return Promise.resolve(); },
  } };
  delete require.cache[cronPath];
  const cronRouter = require('../routes/cron');
  const layer = cronRouter.stack.find(l => l.route && l.route.path === '/molit-ingest' && l.route.methods.get);
  if (!layer) throw new Error('GET /molit-ingest 라우트를 못 찾았다 — cron.js 구조가 바뀌었다');
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return {
    handle, sentryCalls, statsCalls,
    restore() {
      if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
      if (saved.job) require.cache[jobPath] = saved.job; else delete require.cache[jobPath];
      if (saved.sentry) require.cache[sentryPath] = saved.sentry; else delete require.cache[sentryPath];
      if (saved.stats) require.cache[statsPath] = saved.stats; else delete require.cache[statsPath];
      if (saved.cron) require.cache[cronPath] = saved.cron; else delete require.cache[cronPath];
    },
  };
}


function _mkCronRes() {
  const r = { code: 200, body: null };
  r.json = (b) => { r.body = b; return r; };
  r.status = (c) => { r.code = c; return r; };
  return r;
}



// ── Plan 061 (2026-09-06): sendOnce 세션 1회 가드 — 스토리지 차단 시 인메모리 폴백 ──────────
//   [배경] frontend/index.html 의 window._attr.sendOnce 는 sessionStorage.getItem/setItem 이
//     throw 하면(사파리 프라이빗 모드·사이트 데이터 전면 차단 등) 실패를 기억할 인메모리 플래그가
//     없어 catch 뒤의 this.send(event) 가 조건 없이 실행됐다 — 옛 주석은 "가드 없이 1회 보낸다"고
//     적었지만 실제로는 호출할 때마다(예: 5회 호출 시 5회) 보냈다(적대 감사 실측).
//     SENDONCE-MEMFALLBACK-2026-09-06 로 인메모리 폴백을 추가해 스토리지가 실패해도 그 페이지가
//     살아있는 동안은 1회를 보장한다. 아래는 이 저장소의 확립된 패턴대로 sendOnce 블록을 문자열로
//     그대로 꺼내 new Function 으로 실행한다(정규식 매칭이 아니라 진짜 실행 결과를 본다).
//   [앵커] 문자열 탐색만 쓰고 매치 수를 단언한다(정규식 `\n` 앵커가 CRLF 파일에서 0매치가 되는
//     레포 기존 함정 회피).
function _plan061SendOnceFn(sessionStorageStub, sentOnceMem) {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const fe = fs2.readFileSync(path2.join(__dirname, '../../frontend/index.html'), 'utf8');

  const startMarker = 'sendOnce: function(event){';
  const startCount = fe.split(startMarker).length - 1;
  assert.equal(startCount, 1, `sendOnce 정의가 정확히 1곳이어야 하는데 ${startCount}곳이다`);
  const startIdx = fe.indexOf(startMarker);
  const endMarker = '\n    };';
  const endIdx = fe.indexOf(endMarker, startIdx);
  assert.ok(endIdx > startIdx, 'sendOnce 종료 지점(반환 객체 리터럴 닫힘)을 찾지 못했다');

  const block = fe.slice(startIdx, endIdx);
  const fnSrc = block.replace(/^sendOnce:\s*/, '').replace(/,\s*$/, '');
  return new Function('sessionStorage', '_sentOnceMem', `return (${fnSrc});`)(sessionStorageStub, sentOnceMem);
}



function _plan061NormalStorage() {
  const store = {};
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
}


function _plan061SetItemThrows() {
  const store = {};
  return { getItem: (k) => (k in store ? store[k] : null), setItem: () => { throw new Error('QuotaExceededError'); } };
}


function _plan061GetItemThrows() {
  return { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); } };
}



// ══════════════════════════════════════════════════════════════════════════
// Plan 062 (2026-09-06) — 검색창('/api/search/apt')도 "지역 + 단지명" 질의를
//   splitRegionName 재시도로 좁혀 찾는다(챗은 057/059 로 이미 됐다).
//   [왜] 운영자 요구 "지역+아파트 명이면 대충이라도 검색은 되어야지" — 챗은 라이브로 확인됐지만
//   검색창은 그대로였다. Plan 052 의 공백 제거 변형은 "대치 은마"를 "대치은마"로 붙이기만
//   해서, molit_apt_index·apt_master 어디에도 없는 이름이라 여전히 0건이었다(DB 실측,
//   계획서 062 참조). splitRegionName(aptNameMatch.js, 057 신설·059 개선)은 이 파일에서
//   **읽기(임포트)만** 한다 — 구현은 고치지 않는다(챗이 같은 함수를 쓴다).
//   [방식] 위 Plan 052 테스트의 require.cache 스텁 관례(_withSearchDbStub)를 그대로 쓰되,
//   지역 분리 재시도는 이중 .ilike 체인(.ilike(region%).ilike(%name%))이라 **마지막 호출만
//   기록하는 기존 _searchAdminStub 으로는 못 잰다** — 체인 전체를 기록하는 스텁을 새로
//   추가한다(기존 스텁·테스트는 그대로 둔다, 파일 끝에만 추가).
// ══════════════════════════════════════════════════════════════════════════

// 이중 ilike 체인까지 기록하는 스텁 — chatDataRouter 테스트의 _adminWithIlikeChainTracker 와
//   같은 목적(왕복을 "총 호출 수" 추측이 아니라 신호로 직접 잰다)을 search.js 의
//   require.cache 스텁 관례에 맞춰 다시 구현한다. routes 는 { table, ilikes:[{col,pattern},...],
//   result } 형태로 체인 전체(호출 순서·개수)를 매칭한다 — 기존 _searchAdminStub 의
//   "마지막 호출만" 매칭과 달리 두 조건(region ILIKE + name ILIKE)을 모두 검증할 수 있다.
function _searchAdminStubChain(routes) {
  const seen = { calls: [], doubleIlikeChains: 0 };
  function makeChain(table) {
    const ilikes = [];
    const c = {
      select: () => c,
      ilike: (col, pattern) => { ilikes.push({ col, pattern }); return c; },
      order: () => c,
      limit: () => c,
      abortSignal: () => c,
      then: (resolve, reject) => {
        seen.calls.push({ table, ilikes: ilikes.slice() });
        if (ilikes.length === 2) seen.doubleIlikeChains++;
        const match = (routes || []).find((r) =>
          r.table === table &&
          r.ilikes.length === ilikes.length &&
          r.ilikes.every((ri, i) => ri.col === ilikes[i].col && ri.pattern === ilikes[i].pattern)
        );
        if (match && match.reject) {
          return Promise.reject(match.error || new Error('PLAN062-stub-fail')).then(resolve, reject);
        }
        const out = match ? match.result : { data: [], error: null };
        return Promise.resolve(out).then(resolve, reject);
      },
    };
    return c;
  }
  return { client: { from: (table) => makeChain(table) }, seen };
}


// db/client·search.js 를 require.cache 스텁으로 갈아치우는 절차는 _withSearchDbStub 과 동일한
//   이유(search.js 가 모듈 로드 시 구조분해하므로 스텁을 심은 뒤 캐시를 지우고 재로드해야 한다).
async function _withSearchDbStubChain(routes, fn) {
  const clientPath = require.resolve('../db/client');
  const searchPath = require.resolve('../routes/search');
  // 분할 후 순서의존 수정(Plan 066): _withSearchDbStub 과 같은 이유 — search.js 의 top-level
  //   자식 require(geocodeCacheService 등)를 실제 db/client 로 먼저 한 번 로드해 둔다.
  require('../routes/search');
  const saved = { c: require.cache[clientPath], s: require.cache[searchPath] };
  const { client, seen } = _searchAdminStubChain(routes);
  require.cache[clientPath] = {
    id: clientPath, filename: clientPath, loaded: true,
    exports: { getSupabaseAdmin: () => client, getSupabaseReadonly: () => client, getUserScopedClient: () => client },
  };
  delete require.cache[searchPath];
  try {
    const router = require('../routes/search');
    const layer = router.stack.find((l) => l.route && l.route.path === '/apt');
    assert.ok(layer, "search 라우터에서 '/apt' 를 찾지 못했다(경로 변경 시 이 테스트도 갱신할 것)");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    return await fn(handler, seen);
  } finally {
    if (saved.c) require.cache[clientPath] = saved.c; else delete require.cache[clientPath];
    if (saved.s) require.cache[searchPath] = saved.s; else delete require.cache[searchPath];
  }
}



// ── APT-PAGE-INFO-2026-09-06 (Plan 063): 공개 단지 페이지에 단지정보(K-apt) 카드를 붙인다 ──────
//   [실행 테스트] aptPage.js 는 db/client·services/transactionService 를 함수 안에서 그때그때
//   require() 한다 — 라우터 자신을 다시 로드할 필요 없이, 호출 시점에 require.cache 를 갈아치우면
//   그대로 먹힌다(이 파일의 기존 require.cache 스텁 관례). 매칭 규칙(유사도 매칭 금지)이 새면
//   이 스위트가 잡아야 한다([[apt-kapt-mismatch-identity-gate]] — 유사도 단독 매칭 전국 956건 오매칭 이력).
function _p063MockTable(rows, error) {
  const s = {
    select() { return s; },
    eq() { return s; },
    limit() { return s; },
    then(resolve) {
      if (error) return resolve({ data: null, error });
      resolve({ data: rows, error: null });
    },
  };
  return s;
}


function _p063MockAdmin(tables, errorTables) {
  return {
    from(t) {
      const rows = (tables && tables[t]) || [];
      const err = (errorTables && errorTables[t]) || null;
      return _p063MockTable(rows, err);
    },
  };
}


function _p063MockRes() {
  const r = { headers: {}, statusCode: 200, body: null };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.type = () => r;
  r.send = (b) => { r.body = b; return r; };
  return r;
}


function _p063Idx(aptName) {
  // idx(molit_apt_index) 가 정체성(aptName·lawdCd·umdNm)을 준다 — 거래가 0건이어도 af 가 null 이 되지 않는다.
  return { apt_seq: '11680-9001', apt_name: aptName, lawd_cd: '11680', sigungu: '강남구', umd_nm: '대치동', build_year: 1999, recent_deal_date: '2026-08-01', deal_count: 5 };
}


const _P063_STAT = {
  dealCount: 5, avgPriceAuk: '12.3', medianPrice: 123000, minPrice: 110000, maxPrice: 135000,
  recentDeal: '2026-08-01', trimmedAvgPrice: 122000, pyeongStats: [], rawList: [], floorAdjustmentNote: '',
};


// statFixture 가 있으면 거래 1건짜리로 취급(stat 이 생긴다) — null 이면 거래 0(thin) 케이스.
async function _p063Run({ aptMasterRows, aptMasterError, idxRow, statFixture }) {
  const dbPath = require.resolve('../db/client');
  const svcPath = require.resolve('../services/transactionService');
  // 분할 후 순서의존 수정(Plan 066): aptPage.js 의 loadAptFacts 는 요청 시점에 그때그때
  //   services/priceRecordsService 를 require() 하는데, 그 파일은 자신의 top-level 에서
  //   `Object.entries(transactionService.LAWD_CODES)` 로 파생 상수(CODE_TO_FULLNAME 등)를
  //   미리 계산한다. 아래에서 심는 transactionService 스텁은 getTransactionsByAptSeq·
  //   analyzeTransactions 만 있고 LAWD_CODES 가 없다 — priceRecordsService 가 이 프로세스에서
  //   처음 로드되는 순간이 하필 스텁이 걸려 있는 시점이면 그 top-level 계산이 죽는다(단일 파일
  //   이던 시절엔 더 앞쪽 다른 테스트가 실제 transactionService 로 먼저 로드해 둔 덕에 드러나지
  //   않았다). 실제 환경으로 한 번 미리 로드해 그 파생 상수를 실제 LAWD_CODES 기준으로 캐시시켜
  //   둔다 — 이미 로드된 모듈은 아래 svcPath 캐시 교체와 무관하게 그대로 쓰인다.
  require('../services/priceRecordsService');
  const saved = { db: require.cache[dbPath], svc: require.cache[svcPath] };
  const admin = _p063MockAdmin(
    { molit_apt_index: idxRow ? [idxRow] : [], apt_master: aptMasterRows || [] },
    aptMasterError ? { apt_master: aptMasterError } : null,
  );
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getSupabaseAdmin: () => admin } };
  require.cache[svcPath] = { id: svcPath, filename: svcPath, loaded: true, exports: {
    getTransactionsByAptSeq: async () => (statFixture ? [{ _p063fixture: true }] : []),
    analyzeTransactions: () => (statFixture ? [statFixture] : []),
  } };
  try {
    const router = require('../routes/aptPage');
    const layer = router.stack.find((l) => l.route && l.route.path === '/:aptSeq');
    const handle = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = _p063MockRes();
    await handle({ params: { aptSeq: '11680-9001' } }, res, () => {});
    return res;
  } finally {
    if (saved.db) require.cache[dbPath] = saved.db; else delete require.cache[dbPath];
    if (saved.svc) require.cache[svcPath] = saved.svc; else delete require.cache[svcPath];
  }
}



// ── Plan 064 (2026-09-06): 갭 카드 전세가율에 표본 완전성 표기가 없다 (046 의 마지막 절반) ──────
//   [왜] Plan 046 이 조건 카드(전세가율)에는 표본 완전성(jeonseBasisDesc)을 밝히게 했는데, 같은
//   화면(t4)의 갭 카드(gap-grid)는 같은 수치를 아무 단서 없이 보여줬다 — 국토부 조회가 일부 달
//   실패해도 사용자는 몰랐다. 백엔드가 gapData.jeonseBasis 로 같은 문자열을 payload 에 실어 보내고,
//   프론트는 그 문자열을 그대로 그린다(임계값·산술 사본 금지 — 취득세 tier 2사본 결함 재발 방지).
//   [방식] 이 저장소 확립 패턴(소스 문자열 추출 + new Function 실행)을 그대로 쓴다.
function _plan064ExtractGapAttach() {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../services/analysisService.js'), 'utf8');
  const startTok = 'const gapData = calcGap(filteredTx, jeonsePure);';
  const endTok = '// LOW 이상일 때만 시세 위치 요약 계산';
  const s = src.indexOf(startTok);
  if (s < 0) throw new Error('Plan 064 테스트: gapData 시작 토큰을 못 찾았다 — 소스가 옮겨졌다');
  const e = src.indexOf(endTok, s);
  if (e < 0) throw new Error('Plan 064 테스트: 끝 토큰을 못 찾았다 — 소스가 옮겨졌다');
  return src.slice(s, e);
}



function _plan064RunGapAttach(jTotal, jFailed) {
  const { _internals } = require('../services/analysisService');
  const block = _plan064ExtractGapAttach();
  const filteredTx = [{ dealAmount: 85000 }];   // 8.5억 (만원 단위)
  const jeonsePure = [{ deposit: 50000 }];      // 5억
  const fn = new Function('calcGap', 'computeJeonseBasisDesc', 'filteredTx', 'jeonsePure', '_jTotal', '_jFailed',
    block + '\nreturn gapData;');
  return fn(_internals.calcGap, _internals.computeJeonseBasisDesc, filteredTx, jeonsePure, jTotal, jFailed);
}



function _plan064ExtractNoneReliability() {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../services/analysisService.js'), 'utf8');
  const startTok = "const percentileObj = reliability !== 'NONE' ? calcPricePercentile(filteredTx, priceW) : null;";
  const endTok = 'const buySignal = marketSummary; // 하위 호환';
  const s = src.indexOf(startTok);
  if (s < 0) throw new Error('Plan 064 NONE 테스트: 시작 토큰을 못 찾았다 — 소스가 옮겨졌다');
  const e = src.indexOf(endTok, s);
  if (e < 0) throw new Error('Plan 064 NONE 테스트: 끝 토큰을 못 찾았다 — 소스가 옮겨졌다');
  return src.slice(s, e + endTok.length);
}



function _plan064RunNoneReliability(opts) {
  const { _internals } = require('../services/analysisService');
  const block = _plan064ExtractNoneReliability();
  const saleTx = [{ dealAmount: 85000 }];
  const filteredTx = saleTx;
  const jeonsePure = [{ deposit: 50000 }];
  const priceW = 85000;
  const fn = new Function(
    'reliability', 'calcPricePercentile', 'calcVolumeSignal', 'calcGap', 'computeJeonseBasisDesc',
    'summarizeMarketSignal', 'saleTx', 'filteredTx', 'jeonsePure', 'priceW', '_jTotal', '_jFailed',
    block + '\nreturn { gapData, marketSummary };'
  );
  return fn(
    opts.reliability, _internals.calcPricePercentile, _internals.calcVolumeSignal, _internals.calcGap,
    _internals.computeJeonseBasisDesc, _internals.calcBuySignal, saleTx, filteredTx, jeonsePure, priceW,
    opts.jTotal, opts.jFailed
  );
}

module.exports = {
  _billingHandler,
  _mockRes,
  _mockAdmin,
  _hasFilter,
  _withBillingStub,
  _confirmOk,
  _withBillingStub2,
  _req,
  _authFn,
  _mkJwtPayload,
  _reportFn,
  LAWD,
  _authorizeCron,
  _regPairFns,
  _reg,
  _shareHandler,
  _shareMockRes,
  _SHARE_EXPAND_PAIR,
  _withRecStubs,
  _withMockedDate,
  _mkRecordsRes,
  _mockPgTable,
  _mockAptAdmin,
  _requireRouterWithAdmin,
  _NO_PROMO,
  _plan056Html,
  _plan056Extract,
  _plan056RunPct,
  _plan056RunGap,
  _plan056RunSheetMeta,
  _searchAdminStub,
  _withSearchDbStub,
  _adminWithIlikeChainTracker,
  _recentDealDate,
  _mockCronAdmin,
  _requireCronMolitHandler,
  _mkCronRes,
  _plan061SendOnceFn,
  _plan061NormalStorage,
  _plan061SetItemThrows,
  _plan061GetItemThrows,
  _searchAdminStubChain,
  _withSearchDbStubChain,
  _p063MockTable,
  _p063MockAdmin,
  _p063MockRes,
  _p063Idx,
  _P063_STAT,
  _p063Run,
  _plan064ExtractGapAttach,
  _plan064RunGapAttach,
  _plan064ExtractNoneReliability,
  _plan064RunNoneReliability,
};
