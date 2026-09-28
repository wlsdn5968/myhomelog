# 128 — Sentry 로 나가는 요청 본문·쿠키·토큰·IP·비밀값·사용자 ID 차단 (운영 SDK 10.75.3)

**작성 기준 커밋**: `620bf3b` (2026-09-28) · **출처**: 운영자 요청 2026-09-28 "보안적으로도 문제 없는지 제대로 확인해주고" — Sentry 11 전환 사전 실측 중 **현재 운영(10.75.3)** 의 누출을 발견 · **운영자 승인 2026-09-28**("권고대로 진행해줘. 승인할게")
**성격**: 백엔드 1파일(`backend/sentry.js`) 로직 S + 신규 테스트 1 + 기존 가드 테스트 정규식 1줄. 프런트·DB·의존성·환경변수 변경 0.
**계획자 사전 검증**: 이 문서의 코드는 저장소 밖 사본에서 실행 확인했다 — 테스트 14/14(가드 7 + 신규 7) 통과 · ESLint(저장소 설정) 0 · **현재 코드로 되돌리면 E2E 가 실패**(음성 대조) · `@sentry/node` 11.0.0 으로 바꾸면 E2E 가 실패(의도된 가드, §6).
**개정 1 (같은 날)**: 초판 테스트는 E2E 자식 프로세스에 경로·표지를 환경변수(`process.env.SENTRY_JS`·`E2E_MARKERS`)로 넘겨 `npm run verify` 의 `scripts/check-env-example.js` 게이트(backend/**/*.js 의 `process.env.NAME` 을 `backend/.env.example` 과 대조)에 막혔다(실행자 STOP 보고 — 테스트 자체는 595/595 통과). → 명령행 인자로 넘기게 고쳤다. 테스트 표지도 저장소 관례(`.gitleaks.toml` allowlist `xxx+`)대로 `…-xxxx` 형식으로 바꾸고 이유 주석을 달았다. `backend/sentry.js`·가드 테스트는 초판과 같다.

## 1. 사실 (계획자 실측, 2026-09-28)

### 1-1. 같은 SDK·같은 옵션 실측 — 실제 전송 경로(가짜 수집 서버가 받은 envelope)
방법: `backend/sentry.js` 를 먼저 require 한 자식 프로세스 + 최소 express 앱, `SENTRY_DSN` 을 로컬 가짜 수집 서버로, 표본율 1. 요청에 쿠키·`Authorization: Bearer`·`x-vercel-oidc-token`·`X-Forwarded-For`·`x-vercel-ip-city/latitude`·JSON 본문(이름·전화)을 싣고, 핸들러에서 ECOS 형태(키를 **경로**에)·MOLIT 형태(키를 쿼리에)·Supabase 형태(`user_id=eq.<UUID>`) 외부 호출 뒤 예외.

| 이벤트 | 현재 코드(`620bf3b`)에서 전송된 것 |
|---|---|
| 성능(transaction, 운영 표본 10%) | 쿠키 원문 · Authorization Bearer 원문 · x-vercel-oidc-token 원문 · 클라이언트 IP(`contexts.trace.data['http.client_ip']`) · 위치 헤더(도시·위도) · 요청 본문(이름·전화) · ECOS 키(경로) · 사용자 UUID |
| 오류(event) | 쿠키(`request.cookies`) · x-vercel-oidc-token · 위치 헤더 · 요청 본문(`request.data`) · ECOS 키(breadcrumb url) |

- MOLIT 키·쿼리 `token` 은 SDK 가 이미 가린다 — 이름에 `key`·`token` 등이 든 **쿼리 파라미터** 값은 `[Filtered]`(`node_modules/@sentry/core/build/cjs/utils/data-collection/filtering-snippets.js` 의 `SENSITIVE_KEY_SNIPPETS`). 경로 세그먼트와 `user_id` 같은 이름은 거르지 않는다.
- 원인(SDK 10.75.3 소스): ① 들어오는 요청 본문 수집은 `maxIncomingRequestBodySize`(기본 `medium`)로만 켜고 끈다 — `sendDefaultPii:false` 와 무관(`@sentry/core/build/cjs/integrations/http/server-subscription.js:52-58`). `requestDataIntegration` 은 본문을 항상 붙인다(`@sentry/core/build/cjs/integrations/requestdata.js:30` 주석 "Always attach body data"). ② `beforeSend` 는 오류에만 불린다 — 성능 이벤트는 `beforeSendTransaction`. 지금 `backend/sentry.js` 에는 후자가 없다. ③ 기존 `beforeSend` 는 헤더 4개만 `[Filtered]` 로 바꾸고 `request.cookies`·`request.data` 는 그대로 둔다(`backend/sentry.js:78-104`).
- §2 적용 후 같은 실측: 두 이벤트 모두 표지 0.

### 1-2. 운영 Sentry 실측 (값은 조회하지 않고 건수만, 최근 30일)
- 백엔드 성능 이벤트 165,650건. 그중 `http.client_ip` 보유 93,230건, `http.request.header.x_vercel_oidc_token` 보유 93,230건.
- ECOS 호출 스팬 120건(2026-08-30 ~ 09-16) 전부 `url.full` 경로에 **ECOS 인증키 원문**: `KeyStatisticList/<값>/json` 60건·`StatisticSearch/<값>/json` 60건이 `[Filtered]` 도 리터럴 `*` 도 아님(리터럴 `\*` 검색 0건으로 확인). Sentry 가 저장한 `span.description` 은 그 자리가 `*` 로 바뀌어 있다(SDK 는 경로를 그대로 보낸다 — 로컬 실측).
- Supabase 조회 스팬 중 `url.full` 에 `user_id=eq.` 가 든 것 8,100건(로그인 사용자 UUID). 백엔드 필터 컬럼 실측: `user_id` 38곳·`id` 16·`order_id` 12·`session_id` 3·`endpoint`(푸시 구독 URL) 1 등.
- 보존: 오류 이벤트 가장 오래된 것 2026-08-30T08:25Z(≈29일), 성능 이벤트 2026-08-24T04:28Z(≈35일) — 과거분은 자동 만료된다.

### 1-3. 확인했고 이번 범위가 아닌 것
- 브라우저 SDK(CDN 10.75.3 — 배포 SRI 와 같은 바이트): `sendDefaultPii:false` → `sdk.settings.infer_ip = "never"`, 본문·쿠키 미수집 → 변경 없음.
- 로그인 세션은 localStorage(`frontend/index.html:194`) — 우리 도메인 쿠키는 카카오 OAuth state 쿠키(`backend/routes/kakao.js:117`, HttpOnly·`Path=/api/kakao`) 하나뿐.
- 개인정보처리방침(`frontend/privacy.html:97,107`)은 Sentry 로 "오류 발생 시 마스킹된 요청 정보"만 간다고 적었다 — 성능 표본도 간다 → §7 운영자 결정.
- Sentry 11.0.0 은 성능 데이터를 `span` 항목으로 보내 `beforeSendTransaction` 을 거치지 않는다 → §6.
- 비용: 스팬 200개짜리 이벤트에서 스크럽 4.2~4.5ms(비밀값 30개 가정). 운영 평균은 트랜잭션당 Supabase 스팬 ≈13개(2,126,090 ÷ 165,650)라 1ms 미만, 표본 10% 에만 적용.

## 2. 변경 — `backend/sentry.js` (실행자)
관례: 이 파일은 한국어 주석·`TAG-YYYY-MM-DD (Plan NNN)` 주석 태그·CommonJS. 줄 끝(CRLF)을 유지한다(Edit 도구 사용, 파일 통째 재작성 금지).

### 2-1. 삽입
`IGNORED_ERROR_PATTERNS` 배열을 닫는 `];` 와 그 다음 빈 줄 **뒤**, `const dsn = process.env.SENTRY_DSN;` **바로 앞**에 아래 블록과 빈 줄 하나를 넣는다.
```js
// ── PII-SCRUB-2026-09-28 (Plan 128): 오류·성능 이벤트 공통 스크러빙 ─────────────
//   [왜] 같은 SDK(10.75.3)·같은 옵션으로 실측(plans/128 §1): sendDefaultPii:false 여도
//     ① 오류 이벤트에 요청 본문(request.data)·쿠키(request.cookies)·위치 헤더(x-vercel-ip-*)·
//        x-vercel-oidc-token 원문이 실린다.
//     ② 성능 이벤트(transaction, tracesSampleRate 표본)에는 beforeSend 가 **적용되지 않아**
//        Authorization·Cookie 헤더 원문과 클라이언트 IP(http.client_ip)까지 실린다.
//     ③ ECOS 는 인증키를 URL **경로**에 넣는다(services/ecosService.js) — SDK 의 쿼리 필터를
//        통과해 운영 스팬 url.full 에 원문이 남았다(값은 보지 않고 패턴 건수로 확인).
//     ④ Supabase 조회 스팬 URL 에 로그인 사용자 ID(user_id=eq.<UUID>)가 그대로 실린다.
//   [어떻게] 두 이벤트가 같은 scrubEvent 를 지난다: 본문·쿠키 삭제 → 헤더는 허용목록만 →
//     클라이언트 주소 속성 삭제 → 모든 문자열에서 환경변수 비밀값(원문·URL 인코딩형)·
//     PostgREST 필터 값·UUID 를 치환.
//   ⚠ @sentry/node 11 은 성능 데이터를 transaction 이 아닌 span 항목으로 보내 beforeSendTransaction 을
//     거치지 않는다(2026-09-28 11.0.0 실측). 메이저를 올리면 test/sentry-scrub.test.js 의 E2E 가 실패한다 —
//     span 항목 스크러빙을 먼저 넣을 것(plans/128 §6).
const HEADER_ALLOWLIST = new Set([
  'host', 'user-agent', 'content-type', 'content-length', 'accept', 'accept-language',
  'accept-encoding', 'origin', 'x-vercel-id', 'x-matched-path',
]);
// 값은 버리고 "있었다"는 사실만 남긴다 — 인증 오류 디버깅에 필요한 최소 정보.
const HEADER_PRESENCE_ONLY = new Set(['authorization', 'cookie']);
const CLIENT_ADDRESS_KEYS = ['http.client_ip', 'client.address', 'net.peer.ip', 'network.peer.address', 'net.sock.peer.addr'];
const HEADER_ATTR_PREFIX = 'http.request.header.';
const SECRET_ENV_NAME_RE = /KEY|SECRET|TOKEN|PASSWORD|service_role/i;
const MIN_SECRET_LENGTH = 16; // 짧은 값은 평범한 문자열과 겹쳐 오탐 치환이 생긴다
const FILTERED = '[Filtered]';
// PostgREST 필터 `<컬럼>=[not.]<연산자>.<값>` 의 값만 가린다 — 컬럼·연산자는 남아 어떤 조회였는지는 보인다.
//   select=… · order=…desc · limit=… 처럼 연산자 형식이 아닌 파라미터는 건드리지 않는다.
const POSTGREST_FILTER_RE = /((?:^|[?&])[^=&?#\s]+=(?:not\.)?(?:eq|neq|gt|gte|lt|lte|like|ilike|match|imatch|in|is|isdistinct|cs|cd|ov|sl|sr|nxl|nxr|adj|fts|plfts|phfts|wfts)\.)[^&#\s]*/g;
// 사용자·세션·주문 ID 는 UUID 다. Sentry 자체 ID(trace·span·event)는 하이픈 없는 16진수라 겹치지 않는다.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function collectSecretValues(env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env || {})) {
    if (!SECRET_ENV_NAME_RE.test(name) || typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    values.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) values.add(encoded);
  }
  // 긴 값부터 치환해야 한 비밀값이 다른 비밀값의 일부일 때도 온전히 가려진다.
  return [...values].sort((a, b) => b.length - a.length);
}

// dotenv 는 이 파일보다 늦게 로드된다(server.js) — 첫 이벤트 시점에 한 번만 모은다.
let secretValuesCache = null;
function secretValues() {
  if (!secretValuesCache) secretValuesCache = collectSecretValues(process.env);
  return secretValuesCache;
}

function redactString(value, secrets) {
  let next = value;
  for (const secret of secrets) {
    if (next.includes(secret)) next = next.split(secret).join(FILTERED);
  }
  return next.replace(POSTGREST_FILTER_RE, `$1${FILTERED}`).replace(UUID_RE, FILTERED);
}

// 이벤트 본문은 JSON 모양(일반 객체·배열)이다. SDK 내부 객체(Scope·Client 등 클래스 인스턴스)는
// 건드리지 않는다 — 특히 sdkProcessingMetadata 는 전송 전에 SDK 가 지우는 내부용이고 Scope 를 품는다.
function isPlainContainer(value) {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactStrings(node, secrets, seen = new WeakSet(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 20 || seen.has(node) || !isPlainContainer(node)) return;
  seen.add(node);
  for (const key of Object.keys(node)) {
    if (depth === 0 && key === 'sdkProcessingMetadata') continue;
    const value = node[key];
    if (typeof value === 'string') {
      const next = redactString(value, secrets);
      if (next !== value) node[key] = next;
    } else if (value && typeof value === 'object') {
      redactStrings(value, secrets, seen, depth + 1);
    }
  }
}

function scrubHeaders(headers) {
  if (!headers || typeof headers !== 'object') return;
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (HEADER_PRESENCE_ONLY.has(lower)) headers[name] = FILTERED;
    else if (!HEADER_ALLOWLIST.has(lower)) delete headers[name];
  }
}

// 스팬 속성: 클라이언트 주소 삭제, http.request.header.<이름> 은 요청 헤더와 같은 규칙.
function scrubSpanData(data) {
  if (!data || typeof data !== 'object') return;
  for (const key of Object.keys(data)) {
    if (CLIENT_ADDRESS_KEYS.includes(key)) { delete data[key]; continue; }
    if (!key.startsWith(HEADER_ATTR_PREFIX)) continue;
    const header = key.slice(HEADER_ATTR_PREFIX.length).replace(/_/g, '-');
    if (HEADER_PRESENCE_ONLY.has(header)) data[key] = FILTERED;
    else if (!HEADER_ALLOWLIST.has(header)) delete data[key];
  }
}

function scrubEvent(event, secrets = secretValues()) {
  if (!event || typeof event !== 'object') return event;
  // IP 제거 (pino 와 동일 정책)
  if (event.user) delete event.user.ip_address;
  const req = event.request;
  if (req && typeof req === 'object') {
    delete req.cookies;
    delete req.data;
    scrubHeaders(req.headers);
    // 쿼리스트링에 serviceKey 가 포함될 수 있음 (MOLIT/Kakao axios 호출 실패 시)
    if (typeof req.query_string === 'string') {
      req.query_string = req.query_string.replace(/(serviceKey|apiKey|token)=[^&]+/gi, '$1=[Filtered]');
    }
  }
  scrubSpanData(event.contexts && event.contexts.trace && event.contexts.trace.data);
  if (Array.isArray(event.spans)) {
    for (const span of event.spans) scrubSpanData(span && span.data);
  }
  // message/exception 안의 serviceKey= 패턴 마스킹
  const scrub = (s) => typeof s === 'string'
    ? s.replace(/(serviceKey|apiKey|token|KakaoAK\s+)[=:\s]*[A-Za-z0-9%+/_\-=]{10,}/gi, '$1=[Filtered]')
    : s;
  if (event.message) event.message = scrub(event.message);
  if (event.exception?.values) {
    for (const v of event.exception.values) {
      if (v.value) v.value = scrub(v.value);
    }
  }
  redactStrings(event, secrets);
  return event;
}
```

### 2-2. 교체
`Sentry.init({...})` 안에서 `    // ── beforeSend: 최종 스크러빙 ─────────────────────────────` 줄부터 `beforeSend(event, hint) { ... }` 를 닫는 `    },` 줄까지(현재 `:77-104`, 28줄)를 아래로 바꾼다.
```js
    // ── 최종 스크러빙 — 오류(beforeSend)·성능(beforeSendTransaction) 모두 같은 함수 ──
    //   PII-SCRUB-2026-09-28 (Plan 128): 성능 이벤트는 beforeSend 를 거치지 않는다.
    beforeSend(event) {
      return scrubEvent(event);
    },
    beforeSendTransaction(event) {
      return scrubEvent(event);
    },
```

### 2-3. 추가
파일 끝 `module.exports.IGNORED_ERROR_PATTERNS = IGNORED_ERROR_PATTERNS;` 줄 **다음**에 추가.
```js
// TEST-EXPORT-2026-09-28 (Plan 128): 스크러빙 규칙을 계약 테스트가 실제 함수로 검사한다.
module.exports._scrubEvent = scrubEvent;
module.exports._collectSecretValues = collectSecretValues;
```

### 2-4. 그 밖의 줄은 바꾸지 않는다
`beforeBreadcrumb`·`tracesSampleRate`·`profilesSampleRate`·`enableLogs`·`sendDefaultPii`·`ignoreErrors`·`release`·`environment` 그대로.

## 3. 테스트

### 3-1. 신규 `backend/test/sentry-scrub.test.js` — 아래 전문 그대로 (7개 테스트)
```js
/**
 * backend/test/sentry-scrub.test.js
 *
 * Plan 128 (2026-09-28) — Sentry 로 나가는 이벤트의 개인정보·비밀값 스크러빙.
 *
 * 실측으로 확인된 누출(같은 SDK 10.75.3·같은 옵션, plans/128 §1):
 *   - 오류 이벤트: 요청 본문(request.data)·쿠키(request.cookies)·위치 헤더(x-vercel-ip-*)·
 *     x-vercel-oidc-token 원문.
 *   - 성능 이벤트(transaction): beforeSend 를 거치지 않아 Authorization·Cookie 헤더 원문,
 *     클라이언트 IP(http.client_ip) 까지.
 *   - ECOS 인증키는 URL 경로에 들어가 SDK 의 쿼리 필터를 통과한다.
 *   - Supabase 조회 스팬 URL 에 로그인 사용자 ID(user_id=eq.<UUID>)가 실린다.
 *
 * E2E 앞의 테스트들은 scrubEvent 를 이벤트 모양으로 직접 검사하고, 마지막 E2E 는 **실제 SDK** 를
 * 자식 프로세스로 띄워 가짜 수집 서버가 받은 envelope 전문에서 표지 문자열을 찾는다 —
 * SDK 가 올라가(예: 11) 이벤트 모양이 바뀌면 여기서 잡히게 하려는 것이다.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SENTRY_JS = path.join(__dirname, '..', 'sentry.js');
const { _scrubEvent: scrubEvent, _collectSecretValues: collectSecretValues } = require(SENTRY_JS);

test('오류 이벤트 — 본문·쿠키 삭제, 헤더는 허용목록만(인증·쿠키는 존재만), 쿼리 비밀값 마스킹', () => {
  const event = {
    user: { ip_address: '203.0.113.9' },
    request: {
      url: 'https://myhomelog.vercel.app/api/x?serviceKey=abcdefghij&x=1',
      query_string: 'serviceKey=abcdefghij&x=1',
      cookies: { 'sb-session': 'COOKIEVALUE' },
      data: '{"name":"홍길동","phone":"010-1234-5678"}',
      headers: {
        host: 'myhomelog.vercel.app',
        'user-agent': 'UA',
        'content-type': 'application/json',
        authorization: 'Bearer TOKENVALUE',
        cookie: 'sb-session=COOKIEVALUE',
        'x-vercel-oidc-token': 'OIDCVALUE',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.9',
        'x-vercel-forwarded-for': '203.0.113.9',
        'x-vercel-ip-city': 'Seoul',
        'x-vercel-ip-latitude': '37.5',
        referer: 'https://myhomelog.vercel.app/?region=x',
        'X-Api-Key': 'APIKEYVALUE',
      },
    },
  };
  scrubEvent(event, []);
  assert.equal(event.user.ip_address, undefined);
  assert.equal(event.request.cookies, undefined, 'request.cookies 가 남아 있다');
  assert.equal(event.request.data, undefined, 'request.data(요청 본문)가 남아 있다');
  assert.deepEqual(Object.keys(event.request.headers).sort(),
    ['authorization', 'content-type', 'cookie', 'host', 'user-agent']);
  assert.equal(event.request.headers.authorization, '[Filtered]');
  assert.equal(event.request.headers.cookie, '[Filtered]');
  assert.equal(event.request.query_string, 'serviceKey=[Filtered]&x=1');
});

test('성능 이벤트 — 클라이언트 주소 속성 삭제, 헤더 속성은 요청 헤더와 같은 규칙, 경로의 비밀값 치환', () => {
  const ECOS_VAL = 'ecos-xxxxxxxxxxxxxxxx';
  const event = {
    type: 'transaction',
    transaction: 'POST /boom',
    request: { headers: { authorization: 'Bearer T', 'user-agent': 'UA', 'x-vercel-ip-city': 'Seoul' }, data: 'BODY' },
    contexts: {
      trace: {
        data: {
          'http.client_ip': '203.0.113.9',
          'client.address': '203.0.113.9',
          'net.peer.ip': '203.0.113.9',
          'http.request.header.authorization': '[Filtered]',
          'http.request.header.x_vercel_oidc_token': '[Filtered]',
          'http.request.header.x_vercel_ip_city': 'Seoul',
          'http.request.header.cookie.sb_session': '[Filtered]',
          'http.request.header.user_agent': 'UA',
          'url.path': '/boom',
        },
      },
    },
    spans: [{
      op: 'http.client',
      description: `GET https://ecos.bok.or.kr/api/KeyStatisticList/${ECOS_VAL}/json/kr/1/100`,
      data: {
        'url.full': `https://ecos.bok.or.kr/api/KeyStatisticList/${ECOS_VAL}/json/kr/1/100`,
        'network.peer.address': '1.2.3.4',
      },
    }],
    breadcrumbs: [{ category: 'http', data: { url: `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_VAL}/json` } }],
  };
  scrubEvent(event, [ECOS_VAL]);
  const data = event.contexts.trace.data;
  for (const k of ['http.client_ip', 'client.address', 'net.peer.ip']) assert.equal(data[k], undefined, `${k} 가 남아 있다`);
  assert.equal(data['http.request.header.authorization'], '[Filtered]');
  assert.equal(data['http.request.header.user_agent'], 'UA');
  for (const k of ['http.request.header.x_vercel_oidc_token', 'http.request.header.x_vercel_ip_city', 'http.request.header.cookie.sb_session']) {
    assert.equal(data[k], undefined, `${k} 가 남아 있다`);
  }
  assert.equal(data['url.path'], '/boom');
  assert.equal(event.request.data, undefined);
  assert.deepEqual(Object.keys(event.request.headers).sort(), ['authorization', 'user-agent']);
  assert.equal(event.spans[0].data['network.peer.address'], undefined);
  const text = JSON.stringify(event);
  assert.ok(!text.includes(ECOS_VAL), '경로에 든 비밀값이 남아 있다');
  assert.ok(text.includes('KeyStatisticList/[Filtered]/json'), '비밀값 자리가 [Filtered] 로 바뀌지 않았다');
});

test('사용자 식별값 — PostgREST 필터 값과 UUID 를 가리고, 필터가 아닌 파라미터는 남긴다', () => {
  const UID = '0b7e2c1a-1111-4222-8333-944455556666';
  const event = {
    type: 'transaction',
    request: { url: `https://myhomelog.vercel.app/api/chat-sessions/${UID}/messages` },
    spans: [{
      op: 'http.client',
      description: `GET https://x.supabase.co/rest/v1/bookmarks?select=*&user_id=eq.${UID}&order=created_at.desc`,
      data: {
        'url.full': `https://x.supabase.co/rest/v1/bookmarks?select=*&user_id=eq.${UID}&facility-%3E_empty=not.is.null&order=created_at.desc&limit=20`,
        'http.query': `select=id&endpoint=eq.https%3A%2F%2Ffcm.googleapis.com%2Ffcm%2Fsend%2Fabc`,
        'url.query': `?lawd_cd=eq.11350&apt_name=in.(a,b)`,
      },
    }],
  };
  scrubEvent(event, []);
  const text = JSON.stringify(event);
  assert.ok(!text.includes(UID), 'UUID 가 남아 있다');
  assert.ok(!text.includes('fcm.googleapis.com'), '푸시 구독 endpoint 필터 값이 남아 있다');
  const d = event.spans[0].data;
  assert.equal(d['url.full'],
    'https://x.supabase.co/rest/v1/bookmarks?select=*&user_id=eq.[Filtered]&facility-%3E_empty=not.is.[Filtered]&order=created_at.desc&limit=20');
  assert.equal(d['http.query'], 'select=id&endpoint=eq.[Filtered]');
  assert.equal(d['url.query'], '?lawd_cd=eq.[Filtered]&apt_name=in.[Filtered]');
  assert.equal(event.request.url, 'https://myhomelog.vercel.app/api/chat-sessions/[Filtered]/messages');
});

test('SDK 내부 객체(sdkProcessingMetadata·클래스 인스턴스)는 순회·수정하지 않는다', () => {
  const UID = '0b7e2c1a-1111-4222-8333-944455556666';
  class FakeScope { constructor() { this.note = `scope ${UID}`; } }
  const scope = new FakeScope();
  const meta = { normalizedRequest: { url: `https://x/api/${UID}` }, capturedSpanScope: scope };
  const event = { sdkProcessingMetadata: meta, extra: { scope, plain: `id ${UID}` } };
  scrubEvent(event, []);
  assert.equal(scope.note, `scope ${UID}`, '클래스 인스턴스 내부 문자열이 바뀌었다');
  assert.equal(meta.normalizedRequest.url, `https://x/api/${UID}`, 'sdkProcessingMetadata 가 순회됐다');
  assert.equal(event.extra.plain, 'id [Filtered]', '일반 객체 문자열은 치환돼야 한다');
});

test('collectSecretValues — 이름 규칙·최소 길이·URL 인코딩형·긴 값 우선', () => {
  const values = collectSecretValues({
    MOLIT_API_KEY: 'xxxx/xxxx+xxxx=xxxx0000',
    ECOS_API_KEY: 'ecos-xxxxxxxxxxxxxxxx',
    service_role: 'role-xxxxxxxxxxxxxxxx',
    UPSTASH_REDIS_REST_TOKEN: 'short',
    CACHE_MAX_KEYS: '2000',
    SUPABASE_URL: 'https://example.supabase.co/0123456789',
    NODE_ENV: 'production-environment-name',
  });
  assert.ok(values.includes('xxxx/xxxx+xxxx=xxxx0000'));
  assert.ok(values.includes(encodeURIComponent('xxxx/xxxx+xxxx=xxxx0000')), 'URL 인코딩형이 없다');
  assert.ok(values.includes('ecos-xxxxxxxxxxxxxxxx'));
  assert.ok(values.includes('role-xxxxxxxxxxxxxxxx'), '소문자 service_role 이 빠졌다');
  assert.ok(!values.includes('short'), '최소 길이 미만이 포함됐다');
  assert.ok(!values.includes('2000'));
  assert.ok(!values.some((v) => v.includes('example.supabase.co')), '비밀이 아닌 이름(SUPABASE_URL)이 포함됐다');
  assert.ok(!values.includes('production-environment-name'));
  for (let i = 1; i < values.length; i++) assert.ok(values[i - 1].length >= values[i].length, '긴 값부터 정렬돼야 한다');
});

test('기존 규칙 유지 — message·exception 안의 serviceKey= 패턴 마스킹', () => {
  const event = {
    message: 'failed serviceKey=xxxxxxxxxxxxxxxx more',
    exception: { values: [{ value: 'axios serviceKey=xxxxxxxxxxxxxxxx' }] },
  };
  scrubEvent(event, []);
  assert.ok(!event.message.includes('xxxxxxxxxxxxxxxx'));
  assert.ok(!event.exception.values[0].value.includes('xxxxxxxxxxxxxxxx'));
});

// ── 실제 SDK 경유 E2E ────────────────────────────────────────────────────────
// 자식 프로세스가 backend/sentry.js 를 **먼저** require 하고(자동 계측 순서), 최소 express 앱에서
// 외부 호출(경로에 ECOS 키, 쿼리에 MOLIT 키) 뒤 예외를 던진다. SENTRY_DSN 은 이 테스트의 가짜 수집
// 서버를 가리키고 표본율 1 이라 오류·성능 이벤트가 모두 온다. 요청은 계측되지 않는 raw 소켓으로
// 보낸다(계측된 클라이언트는 비표본 sentry-trace 를 전파해 성능 이벤트가 사라질 수 있다).
// sentry.js 경로·표지는 명령행 인자로 넘긴다 — 환경변수로 넘기면 scripts/check-env-example.js 게이트가
// 테스트 전용 이름을 미선언 환경변수로 잡는다(backend/**/*.js 의 process.env 참조를 .env.example 과 대조).
// 표지 값은 일부러 `…-xxxx` 형식이다 — CI gitleaks 의 generic-api-key 는 이름에 key·token·secret 이 든
// 할당의 값 엔트로피로 잡는데(이 저장소 2회 재발), `.gitleaks.toml` 전역 allowlist 의 `xxx+` 가 이 형식을 통과시킨다.
// 읽기 좋은 값으로 바꾸지 말 것. 서로의 부분 문자열이 되지 않게 접두어를 다르게 둔다.
const M = {
  queryToken: 'qtoken-xxxxxxxxxxxx',
  cookie: 'cookie-xxxxxxxxxxxx',
  bearer: 'bearer-xxxxxxxxxxxx',
  oidc: 'oidc-xxxxxxxxxxxx',
  ip: '203.0.113.77',
  city: 'city-xxxxxxxxxxxx',
  lat: '37.123456',
  name: 'name-xxxxxxxxxxxx',
  phone: '010-9999-8888',
  ecos: 'ecos-e2e-xxxxxxxxxxxxxxxx',
  molit: 'molit/xxxx+xxxx==xxxxxxxx',
  userId: '0b7e2c1a-1111-4222-8333-944455556666',
};

const CHILD = `
const [sentryJsPath, markersJson] = process.argv.slice(1);
const Sentry = require(sentryJsPath);
const express = require('express');
const axios = require('axios');
const net = require('net');
const app = express();
app.use(express.json());
app.get('/api/:svc/:key/json', (req, res) => res.json({ ok: true }));
app.get('/rest/v1/:table', (req, res) => res.json([]));
const M = JSON.parse(markersJson);
app.post('/boom', async (req, res) => {
  const port = req.socket.localPort;
  await axios.get('http://127.0.0.1:' + port + '/api/KeyStatisticList/' + process.env.ECOS_API_KEY + '/json',
    { params: { serviceKey: process.env.MOLIT_API_KEY, LAWD_CD: '11350' } });
  await axios.get('http://127.0.0.1:' + port + '/rest/v1/bookmarks',
    { params: { select: '*', user_id: 'eq.' + M.userId } });
  throw new Error('scrub-e2e boom');
});
Sentry.setupExpressErrorHandler(app);
app.use((err, req, res, next) => { res.status(500).json({ ok: false }); });
const server = app.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const body = Buffer.from(JSON.stringify({ name: M.name, phone: M.phone }));
  const sock = net.connect(port, '127.0.0.1', () => {
    sock.write([
      'POST /boom?token=' + M.queryToken + '&x=1 HTTP/1.1', 'Host: 127.0.0.1:' + port,
      'Content-Type: application/json', 'Content-Length: ' + body.length,
      'Cookie: sb-e2e=' + M.cookie, 'Authorization: Bearer ' + M.bearer, 'X-Vercel-OIDC-Token: ' + M.oidc,
      'X-Forwarded-For: ' + M.ip, 'X-Real-IP: ' + M.ip, 'X-Vercel-Forwarded-For: ' + M.ip,
      'X-Vercel-IP-City: ' + M.city, 'X-Vercel-IP-Latitude: ' + M.lat,
      'User-Agent: scrub-e2e-agent', 'Connection: close', '', '',
    ].join('\\r\\n'));
    sock.write(body);
  });
  sock.on('data', () => {});
  sock.on('close', async () => {
    await new Promise((r) => setTimeout(r, 300));
    await Sentry.flush(5000);
    server.close();
    process.exit(0);
  });
});
`;

function parseEnvelope(text) {
  const lines = text.split('\n').filter((l) => l.length);
  const items = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    let header = {};
    let payload = null;
    try { header = JSON.parse(lines[i]); } catch (_) { /* 비 JSON 줄은 건너뛴다 */ }
    try { payload = JSON.parse(lines[i + 1]); } catch (_) { payload = lines[i + 1]; }
    items.push({ type: header.type, payload });
  }
  return items;
}

test('실제 SDK 경유 E2E — 오류·성능 envelope 어디에도 본문·쿠키·토큰·IP·위치·비밀값이 없다', { timeout: 60000 }, async () => {
  const received = [];
  const ingest = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
      received.push(buf.toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => ingest.listen(0, '127.0.0.1', resolve));
  const ingestPort = ingest.address().port;

  const env = {
    ...process.env,
    SENTRY_DSN: `http://e2epublickey@127.0.0.1:${ingestPort}/1`,
    SENTRY_TRACES_SAMPLE_RATE: '1',
    VERCEL_ENV: 'test',
    ECOS_API_KEY: M.ecos,
    MOLIT_API_KEY: M.molit,
  };
  delete env.NODE_TEST_CONTEXT;
  let stderr = '';
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD, SENTRY_JS, JSON.stringify(M)], { cwd: path.join(__dirname, '..'), env });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', () => {});
    child.on('close', resolve);
  });
  await new Promise((resolve) => ingest.close(resolve));
  assert.equal(code, 0, `자식 프로세스 실패(exit ${code}): ${stderr.slice(0, 2000)}`);

  const all = received.join('\n');
  const items = received.flatMap(parseEnvelope);
  const event = items.find((i) => i.type === 'event'
    && ((i.payload && i.payload.exception && i.payload.exception.values) || []).some((v) => v.value === 'scrub-e2e boom'));
  const tx = items.find((i) => i.type === 'transaction' && /\/boom/.test((i.payload && i.payload.transaction) || ''));
  assert.ok(event, `오류 이벤트가 수집 서버에 도착하지 않았다 — 받은 항목: ${items.map((i) => i.type).join(',')}`);
  // @sentry/node 11.0.0 은 성능 데이터를 transaction 이 아니라 span 항목으로 보내고, 그 항목은
  // beforeSendTransaction 을 거치지 않는다(2026-09-28 실측 — IP·본문·경로 비밀값이 그대로 나감).
  // 여기서 실패하면 SDK 메이저를 올린 것이다: span 항목 스크러빙을 먼저 넣고 이 단언을 고칠 것(plans/128 §6).
  assert.ok(tx, `POST /boom 성능 이벤트(transaction)가 도착하지 않았다 — 받은 항목: ${items.map((i) => i.type).join(',')}. ` +
    'span 항목만 왔다면 SDK 메이저 변경으로 성능 데이터 형식이 바뀐 것이다(plans/128 §6)');

  for (const [label, marker] of Object.entries(M)) {
    assert.ok(!all.includes(marker), `envelope 에 ${label} 표지가 남아 있다`);
  }
  assert.ok(!all.includes(encodeURIComponent(M.molit)), 'envelope 에 MOLIT 키 URL 인코딩형이 남아 있다');
  // 과잉 삭제·공허한 통과 방지: 허용 헤더는 남고, 인증 헤더는 존재만, 경로 비밀값 자리는 [Filtered].
  assert.ok(all.includes('scrub-e2e-agent'), 'user-agent 까지 지워졌다(허용목록 헤더는 남아야 한다)');
  assert.equal(event.payload.request.headers.authorization, '[Filtered]');
  assert.equal(tx.payload.request && tx.payload.request.headers && tx.payload.request.headers.authorization, '[Filtered]');
  assert.ok(all.includes('KeyStatisticList/[Filtered]/json'), 'ECOS 경로 호출 기록이 없거나 비밀값 자리가 치환되지 않았다');
  assert.ok(all.includes('user_id=eq.[Filtered]'), 'Supabase 조회 기록이 없거나 사용자 ID 자리가 치환되지 않았다');
});
```

### 3-2. `backend/test/components-guard.test.js:74` 한 줄
- 전: `    assert.match(sentryJs, /dataCollection/,`
- 후: `    assert.match(sentryJs, /\bdataCollection\s*:/,`
- 이유: 지금 가드는 파일 **아무 곳**의 단어만 찾는다 — 주석에 그 단어가 들어가면 11 로 올렸을 때 가드가 무력화된다. 옵션 키(`dataCollection:`)가 있어야 통과하게 좁힌다. 이 줄 외 이 파일 변경 금지.

## 4. 하지 말 것 / STOP
- `tracesSampleRate`·`sendDefaultPii`·`ignoreErrors`·`beforeBreadcrumb` 변경 금지. `@sentry/node` 버전 변경 금지. `frontend/*` 변경 금지. `httpIntegration`·`maxIncomingRequestBodySize` 옵션 추가 금지(본문은 이벤트에서 지운다 — SDK 버전 무관).
- `backend/sentry.js` 에 `dataCollection` 이라는 단어를 쓰지 말 것(주석 포함) — Sentry 11 전환 계획의 몫.
- 테스트 표지 문자열을 바꾸지 말 것 — 일부러 `…-xxxx` 형식이다(CI gitleaks `generic-api-key` 는 이름에 key·token·secret 이 든 할당의 값 엔트로피로 잡는다 — 이 저장소 2회 재발. `.gitleaks.toml` 전역 allowlist 의 `xxx+` 가 통과시킨다).
- 테스트에서 테스트 전용 값을 `process.env.<대문자 이름>` 으로 읽지 말 것 — `check-env-example` 게이트가 미선언 환경변수로 잡는다(개정 1 의 원인). E2E 는 명령행 인자로 넘긴다. `backend/.env.example` 에 테스트용 이름을 추가하거나 게이트를 완화하지 말 것.
- 테스트가 실패하면 고치려 들지 말고 실패 출력(특히 E2E 의 자식 stderr)을 그대로 보고하고 STOP.

## 5. 완료 기준
1. LF 정규화 sha256 이 아래와 같다(다르면 `git diff` 로 차이를 찾아 이 문서의 코드와 같게 — 즉흥 수정 금지):
   - `backend/sentry.js` = `b7a382cb2a4dc1187995b7da75d035e50aac36d95b92bb4c2550dd1ce5366a7f`
   - `backend/test/sentry-scrub.test.js` = `92235e37536c2bca1669aae12efdec3b56230202a6d83d775082be7a5dcfbd25`
   - `backend/test/components-guard.test.js` = `39e9875b676ddbd346a240cb3bff0fbaab0e799c3dbc316981e1cc2d486b48a5`
   - 명령(Git Bash, 워크트리 루트): `node -e "const fs=require('fs'),c=require('crypto');for(const p of process.argv.slice(1))console.log(p,c.createHash('sha256').update(fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n')).digest('hex'))" backend/sentry.js backend/test/sentry-scrub.test.js backend/test/components-guard.test.js`
2. `npm run verify` 전부 통과 — backend 테스트 588 → **595**(신규 7).
3. `git diff master --stat` = `backend/sentry.js` · `backend/test/sentry-scrub.test.js` · `backend/test/components-guard.test.js` · `plans/128-sentry-pii-scrub.md`(사본) 뿐.
4. 배포 후 리뷰어 라이브(계획자 수행): `/api/health` deploy id 일치 · Sentry 신규 오류 0 · 배포 시각 이후 성능 이벤트에서 `has:http.client_ip` 0 · `has:http.request.header.x_vercel_oidc_token` 0 · `span.op:http.client url.full:*user_id=eq.* !url.full:*Filtered*` 0 · 같은 구간 `is_transaction:true` 가 0 보다 큼(공허한 통과 아님).

## 6. 유지보수 — Sentry 11 전환 시 필수 (별도 계획)
- `@sentry/node` 11.0.0 은 성능 데이터를 `span` 항목으로 보낸다 → `beforeSendTransaction` 미적용. 같은 실측에서 IP·위치·본문·ECOS 키·사용자 ID 가 span 속성(`client.address`·`user.ip_address`·`http.request.body.data`·`http.request.header.<하이픈 이름>`·`url.full`)으로 나갔다.
- 전환 계획은 ⓐ 제한 `dataCollection`(공식 MIGRATION.md 예시) ⓑ `beforeSendSpan` 에서 같은 규칙(속성 값이 `{ value, type }` 형태일 수 있음 — 실측 후 결정) ⓒ 이 E2E 를 span 항목 기준으로 고친 뒤 표지 0 확인 — 을 **같이** 해야 한다. E2E 의 transaction 단언이 11 로 올리는 순간 실패해 이 순서를 강제한다.
- 새 외부 API 키 환경변수는 이름에 `KEY`/`SECRET`/`TOKEN`/`PASSWORD`(또는 `service_role`)가 있고 16자 이상이어야 자동 치환된다. 헤더 허용목록(`HEADER_ALLOWLIST`)에 추가할 때는 개인정보·자격증명이 아닌지 먼저 확인.

## 7. 운영자 결정 (이 계획 밖)
1. **개인정보처리방침 문구** — `frontend/privacy.html:97,107` 의 "오류 발생 시 마스킹된 요청 정보" 는 성능 표본(요청의 10%: 경로·소요 시간·브라우저 정보)도 간다는 사실과 다르다. 법적 고지라 문구는 운영자 결정.
2. **Sentry 프로젝트 보안 설정(무료)** — Settings → Security & Privacy 에서 "Prevent Storing of IP Addresses" 켜기, "Data Scrubber"·"Use Default Scrubbers" 켜짐 확인. 로그인이 필요해 운영자만 할 수 있다(이중 안전장치 — 이 계획만으로도 IP 는 더 나가지 않는다).
3. **ECOS 인증키 재발급(선택)** — 노출 범위는 운영자 Sentry 조직뿐이고 저장분은 2026-10-21 전후 자동 만료. 재발급하면 Vercel env `ECOS_API_KEY` 교체.
4. **과거 이벤트** — 자동 만료(오류 ≈29일, 성능 ≈35일). 즉시 삭제를 원하면 Sentry 화면에서 운영자가.
