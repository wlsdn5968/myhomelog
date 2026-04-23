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

    // 트레이싱 (성능 모니터링) — 비용 때문에 10% 만
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),

    // 프로파일링은 Vercel serverless 에선 부적합 — 끔
    profilesSampleRate: 0,

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

    // 무시할 에러 (노이즈 감축)
    ignoreErrors: [
      // 사용자 네트워크 이슈 — 서버 책임 아님
      'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
      // Axios 취소 (AbortController)
      'canceled',
    ],
  });
}

module.exports = Sentry;
module.exports.isEnabled = !!dsn;
