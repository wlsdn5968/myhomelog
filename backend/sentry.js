/**
 * Sentry 초기화 (백엔드)
 *
 * ⚠️ 이 파일은 어떤 Express 관련 import 보다도 먼저 로드되어야 함.
 *    @sentry/node v8 은 자동 instrumentation 이라 require 시점 순서가 중요.
 *    → api/index.js 와 backend/server.js 최상단에서 require('./sentry') 먼저.
 *
 * 환경변수:
 *   SENTRY_DSN             — 필수. 미설정 시 Sentry no-op
 *   SENTRY_TRACES_SAMPLE_RATE  — 기본 0.1 (10% 트레이싱)
 *   VERCEL_ENV             — Vercel 이 자동 주입 (production/preview/development)
 *   VERCEL_GIT_COMMIT_SHA  — release 버전 tag 용
 */
const Sentry = require('@sentry/node');

// IGNORE-CONTRACT-2026-09-02 (감사 P0-4): Sentry 가 **무엇을 안 보고할지**는 조용히 넓어지기 쉬운 설정이다.
//   너무 넓은 패턴 하나가 진짜 장애를 통째로 삼킬 수 있어, 배열을 상수로 뽑아 계약 테스트로 고정한다.
const IGNORED_ERROR_PATTERNS = [
  // 사용자 네트워크 이슈 — 서버 책임 아님
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  // Axios 취소 (AbortController)
  'canceled',
  // AI-EXPECTED-2026-09-02 (감사 P0-4): Anthropic 크레딧 잔액 부족.
  //   [왜 노이즈인가] 운영 방침상 크레딧은 의도적으로 채우지 않는다. 그 상태에서 보고서는
  //   buildDataOnlyReport 로 **정상 열화**하고 사용자는 데이터판 보고서를 받는다(aiUnavailable 표기).
  //   즉 코드 결함이 아니라 **설계된 정상 경로**인데, Sentry 의 Anthropic 자동 계측이
  //   우리 try/catch 보다 먼저 잡아 error 로 올렸다 — 실측 태그: `mechanism: auto.ai.anthropic`,
  //   `handled: no`, culprit `POST /api/report/generate` (NODE-7, 36건).
  //   그 결과 운영자의 위험 신호("Sentry 신규 오류 0건")가 상시 오염돼 **진짜 오류가 묻힌다**.
  //   [왜 이 문자열인가] Anthropic API 응답 본문의 고유 문구다. 같은 SDK 의 다른 실패
  //   (타임아웃·5xx·invalid_request 등)는 이 문구를 포함하지 않아 그대로 보고된다 — 좁게 잡았다.
  //   [가시성] 버리기만 하면 안 되므로 report.js 열화 지점에서 observeDegrade(`report-ai-*`) 로
  //   카운터를 남긴다 → /api/health 의 searchDegrade 에서 확인 가능(Redis 21일).
  'credit balance',
];

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

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Vercel env 가 있으면 그걸 environment 로, 없으면 NODE_ENV
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    // 커밋 SHA 로 release 태그 — Sentry 이슈가 어느 배포에서 났는지 추적
    release: process.env.VERCEL_GIT_COMMIT_SHA
      ? `myhomelog@${process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)}`
      : undefined,

    // ── console breadcrumb 제외 — stdout 로그는 pino 로만 감(Sentry 중복 X) ──
    // SENTRY-V10-2026-08-09: v8 의 함수형 integrations((defaults)=>filter)는 v9 에서 제거됨
    // (공식 v8→v9 마이그레이션 가이드). 목적이 Console breadcrumb 배제뿐이므로 버전 무관
    // 안정 API 인 beforeBreadcrumb 로 동일 효과 — 기본 통합(http/express/requestData 등)은
    // auto 로드 그대로 유지.
    beforeBreadcrumb(breadcrumb) {
      return breadcrumb && breadcrumb.category === 'console' ? null : breadcrumb;
    },

    // 트레이싱 (성능 모니터링) — 비용 때문에 10% 만
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),

    // 프로파일링은 Vercel serverless 에선 부적합 — 끔
    profilesSampleRate: 0,

    // ── Logs 명시적 차단 (SENTRY-LOGS-2026-08-28) ──────────────
    // @sentry/node 10.71.0 부터 `enableLogs` 기본값이 **true 로 바뀌었다**(실측: init 후
    // getOptions().enableLogs === true). 지금은 전송되는 게 없다 — Sentry.logger.* 사용 0건이고
    // Pino/ConsoleLogging 같은 log-forwarding 통합도 자동 로드 목록에 없다(실측: 통합 17개 중 미포함).
    // 그래도 명시적으로 끈다:
    //   ① 이 서비스의 설계는 "stdout 로그는 pino 로만, Sentry 는 에러만"이다(위 beforeBreadcrumb 주석).
    //   ② 기본값이 버전업으로 바뀌었다는 것은 앞으로도 바뀔 수 있다는 뜻이다.
    //   ③ 로그가 무료 플랜 쿼터를 잠식하면 정작 필요한 에러가 누락된다.
    enableLogs: false,

    // PII 자동 수집 끔 (개인정보 최소화 원칙)
    sendDefaultPii: false,

    // ── 최종 스크러빙 — 오류(beforeSend)·성능(beforeSendTransaction) 모두 같은 함수 ──
    //   PII-SCRUB-2026-09-28 (Plan 128): 성능 이벤트는 beforeSend 를 거치지 않는다.
    beforeSend(event) {
      return scrubEvent(event);
    },
    beforeSendTransaction(event) {
      return scrubEvent(event);
    },

    // 무시할 에러 (노이즈 감축) — 목록은 파일 상단 IGNORED_ERROR_PATTERNS 에 있다(계약 테스트 대상).
    ignoreErrors: IGNORED_ERROR_PATTERNS,
  });
}

module.exports = Sentry;
module.exports.isEnabled = !!dsn;
// TEST-EXPORT-2026-09-02: 무시 목록이 과도하게 넓어지는지 계약 테스트가 실제 배열로 검사한다.
module.exports.IGNORED_ERROR_PATTERNS = IGNORED_ERROR_PATTERNS;
// TEST-EXPORT-2026-09-28 (Plan 128): 스크러빙 규칙을 계약 테스트가 실제 함수로 검사한다.
module.exports._scrubEvent = scrubEvent;
module.exports._collectSecretValues = collectSecretValues;
