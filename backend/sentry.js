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

    // ── beforeSend: 최종 스크러빙 ─────────────────────────────
    beforeSend(event, hint) {
      // IP 제거 (pino 와 동일 정책)
      if (event.user) delete event.user.ip_address;
      if (event.request?.headers) {
        // 민감 헤더 제거
        for (const h of ['authorization', 'cookie', 'x-api-key', 'set-cookie']) {
          if (event.request.headers[h]) event.request.headers[h] = '[Filtered]';
        }
      }
      // 쿼리스트링에 serviceKey 가 포함될 수 있음 (MOLIT/Kakao axios 호출 실패 시)
      if (event.request?.query_string && typeof event.request.query_string === 'string') {
        event.request.query_string = event.request.query_string.replace(
          /(serviceKey|apiKey|token)=[^&]+/gi, '$1=[Filtered]'
        );
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
      return event;
    },

    // 무시할 에러 (노이즈 감축) — 목록은 파일 상단 IGNORED_ERROR_PATTERNS 에 있다(계약 테스트 대상).
    ignoreErrors: IGNORED_ERROR_PATTERNS,
  });
}

module.exports = Sentry;
module.exports.isEnabled = !!dsn;
// TEST-EXPORT-2026-09-02: 무시 목록이 과도하게 넓어지는지 계약 테스트가 실제 배열로 검사한다.
module.exports.IGNORED_ERROR_PATTERNS = IGNORED_ERROR_PATTERNS;
