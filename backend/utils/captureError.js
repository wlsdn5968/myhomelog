/**
 * 라우트 5xx Sentry 캡처 헬퍼 — SENTRY-GAP-2026-07-17 (Sprint XXXXX)
 *
 * 배경(improve 감사 DEBT-05): 라우트 절반이 catch 에서 logger + res.status(5xx) 로 자체 응답해
 * 전역 에러 핸들러(next(e) 경로의 Sentry.setupExpressErrorHandler)를 우회 — 검색·보고서 등
 * 고트래픽 5xx 가 Sentry 에 안 잡히는 모니터링 사각지대였음(pino 는 Sentry transport 없음).
 *
 * 설계 원칙 (응답 shape 는 어떤 경우에도 건드리지 않는다 — 순수 additive):
 * - 알려진 일시 오류는 fingerprint 로 라우트별 1개 이슈로 그룹핑 (Sentry 오염 방지, 가시성은 유지):
 *   · DB statement timeout (pg 57014 — 2글자 검색 콜드 미스 등 기지 사항)
 *   · 외부 API(MOLIT/KAPT/Kakao 등) 타임아웃·5xx — CLAUDE.md 위험신호 "응답률<80%" 감시에 유용
 * - 클라이언트 네트워크성(ECONNRESET/EPIPE/ETIMEDOUT/canceled)은 sentry.js ignoreErrors 가 전송단에서 차단.
 * - GlobalAiBudgetExceededError(킬스위치)는 호출부에서 이 헬퍼를 쓰지 않는다 — 예상된 예산 이벤트이며
 *   aiService.checkGlobalAiBudget 가 이미 logger.warn 으로 기록.
 * - Sentry 미설정(SENTRY_DSN 없음)이나 내부 오류 시 조용히 no-op — 사용자 응답에 절대 영향 없음.
 *
 * 사용: captureRouteError(e, 'search/apt')  // catch 블록의 기존 logger 호출 옆에 1줄
 */
const Sentry = require('../sentry');

function captureRouteError(e, route) {
  try {
    if (!Sentry.isEnabled || typeof Sentry.withScope !== 'function') return;
    const msg = String((e && e.message) || e || '');
    Sentry.withScope((scope) => {
      scope.setTag('route', route || 'unknown');
      if (/statement timeout|57014/i.test(msg)) {
        scope.setTag('transient', 'db-timeout');
        scope.setFingerprint(['db-statement-timeout', route || 'unknown']);
      } else if (/timeout of \d+ms|ECONNABORTED|Request failed with status code 5\d\d|socket hang up/i.test(msg)) {
        scope.setTag('transient', 'upstream');
        scope.setFingerprint(['upstream-failure', route || 'unknown']);
      }
      Sentry.captureException(e instanceof Error ? e : new Error(msg));
    });
  } catch (_) { /* 캡처 실패는 무시 — 응답 경로 보호 */ }
}

module.exports = { captureRouteError };
